"""Tests for the scheduled-task recurrence calculator and scheduler."""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from webapp.api import marketdata, repositories, strategies
from webapp.api.routers import ingest as ingest_router
from webapp.api.routers import macro as macro_router
from webapp.api.routers.ingest import RefreshRequest
from webapp.api.routers.macro import MacroRefreshRequest
from webapp.api.routers.runs import _runs as runs_manager
from webapp.api.scheduler import TaskScheduler
from webapp.api.scheduler import datetime as scheduler_datetime_mod
from webapp.api.scheduler_spec import Schedule, ScheduledTaskSpec, cadence_label, next_run

import webapp.api.outlook_report as outlook_report_mod
import webapp.api.scheduler as scheduler_mod


def dt(year: int, month: int, day: int, hour: int, minute: int) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


FIXED_NOW = dt(2026, 8, 13, 10, 0)


@pytest.fixture(autouse=True)
def _never_run_real_executor_work(monkeypatch):
    """The executor-backed routers do real network/qlib work; keep it out of tests."""
    monkeypatch.setattr(macro_router._executor, "submit", lambda _fn, *_args: None)
    monkeypatch.setattr(ingest_router._executor, "submit", lambda _fn, *_args: None)


# ---------------------------------------------------------------------------
# Schedule / next_run
# ---------------------------------------------------------------------------
def test_daily_same_day_when_after_time():
    after = dt(2026, 8, 13, 10, 0)
    schedule = Schedule(frequency="daily", time="09:00")
    assert next_run(schedule, after) == dt(2026, 8, 14, 9, 0)


def test_daily_same_day_when_before_time():
    after = dt(2026, 8, 13, 8, 0)
    schedule = Schedule(frequency="daily", time="09:00")
    assert next_run(schedule, after) == dt(2026, 8, 13, 9, 0)


def test_weekdays_skips_weekend():
    # Friday 10:00 -> next weekday is Monday 09:00
    after = dt(2026, 8, 14, 10, 0)
    schedule = Schedule(frequency="weekdays", time="09:00")
    assert next_run(schedule, after) == dt(2026, 8, 17, 9, 0)


def test_weekdays_friday_before_time():
    after = dt(2026, 8, 14, 8, 0)
    schedule = Schedule(frequency="weekdays", time="09:00")
    assert next_run(schedule, after) == dt(2026, 8, 14, 9, 0)


def test_weekdays_saturday_rolls_to_monday():
    after = dt(2026, 8, 15, 12, 0)
    schedule = Schedule(frequency="weekdays", time="09:00")
    assert next_run(schedule, after) == dt(2026, 8, 17, 9, 0)


def test_weekly_same_week_when_before():
    after = dt(2026, 8, 10, 8, 0)  # Monday
    schedule = Schedule(frequency="weekly", time="09:00", day="mon")
    assert next_run(schedule, after) == dt(2026, 8, 10, 9, 0)


def test_weekly_next_week_when_after():
    after = dt(2026, 8, 10, 10, 0)  # Monday
    schedule = Schedule(frequency="weekly", time="09:00", day="mon")
    assert next_run(schedule, after) == dt(2026, 8, 17, 9, 0)


def test_weekly_other_day():
    after = dt(2026, 8, 10, 10, 0)  # Monday
    schedule = Schedule(frequency="weekly", time="09:00", day="wed")
    assert next_run(schedule, after) == dt(2026, 8, 12, 9, 0)


def test_invalid_time_rejected():
    with pytest.raises(ValueError):
        Schedule(frequency="daily", time="25:00")


def test_weekly_requires_day():
    with pytest.raises(ValueError):
        Schedule(frequency="weekly", time="09:00")


def test_non_weekly_rejects_day():
    with pytest.raises(ValueError):
        Schedule(frequency="daily", time="09:00", day="mon")


def test_cadence_label():
    assert cadence_label(Schedule(frequency="daily", time="07:00")) == "Every day at 07:00"
    assert cadence_label(Schedule(frequency="weekdays", time="07:00")) == "Weekdays at 07:00"
    assert cadence_label(Schedule(frequency="weekly", time="07:00", day="fri")) == "Every Friday at 07:00"


# ---------------------------------------------------------------------------
# ScheduledTaskSpec validation
# ---------------------------------------------------------------------------
def test_spec_macro_refresh_valid():
    spec = ScheduledTaskSpec(name="Macro", kind="macro_refresh", schedule=Schedule(frequency="daily", time="07:00"), params={"what": "calendar"})
    assert spec.params["what"] == "calendar"


def test_spec_macro_refresh_invalid_what():
    with pytest.raises(ValueError, match="what"):
        ScheduledTaskSpec(name="Macro", kind="macro_refresh", schedule=Schedule(frequency="daily", time="07:00"), params={"what": "foo"})


def test_spec_data_refresh_valid():
    spec = ScheduledTaskSpec(name="Data", kind="data_refresh", schedule=Schedule(frequency="daily", time="07:00"), params={"universe_size": 100, "mode": "update"})
    assert spec.params["mode"] == "update"


def test_spec_data_refresh_invalid_universe_size():
    with pytest.raises(ValueError, match="universe_size"):
        ScheduledTaskSpec(name="Data", kind="data_refresh", schedule=Schedule(frequency="daily", time="07:00"), params={"universe_size": 0})


def test_spec_data_refresh_invalid_mode():
    with pytest.raises(ValueError, match="mode"):
        ScheduledTaskSpec(name="Data", kind="data_refresh", schedule=Schedule(frequency="daily", time="07:00"), params={"mode": "partial"})


def test_spec_run_strategy_valid():
    spec = ScheduledTaskSpec(name="Run", kind="run_strategy", schedule=Schedule(frequency="daily", time="07:00"), params={"strategy_id": "abc123"})
    assert spec.params["strategy_id"] == "abc123"


def test_spec_run_strategy_missing_strategy_id():
    with pytest.raises(ValueError, match="strategy_id"):
        ScheduledTaskSpec(name="Run", kind="run_strategy", schedule=Schedule(frequency="daily", time="07:00"), params={})


def test_spec_outlook_report_valid():
    spec = ScheduledTaskSpec(name="Outlook", kind="outlook_report", schedule=Schedule(frequency="daily", time="07:00"), params={"scope": "day"})
    assert spec.params["scope"] == "day"


def test_spec_outlook_report_default_scope():
    spec = ScheduledTaskSpec(name="Outlook", kind="outlook_report", schedule=Schedule(frequency="daily", time="07:00"), params={})
    assert spec.params["scope"] == "week"


def test_spec_outlook_report_invalid_scope():
    with pytest.raises(ValueError, match="scope"):
        ScheduledTaskSpec(name="Outlook", kind="outlook_report", schedule=Schedule(frequency="daily", time="07:00"), params={"scope": "year"})


# ---------------------------------------------------------------------------
# Fake database helpers
# ---------------------------------------------------------------------------
class _FakeCursor:
    """Records SQL calls and returns scripted results."""

    def __init__(self, rows: list[dict] | None = None) -> None:
        self.calls: list[tuple[str, tuple[Any, ...] | None]] = []
        self.rows = rows or []
        self.rowcount = 0
        self._last: list[dict] | None = None

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> None:
        self.calls.append((sql.strip(), params))
        if sql.strip().upper().startswith("SELECT"):
            self.rowcount = -1
            self._last = self.rows
        else:
            self.rowcount = 1
            self._last = None

    def fetchall(self) -> list[dict]:
        return self._last or []

    def fetchone(self) -> dict | None:
        rows = self._last or [None]
        return rows[0]


class _FakeTx:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor

    def __enter__(self) -> _FakeCursor:
        return self._cursor

    def __exit__(self, *exc: object) -> None:
        return None


class _FixedDatetime(type(scheduler_datetime_mod)):
    """A datetime stand-in that pins ``now()`` to FIXED_NOW."""

    @classmethod
    def now(cls, tz: timezone | None = None) -> datetime:  # type: ignore[override]
        return FIXED_NOW


class _FakeThreading:
    """Runs ``Thread`` targets synchronously so tests stay deterministic."""

    Lock = staticmethod(lambda: threading.Lock())
    Event = staticmethod(lambda: threading.Event())

    class Thread:
        def __init__(self, target=None, args=(), kwargs=None, **__: Any) -> None:
            self._target = target
            self._args = args
            self._kwargs = kwargs or {}

        def start(self) -> None:
            if self._target:
                self._target(*self._args, **self._kwargs)

        def join(self, timeout: float | None = None) -> None:
            return None


# ---------------------------------------------------------------------------
# TaskScheduler persistence
# ---------------------------------------------------------------------------
def test_recover_next_runs_backfills_missing(monkeypatch):
    cursor = _FakeCursor(rows=[{"id": "abc123", "schedule": {"frequency": "daily", "time": "12:00"}}])
    monkeypatch.setattr(scheduler_mod, "service_tx", lambda: _FakeTx(cursor))
    monkeypatch.setattr(scheduler_mod, "datetime", _FixedDatetime)

    sched = TaskScheduler(tick_seconds=3600)
    sched._recover_next_runs()

    assert len(cursor.calls) == 2
    assert cursor.calls[0][0].upper().startswith("SELECT")
    assert cursor.calls[1][0].upper().startswith("UPDATE")
    assert cursor.calls[1][1][1] == "abc123"
    # 10:00 before 12:00 -> next run is same day at 12:00
    assert cursor.calls[1][1][0] == dt(2026, 8, 13, 12, 0)


def test_recover_next_runs_invalid_schedule_warns(monkeypatch, caplog):
    cursor = _FakeCursor(rows=[{"id": "bad1", "schedule": {"frequency": "weekly", "time": "09:00"}}])
    monkeypatch.setattr(scheduler_mod, "service_tx", lambda: _FakeTx(cursor))
    monkeypatch.setattr(scheduler_mod, "datetime", _FixedDatetime)

    sched = TaskScheduler(tick_seconds=3600)
    with caplog.at_level("WARNING"):
        sched._recover_next_runs()

    # SELECT is issued, but the broken row produces no UPDATE.
    assert all("UPDATE" not in c[0].upper() for c in cursor.calls)
    assert any("bad1" in rec.message for rec in caplog.records)


def test_due_tasks_returns_enabled_past_next_run(monkeypatch):
    rows = [
        {"id": "due1", "schedule": {"frequency": "daily", "time": "09:00"}},
        {"id": "due2", "schedule": {"frequency": "daily", "time": "08:00"}},
    ]
    cursor = _FakeCursor(rows=rows)
    monkeypatch.setattr(scheduler_mod, "service_tx", lambda: _FakeTx(cursor))
    monkeypatch.setattr(scheduler_mod, "datetime", _FixedDatetime)

    sched = TaskScheduler(tick_seconds=3600)
    due = sched._due_tasks()

    assert len(due) == 2
    assert due[0]["id"] == "due1"
    assert cursor.calls[0][0].upper().startswith("SELECT")
    assert cursor.calls[0][1][0] == FIXED_NOW


def test_advance_updates_next_run_and_last_run(monkeypatch):
    cursor = _FakeCursor()
    monkeypatch.setattr(scheduler_mod, "service_tx", lambda: _FakeTx(cursor))
    monkeypatch.setattr(scheduler_mod, "datetime", _FixedDatetime)

    sched = TaskScheduler(tick_seconds=3600)
    nxt = sched._advance("t1", {"frequency": "daily", "time": "09:00"})

    # 10:00 is after 09:00 -> next run is tomorrow at 09:00
    assert nxt == dt(2026, 8, 14, 9, 0)
    assert len(cursor.calls) == 1
    sql, params = cursor.calls[0]
    assert sql.upper().startswith("UPDATE")
    assert params[0] == nxt
    assert params[1] == FIXED_NOW
    assert params[2] == "t1"


def test_record_outcome(monkeypatch):
    cursor = _FakeCursor()
    monkeypatch.setattr(scheduler_mod, "service_tx", lambda: _FakeTx(cursor))

    sched = TaskScheduler(tick_seconds=3600)
    sched._record_outcome("t1", "error", "boom")

    assert len(cursor.calls) == 1
    sql, params = cursor.calls[0]
    assert sql.upper().startswith("UPDATE")
    assert params[:4] == ("error", "boom", None, None)
    assert params[4] is None  # last_output_summary
    assert params[5] == "t1"


def test_record_outcome_with_output_reference(monkeypatch):
    cursor = _FakeCursor()
    monkeypatch.setattr(scheduler_mod, "service_tx", lambda: _FakeTx(cursor))

    sched = TaskScheduler(tick_seconds=3600)
    sched._record_outcome("t1", "ok", None, "job-abc", "macro_job", {"kind": "macro_job", "calendar_rows": 10})

    assert len(cursor.calls) == 1
    sql, params = cursor.calls[0]
    assert sql.upper().startswith("UPDATE")
    assert params[:4] == ("ok", None, "job-abc", "macro_job")
    assert json.loads(params[4]) == {"kind": "macro_job", "calendar_rows": 10}
    assert params[5] == "t1"


# ---------------------------------------------------------------------------
# TaskScheduler dispatch
# ---------------------------------------------------------------------------
def _macro_task() -> dict:
    return {
        "id": "t-macro",
        "org_id": "org1",
        "user_id": "user1",
        "name": "Macro refresh",
        "kind": "macro_refresh",
        "schedule": {"frequency": "daily", "time": "07:00"},
        "params": {"what": "all"},
    }


def _data_task() -> dict:
    return {
        "id": "t-data",
        "org_id": "org1",
        "user_id": "user1",
        "name": "Data refresh",
        "kind": "data_refresh",
        "schedule": {"frequency": "daily", "time": "07:00"},
        "params": {"universe_size": 100, "mode": "update"},
    }


def _run_task() -> dict:
    return {
        "id": "t-run",
        "org_id": "org1",
        "user_id": "user1",
        "name": "Run strategy",
        "kind": "run_strategy",
        "schedule": {"frequency": "daily", "time": "07:00"},
        "params": {"strategy_id": "s1"},
    }


def _outlook_task() -> dict:
    return {
        "id": "t-outlook",
        "org_id": "org1",
        "user_id": "user1",
        "name": "Weekly outlook",
        "kind": "outlook_report",
        "schedule": {"frequency": "weekly", "time": "07:00", "day": "fri"},
        "params": {"scope": "week"},
    }


def _stub_tick_environment(monkeypatch, sched: TaskScheduler, due: list[dict]):
    """Wire a scheduler instance so _tick() runs synchronously with a fake DB."""
    monkeypatch.setattr(scheduler_mod, "threading", _FakeThreading())
    monkeypatch.setattr(scheduler_mod, "datetime", _FixedDatetime)
    monkeypatch.setattr(scheduler_mod, "service_tx", lambda: _FakeTx(_FakeCursor()))
    monkeypatch.setattr(sched, "_due_tasks", lambda: due)
    monkeypatch.setattr(sched, "_advance", lambda _tid, _sched: dt(2026, 8, 14, 7, 0))
    # The dispatch thread waits for jobs/runs; mock the wait helpers so tests
    # do not hang on the in-memory jobs, which never finish in these stubs.
    monkeypatch.setattr(sched, "_wait_for_macro_summary", lambda _jid, _router: {"kind": "macro_job", "calendar_rows": 10})
    monkeypatch.setattr(sched, "_wait_for_ingest_summary", lambda _jid, _router: {"kind": "ingest_job", "symbols_written": 50})
    monkeypatch.setattr(sched, "_wait_for_run_summary", lambda _rid, _principal: {"kind": "run", "status": "succeeded"})
    outcomes: list[tuple[str, str, str | None, str | None, str | None, dict | None]] = []
    monkeypatch.setattr(
        sched,
        "_record_outcome",
        lambda tid, status, error, output_id=None, output_kind=None, output_summary=None: outcomes.append(
            (tid, status, error, output_id, output_kind, output_summary)
        ),
    )
    return outcomes


def test_tick_dispatches_macro_refresh(monkeypatch):
    sched = TaskScheduler(tick_seconds=3600)
    outcomes = _stub_tick_environment(monkeypatch, sched, [_macro_task()])

    enqueues: list[tuple[str, MacroRefreshRequest]] = []
    monkeypatch.setattr(macro_router, "_new_job_id", lambda: "job-m1")
    monkeypatch.setattr(macro_router, "_enqueue_job", lambda jid, req: enqueues.append((jid, req)))
    monkeypatch.setattr(macro_router._executor, "submit", lambda _fn, *_args: None)

    sched._tick()

    assert len(enqueues) == 1
    assert enqueues[0][0] == "job-m1"
    assert enqueues[0][1].what == "all"
    assert outcomes == [("t-macro", "ok", None, "job-m1", "macro_job", {"kind": "macro_job", "calendar_rows": 10})]


def test_tick_dispatches_data_refresh(monkeypatch):
    sched = TaskScheduler(tick_seconds=3600)
    outcomes = _stub_tick_environment(monkeypatch, sched, [_data_task()])

    enqueues: list[tuple[str, RefreshRequest]] = []
    monkeypatch.setattr(ingest_router, "_new_job_id", lambda: "job-d1")
    monkeypatch.setattr(ingest_router, "_enqueue_job", lambda jid, req: enqueues.append((jid, req)))
    monkeypatch.setattr(ingest_router._executor, "submit", lambda _fn, *_args: None)

    sched._tick()

    assert len(enqueues) == 1
    assert enqueues[0][0] == "job-d1"
    assert enqueues[0][1].universe_size == 100
    assert outcomes == [("t-data", "ok", None, "job-d1", "ingest_job", {"kind": "ingest_job", "symbols_written": 50})]


def test_tick_dispatches_run_strategy(monkeypatch):
    sched = TaskScheduler(tick_seconds=3600)
    outcomes = _stub_tick_environment(monkeypatch, sched, [_run_task()])

    stored = SimpleNamespace(
        data_store="us",
        name="Test strategy",
        model="gbm",
        handler="alpha158",
        feature_mode="default",
        features=[],
        universe="top500",
        benchmark="SPY",
        topk=10,
        n_drop=2,
        open_cost=0.001,
        close_cost=0.001,
    )

    monkeypatch.setattr(repositories, "StrategyRepo", lambda _principal: SimpleNamespace(get=lambda _sid: stored))
    monkeypatch.setattr(marketdata, "resolve_store", lambda _key: ("/tmp/store-us", "us"))
    monkeypatch.setattr(strategies, "build_workflow_config", lambda _stored, _uri, _region: {"test": "config"})

    start_calls: list[dict] = []

    class FakeRunManager:
        def start(self, principal, name, config, kind, strategy_id, extra):
            start_calls.append({
                "principal": principal,
                "name": name,
                "config": config,
                "kind": kind,
                "strategy_id": strategy_id,
                "extra": extra,
            })
            return SimpleNamespace(id="run-123")

    monkeypatch.setattr(runs_manager, "start", FakeRunManager().start)

    sched._tick()

    assert len(start_calls) == 1
    call = start_calls[0]
    assert call["name"] == "Scheduled Test strategy"
    assert call["kind"] == "backtest"
    assert call["strategy_id"] == "s1"
    assert call["extra"]["benchmark"] == "SPY"
    assert outcomes == [("t-run", "ok", None, "run-123", "run", {"kind": "run", "status": "succeeded"})]


def test_tick_dispatches_outlook_report(monkeypatch):
    sched = TaskScheduler(tick_seconds=3600)
    outcomes = _stub_tick_environment(monkeypatch, sched, [_outlook_task()])

    monkeypatch.setattr(
        outlook_report_mod,
        "generate_outlook_report",
        lambda _task, _principal: ("report-123", {"kind": "outlook_report", "scope": "week"}),
    )

    sched._tick()

    assert outcomes == [("t-outlook", "ok", None, "report-123", "outlook_report", {"kind": "outlook_report", "scope": "week"})]


def test_tick_skips_in_flight_task(monkeypatch):
    sched = TaskScheduler(tick_seconds=3600)
    _stub_tick_environment(monkeypatch, sched, [_macro_task()])
    sched._in_flight.add("t-macro")

    monkeypatch.setattr(macro_router, "_new_job_id", lambda: "job-m1")
    enqueues: list = []
    monkeypatch.setattr(macro_router, "_enqueue_job", lambda jid, req: enqueues.append((jid, req)))
    monkeypatch.setattr(macro_router._executor, "submit", lambda _fn, *_args: None)

    sched._tick()
    assert enqueues == []


def test_dispatch_records_success(monkeypatch):
    sched = TaskScheduler(tick_seconds=3600)
    monkeypatch.setattr(scheduler_mod, "service_tx", lambda: _FakeTx(_FakeCursor()))
    outcomes: list = []
    monkeypatch.setattr(
        sched,
        "_record_outcome",
        lambda tid, status, error, output_id=None, output_kind=None, output_summary=None: outcomes.append(
            (tid, status, error, output_id, output_kind, output_summary)
        ),
    )
    monkeypatch.setattr(sched, "_run_task", lambda _task: ("job-xyz", "macro_job", {"kind": "macro_job"}))

    sched._dispatch(_macro_task())
    assert outcomes == [("t-macro", "ok", None, "job-xyz", "macro_job", {"kind": "macro_job"})]
    assert "t-macro" not in sched._in_flight


def test_dispatch_records_task_failure(monkeypatch):
    sched = TaskScheduler(tick_seconds=3600)
    monkeypatch.setattr(scheduler_mod, "service_tx", lambda: _FakeTx(_FakeCursor()))
    outcomes: list = []
    monkeypatch.setattr(
        sched,
        "_record_outcome",
        lambda tid, status, error, output_id=None, output_kind=None, output_summary=None: outcomes.append(
            (tid, status, error, output_id, output_kind, output_summary)
        ),
    )

    def _explode(_task: dict) -> None:
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(sched, "_run_task", _explode)
    sched._dispatch(_macro_task())

    assert len(outcomes) == 1
    assert outcomes[0][0] == "t-macro"
    assert outcomes[0][1] == "error"
    assert "RuntimeError" in outcomes[0][2]
    assert outcomes[0][3] is None
    assert outcomes[0][4] is None
    assert outcomes[0][5] is None
    assert "t-macro" not in sched._in_flight


def test_macro_refresh_skipped_when_busy(monkeypatch):
    sched = TaskScheduler(tick_seconds=3600)
    _stub_tick_environment(monkeypatch, sched, [_macro_task()])

    monkeypatch.setattr(macro_router, "_new_job_id", lambda: "job-m1")
    monkeypatch.setattr(
        macro_router,
        "_enqueue_job",
        lambda _jid, _req: (_ for _ in ()).throw(RuntimeError("already running")),
    )
    monkeypatch.setattr(macro_router._executor, "submit", lambda _fn, *_args: None)

    outcomes = _stub_tick_environment(monkeypatch, sched, [_macro_task()])
    sched._tick()

    assert outcomes == [("t-macro", "skipped", "already running", None, None, None)]


# ---------------------------------------------------------------------------
# Output summaries
# ---------------------------------------------------------------------------
def test_macro_summary_shapes_job_output():
    from webapp.api.scheduler import _macro_summary

    summary = _macro_summary({
        "status": "done",
        "error": None,
        "summary": {
            "calendar_rows": 1200,
            "indicator_rows": 800,
            "indicators": {"USA/cpi": 100},
            "warnings": ["one"],
        },
    })

    assert summary == {
        "kind": "macro_job",
        "status": "done",
        "error": None,
        "calendar_rows": 1200,
        "indicator_rows": 800,
        "indicators": {"USA/cpi": 100},
        "warnings_count": 1,
    }


def test_ingest_summary_shapes_job_output():
    from webapp.api.scheduler import _ingest_summary

    summary = _ingest_summary({
        "status": "done",
        "error": None,
        "restart_required": True,
        "summary": {
            "symbols_requested": 500,
            "symbols_written": 498,
            "symbols_failed": 2,
            "failed_sample": ["A", "B"],
            "universe": "top500",
            "start": "2010-01-01",
            "end": "2026-08-13",
            "non_trading_days_pruned": 5,
        },
    })

    assert summary["kind"] == "ingest_job"
    assert summary["symbols_written"] == 498
    assert summary["restart_required"] is True


def test_run_summary_shapes_run_meta():
    from webapp.api.scheduler import _run_summary

    summary = _run_summary({
        "status": "succeeded",
        "error": None,
        "error_hint": None,
        "name": "Scheduled Momentum",
        "model": "gbm",
        "handler": "alpha158",
        "universe": "top500",
        "benchmark": "SPY",
        "metrics": {
            "risk": {
                "excess_return_with_cost": {
                    "annualized_return": 0.084,
                    "max_drawdown": -0.123,
                    "information_ratio": 1.2,
                    "volatility": 0.15,
                }
            },
            "period": {"start": "2020-01-01", "end": "2026-01-01"},
        },
    })

    assert summary["kind"] == "run"
    assert summary["status"] == "succeeded"
    assert summary["annual_return"] == 0.084
    assert summary["max_drawdown"] == -0.123
    assert summary["period_start"] == "2020-01-01"


def test_wait_for_macro_summary_polling(monkeypatch):
    """The dispatch thread polls the in-memory job until it is no longer running."""
    from webapp.api.scheduler import _SUMMARY_WAIT_SECONDS, TaskScheduler

    class FakeRouter:
        calls = 0

        @classmethod
        def _get_job(cls, _job_id):
            cls.calls += 1
            if cls.calls < 3:
                return {"status": "running"}
            return {
                "status": "done",
                "error": None,
                "summary": {"calendar_rows": 42, "indicator_rows": 7},
            }

    monkeypatch.setattr(scheduler_mod, "time", SimpleNamespace(monotonic=lambda: 0, sleep=lambda _s: None))
    summary = TaskScheduler._wait_for_macro_summary("job-1", FakeRouter)

    assert summary["kind"] == "macro_job"
    assert summary["calendar_rows"] == 42


def test_wait_for_run_summary_polling(monkeypatch):
    """The dispatch thread polls the run until it reaches a terminal status."""
    from webapp.api.scheduler import TaskScheduler
    from webapp.api.routers.runs import _runs as runs_manager

    calls = []

    class FakeRun:
        def __init__(self, status):
            self.meta = {"status": status, "metrics": {"period": {"start": "2020-01-01", "end": "2026-01-01"}}}

    def fake_get(_principal, _run_id):
        calls.append(None)
        if len(calls) < 3:
            return FakeRun("running")
        return FakeRun("succeeded")

    monkeypatch.setattr(runs_manager, "get", fake_get)
    monkeypatch.setattr(scheduler_mod, "time", SimpleNamespace(monotonic=lambda: 0, sleep=lambda _s: None))

    summary = TaskScheduler()._wait_for_run_summary("run-1", SimpleNamespace(user_id="u1"))

    assert summary["kind"] == "run"
    assert summary["status"] == "succeeded"


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------
def test_start_stop_lifecycle(monkeypatch):
    cursor = _FakeCursor(rows=[])
    monkeypatch.setattr(scheduler_mod, "service_tx", lambda: _FakeTx(cursor))
    monkeypatch.setattr(scheduler_mod, "datetime", _FixedDatetime)

    sched = TaskScheduler(tick_seconds=0.05)
    sched.start()
    assert sched._thread is not None
    assert sched._thread.is_alive()

    sched.stop()
    assert not sched._thread.is_alive()

    # Restarting after stop must work.
    sched.start()
    assert sched._thread.is_alive()
    sched.stop()


# ---------------------------------------------------------------------------
# scalability_report kind
# ---------------------------------------------------------------------------
def test_spec_scalability_report_defaults():
    spec = ScheduledTaskSpec(name="Scalability", kind="scalability_report", schedule=Schedule(frequency="weekly", time="07:00", day="mon"), params={})
    assert spec.params == {}


def test_spec_scalability_report_valid_params():
    spec = ScheduledTaskSpec(name="Scalability", kind="scalability_report", schedule=Schedule(frequency="weekly", time="07:00", day="mon"), params={"upload_id": "u-1", "candidate_venues": ["IBKR", "UBS"]})
    assert spec.params["upload_id"] == "u-1"
    assert spec.params["candidate_venues"] == ["IBKR", "UBS"]


def test_spec_scalability_report_invalid_upload_id():
    with pytest.raises(ValueError, match="upload_id"):
        ScheduledTaskSpec(name="Scalability", kind="scalability_report", schedule=Schedule(frequency="weekly", time="07:00", day="mon"), params={"upload_id": 42})


def test_spec_scalability_report_invalid_candidate_venues():
    with pytest.raises(ValueError, match="candidate_venues"):
        ScheduledTaskSpec(name="Scalability", kind="scalability_report", schedule=Schedule(frequency="weekly", time="07:00", day="mon"), params={"candidate_venues": "UBS"})
    with pytest.raises(ValueError, match="candidate_venues"):
        ScheduledTaskSpec(name="Scalability", kind="scalability_report", schedule=Schedule(frequency="weekly", time="07:00", day="mon"), params={"candidate_venues": ["UBS", 7]})


class _ScalabilityCursor:
    """Scripts the SQL sequence the scalability_report dispatch issues."""

    def __init__(
        self,
        upload_row: dict | None = ...,
        job_statuses: list[str] | None = None,
        report_row: dict | None = ...,
    ) -> None:
        self.calls: list[tuple[str, tuple[Any, ...] | None]] = []
        self.upload_row = {"id": "u-1", "status": "parsed"} if upload_row is ... else upload_row
        self.job_statuses = list(job_statuses or ["succeeded"])
        self.report_row = (
            {
                "id": "rep-1",
                "current_venue": "IBKR",
                "result": {
                    "comparison": {
                        "current": {"venue": "IBKR", "ceiling_usd": 12_000_000},
                        "alternatives": [{"venue": "UBS", "ceiling_usd": 40_000_000}],
                        "best_alternative": {"venue": "UBS", "ceiling_usd": 40_000_000},
                    },
                },
            }
            if report_row is ...
            else report_row
        )
        self._one: dict | None = None

    def execute(self, sql: str, params: tuple[Any, ...] | None = None) -> None:
        sql = sql.strip()
        self.calls.append((sql, params))
        if sql.startswith("SELECT id, status FROM aion.scalability_uploads"):
            self._one = self.upload_row
        elif sql.startswith("SELECT id FROM aion.scalability_uploads"):
            self._one = {"id": self.upload_row["id"]} if self.upload_row else None
        elif sql.startswith("INSERT INTO aion.scalability_jobs"):
            self._one = {"id": "job-1"}
        elif sql.startswith("SELECT status, error, report_id FROM aion.scalability_jobs"):
            status = self.job_statuses.pop(0) if self.job_statuses else "succeeded"
            self._one = {
                "status": status,
                "error": "engine blew up" if status == "failed" else None,
                "report_id": "rep-1" if status == "succeeded" else None,
            }
        elif sql.startswith("SELECT id, current_venue, result FROM aion.scalability_reports"):
            self._one = self.report_row
        else:
            self._one = None

    def fetchone(self) -> dict | None:
        return self._one

    def fetchall(self) -> list[dict]:
        return []


def _scalability_task(params: dict | None = None) -> dict:
    return {
        "id": "t-scal",
        "org_id": "org1",
        "user_id": "user1",
        "name": "Scalability check",
        "kind": "scalability_report",
        "schedule": {"frequency": "weekly", "time": "07:00", "day": "mon"},
        "params": params or {},
    }


def _run_scalability_dispatch(monkeypatch, cursor: _ScalabilityCursor, params: dict | None = None):
    """Tick a scheduler whose only due task is a scalability_report; return outcomes."""
    sched = TaskScheduler(tick_seconds=3600)
    outcomes = _stub_tick_environment(monkeypatch, sched, [_scalability_task(params)])
    monkeypatch.setattr(scheduler_mod, "service_tx", lambda: _FakeTx(cursor))
    sched._tick()
    return outcomes


def test_tick_dispatches_scalability_report(monkeypatch):
    cursor = _ScalabilityCursor()
    outcomes = _run_scalability_dispatch(monkeypatch, cursor)

    # The dispatch enqueues an analyze job instead of running anything itself.
    inserts = [c for c in cursor.calls if c[0].startswith("INSERT INTO aion.scalability_jobs")]
    assert len(inserts) == 1
    sql, params = inserts[0]
    assert "'analyze'" in sql and "'queued'" in sql
    assert params[0] == "user1"
    assert params[1] == "org1"
    assert json.loads(params[2]) == {"upload_id": "u-1"}
    assert params[3] == "u-1"

    assert outcomes == [(
        "t-scal", "ok", None, "rep-1", "scalability_report",
        {
            "kind": "scalability_report",
            "current_venue": "IBKR",
            "current_ceiling": 12_000_000,
            "best_alternative": "UBS",
            "best_alternative_ceiling": 40_000_000,
        },
    )]


def test_scalability_report_passes_candidate_venues(monkeypatch):
    cursor = _ScalabilityCursor()
    _run_scalability_dispatch(monkeypatch, cursor, params={"upload_id": "u-9", "candidate_venues": ["UBS"]})

    inserts = [c for c in cursor.calls if c[0].startswith("INSERT INTO aion.scalability_jobs")]
    assert json.loads(inserts[0][1][2]) == {"upload_id": "u-1", "candidate_venues": ["UBS"]}
    # An explicit upload_id is resolved (and ownership-scoped) rather than
    # falling back to the latest parsed upload.
    lookups = [c for c in cursor.calls if c[0].startswith("SELECT id, status FROM aion.scalability_uploads")]
    assert lookups and lookups[0][1] == ("u-9", "user1")


def test_scalability_report_records_error_when_job_fails(monkeypatch):
    cursor = _ScalabilityCursor(job_statuses=["failed"])
    outcomes = _run_scalability_dispatch(monkeypatch, cursor)

    assert len(outcomes) == 1
    assert outcomes[0][0] == "t-scal"
    assert outcomes[0][1] == "error"
    assert "engine blew up" in outcomes[0][2]
    assert outcomes[0][3] is None  # no output id


def test_scalability_report_records_error_without_parsed_upload(monkeypatch):
    cursor = _ScalabilityCursor(upload_row=None)
    outcomes = _run_scalability_dispatch(monkeypatch, cursor)

    assert outcomes[0][1] == "error"
    assert "no parsed scalability upload" in outcomes[0][2]
    assert not any(c[0].startswith("INSERT") for c in cursor.calls)


def test_scalability_report_rejects_unparsed_upload(monkeypatch):
    cursor = _ScalabilityCursor(upload_row={"id": "u-1", "status": "pending"})
    outcomes = _run_scalability_dispatch(monkeypatch, cursor, params={"upload_id": "u-1"})

    assert outcomes[0][1] == "error"
    assert "not parsed" in outcomes[0][2]
    assert not any(c[0].startswith("INSERT") for c in cursor.calls)


def test_scalability_summary_shapes_report_row():
    from webapp.api.scheduler import _scalability_summary

    summary = _scalability_summary({
        "id": "rep-1",
        "current_venue": "IBKR",
        "result": {
            "comparison": {
                "current": {"venue": "IBKR", "ceiling_usd": 12_000_000},
                "alternatives": [
                    {"venue": "UBS", "ceiling_usd": 40_000_000},
                    {"venue": "Other", "ceiling_usd": 20_000_000},
                ],
                "best_alternative": {"venue": "UBS", "ceiling_usd": 40_000_000},
            },
        },
    })

    assert summary == {
        "kind": "scalability_report",
        "current_venue": "IBKR",
        "current_ceiling": 12_000_000,
        "best_alternative": "UBS",
        "best_alternative_ceiling": 40_000_000,
    }


def test_scalability_summary_tolerates_missing_pieces():
    from webapp.api.scheduler import _scalability_summary

    summary = _scalability_summary({"id": "rep-1", "current_venue": "IBKR", "result": {}})

    assert summary["kind"] == "scalability_report"
    assert summary["current_venue"] == "IBKR"
    assert summary["current_ceiling"] is None
    assert summary["best_alternative"] is None
    assert summary["best_alternative_ceiling"] is None


def test_wait_for_scalability_job_polling(monkeypatch):
    """The dispatch thread polls the job row until the agent finishes it."""
    cursor = _ScalabilityCursor(job_statuses=["queued", "running", "succeeded"])
    monkeypatch.setattr(scheduler_mod, "service_tx", lambda: _FakeTx(cursor))
    monkeypatch.setattr(scheduler_mod, "time", SimpleNamespace(monotonic=lambda: 0, sleep=lambda _s: None))

    row = TaskScheduler._wait_for_scalability_job("job-1")

    assert row["status"] == "succeeded"
    assert row["report_id"] == "rep-1"
    polls = [c for c in cursor.calls if c[0].startswith("SELECT status, error, report_id")]
    assert len(polls) == 3
