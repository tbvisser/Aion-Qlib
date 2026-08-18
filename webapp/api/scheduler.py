"""In-process scheduler for aion.scheduled_tasks.

A single daemon thread inside the API process wakes every minute, finds tasks
whose ``next_run`` has passed, advances ``next_run`` to the following
occurrence, and dispatches the work. Tasks are persisted in Postgres, so they
survive restarts; the scheduler just provides the clock.

The scheduler bypasses RLS (it uses ``service_tx``) because it has no user's
access token. Ownership is preserved by dispatching under the stored user_id and
org_id, and admin-gated task kinds were already validated at creation time.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from .auth import Principal
from .config import get_settings
from .db import service_tx
from .scheduler_spec import Schedule, ScheduledTaskSpec, next_run

logger = logging.getLogger(__name__)

_TICK_SECONDS = 60.0

# How long the dispatch thread waits for an output job/run to finish before
# recording the output id without a summary. This keeps the per-task thread
# from leaking while still capturing summaries for most routine work.
_SUMMARY_WAIT_SECONDS = 30 * 60


class TaskScheduler:
    """Owns the scheduler thread and the in-memory in-flight set."""

    def __init__(self, tick_seconds: float = _TICK_SECONDS) -> None:
        self._tick_seconds = tick_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._in_flight: set[str] = set()
        self._lock = threading.Lock()

    def start(self) -> None:
        """Begin ticking. Safe to call more than once."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="task-scheduler", daemon=True)
        self._thread.start()
        logger.info("scheduled-task scheduler started")

    def stop(self) -> None:
        """Signal the loop to exit and wait briefly."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self._tick_seconds + 1)

    def _loop(self) -> None:
        # Recover next_run for any enabled task that lacks one (first boot or
        # re-enable that happened while the scheduler was down).
        self._recover_next_runs()
        while not self._stop.wait(timeout=self._tick_seconds):
            try:
                self._tick()
            except Exception:  # noqa: BLE001 - the scheduler must never die
                logger.exception("scheduler tick failed")

    # ------------------------------------------------------------------
    # Persistence helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _new_id() -> str:
        return uuid.uuid4().hex[:12]

    def _recover_next_runs(self) -> None:
        """Backfill next_run for enabled tasks that do not have one."""
        now = datetime.now(timezone.utc)
        with service_tx() as cur:
            cur.execute(
                "SELECT id, schedule FROM aion.scheduled_tasks "
                "WHERE enabled = true AND next_run IS NULL"
            )
            for row in cur.fetchall():
                try:
                    spec = Schedule(**row["schedule"])
                    nxt = next_run(spec, now)
                    cur.execute(
                        "UPDATE aion.scheduled_tasks SET next_run = %s::timestamptz WHERE id = %s",
                        (nxt, row["id"]),
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("could not recover next_run for %s: %s", row["id"], exc)

    def _due_tasks(self) -> list[dict[str, Any]]:
        now = datetime.now(timezone.utc)
        with service_tx() as cur:
            cur.execute(
                "SELECT id, org_id, user_id, name, kind, schedule, params "
                "FROM aion.scheduled_tasks "
                "WHERE enabled = true AND next_run <= %s::timestamptz "
                "ORDER BY next_run",
                (now,),
            )
            return [dict(row) for row in cur.fetchall()]

    def _advance(self, task_id: str, schedule: dict) -> datetime:
        """Advance next_run and set last_run in one transaction.

        Clears the previous output reference because a new execution is
        starting; the dispatch thread will write the new output id once it is
        known. Returns the new next_run so the dispatcher can log it.
        """
        now = datetime.now(timezone.utc)
        spec = Schedule(**schedule)
        nxt = next_run(spec, now)
        with service_tx() as cur:
            cur.execute(
                "UPDATE aion.scheduled_tasks "
                "SET next_run = %s::timestamptz, last_run = %s::timestamptz, "
                "    last_status = NULL, last_error = NULL, "
                "    last_output_id = NULL, last_output_kind = NULL, "
                "    last_output_summary = NULL "
                "WHERE id = %s",
                (nxt, now, task_id),
            )
        return nxt

    def _record_outcome(
        self,
        task_id: str,
        status: str,
        error: str | None,
        output_id: str | None = None,
        output_kind: str | None = None,
        output_summary: dict[str, Any] | None = None,
    ) -> None:
        with service_tx() as cur:
            cur.execute(
                "UPDATE aion.scheduled_tasks "
                "SET last_status = %s, last_error = %s, "
                "    last_output_id = %s, last_output_kind = %s, "
                "    last_output_summary = %s "
                "WHERE id = %s",
                (status, error, output_id, output_kind,
                 json.dumps(output_summary) if output_summary else None, task_id),
            )

    # ------------------------------------------------------------------
    # Dispatch
    # ------------------------------------------------------------------
    def _tick(self) -> None:
        due = self._due_tasks()
        for task in due:
            with self._lock:
                if task["id"] in self._in_flight:
                    continue
                self._in_flight.add(task["id"])
            try:
                nxt = self._advance(task["id"], task["schedule"])
                logger.info(
                    "dispatching scheduled task %s (%s); next occurrence at %s",
                    task["id"], task["kind"], nxt.isoformat(),
                )
                threading.Thread(
                    target=self._dispatch,
                    args=(task,),
                    name=f"scheduled-{task['kind']}-{task['id']}",
                    daemon=True,
                ).start()
            except Exception:  # noqa: BLE001
                logger.exception("failed to advance scheduled task %s", task["id"])
                with self._lock:
                    self._in_flight.discard(task["id"])

    class TaskSkipped(Exception):
        """Raised when a task is not executed because its target is busy."""

    def _dispatch(self, task: dict[str, Any]) -> None:
        """Run the task and record the outcome."""
        output_id: str | None = None
        output_kind: str | None = None
        output_summary: dict[str, Any] | None = None
        try:
            output_id, output_kind, output_summary = self._run_task(task)
            self._record_outcome(
                task["id"], "ok", None, output_id, output_kind, output_summary
            )
        except self.TaskSkipped as exc:
            logger.info("scheduled task %s skipped: %s", task["id"], exc)
            self._record_outcome(task["id"], "skipped", str(exc))
        except Exception as exc:  # noqa: BLE001
            logger.exception("scheduled task %s failed", task["id"])
            self._record_outcome(task["id"], "error", f"{type(exc).__name__}: {exc}")
        finally:
            with self._lock:
                self._in_flight.discard(task["id"])

    def _run_task(self, task: dict[str, Any]) -> tuple[str, str, dict[str, Any] | None]:
        """Run the task and return the (output_id, output_kind, output_summary) triple."""
        kind = task["kind"]
        params = task["params"] or {}

        if kind == "macro_refresh":
            return self._run_macro_refresh(task, params)
        if kind == "data_refresh":
            return self._run_data_refresh(task, params)
        if kind == "run_strategy":
            return self._run_strategy(task, params)
        if kind == "outlook_report":
            return self._run_outlook_report(task, params)
        if kind == "scalability_report":
            return self._run_scalability_report(task, params)
        raise ValueError(f"unknown scheduled task kind: {kind}")

    def _run_macro_refresh(
        self, task: dict[str, Any], params: dict[str, Any]
    ) -> tuple[str, str, dict[str, Any] | None]:
        from .routers import macro as macro_router
        from .routers.macro import MacroRefreshRequest

        req = MacroRefreshRequest(**params)
        # Reuse the existing single-worker executor; if another refresh is already
        # running, report skipped rather than an error.
        try:
            job_id = macro_router._new_job_id()
            macro_router._enqueue_job(job_id, req)
        except RuntimeError as exc:
            raise self.TaskSkipped(str(exc)) from None
        macro_router._executor.submit(macro_router._run_refresh, job_id, req)
        summary = self._wait_for_macro_summary(job_id, macro_router)
        return job_id, "macro_job", summary

    def _run_data_refresh(
        self, task: dict[str, Any], params: dict[str, Any]
    ) -> tuple[str, str, dict[str, Any] | None]:
        from .routers import ingest as ingest_router
        from .routers.ingest import RefreshRequest

        req = RefreshRequest(**params)
        try:
            job_id = ingest_router._new_job_id()
            ingest_router._enqueue_job(job_id, req)
        except RuntimeError as exc:
            raise self.TaskSkipped(str(exc)) from None
        ingest_router._executor.submit(ingest_router._run_job, job_id, req)
        summary = self._wait_for_ingest_summary(job_id, ingest_router)
        return job_id, "ingest_job", summary

    def _run_strategy(
        self, task: dict[str, Any], params: dict[str, Any]
    ) -> tuple[str, str, dict[str, Any] | None]:
        from .repositories import StrategyRepo
        from .routers.runs import _runs
        from .strategies import build_workflow_config

        strategy_id = params["strategy_id"]
        principal = Principal(
            user_id=str(task["user_id"]),
            email=None,
            org_id=str(task["org_id"]),
            org_role="member",
        )
        repo = StrategyRepo(principal)
        stored = repo.get(strategy_id)
        if stored is None:
            raise ValueError(f"strategy '{strategy_id}' not found or not accessible")

        from . import marketdata
        provider_uri, region = marketdata.resolve_store(stored.data_store)
        config = build_workflow_config(stored, provider_uri, region)
        run = _runs.start(
            principal,
            name=f"Scheduled {stored.name}",
            config=config,
            kind="backtest",
            strategy_id=strategy_id,
            extra={
                "model": stored.model,
                "handler": stored.handler,
                "feature_mode": stored.feature_mode,
                "feature_count": len(stored.features or []),
                "universe": stored.universe,
                "benchmark": stored.benchmark,
                "data_store": stored.data_store,
                "topk": stored.topk,
                "n_drop": stored.n_drop,
                "open_cost": stored.open_cost,
                "close_cost": stored.close_cost,
            },
        )
        summary = self._wait_for_run_summary(run.id, principal)
        return run.id, "run", summary

    def _run_outlook_report(
        self, task: dict[str, Any], params: dict[str, Any]
    ) -> tuple[str, str, dict[str, Any] | None]:
        from . import outlook_report

        principal = Principal(
            user_id=str(task["user_id"]),
            email=None,
            org_id=str(task["org_id"]),
            org_role="member",
        )
        report_id, summary = outlook_report.generate_outlook_report(task, principal)
        return report_id, "outlook_report", summary

    def _run_scalability_report(
        self, task: dict[str, Any], params: dict[str, Any]
    ) -> tuple[str, str, dict[str, Any] | None]:
        """Enqueue an ``analyze`` job for the scalability agent and wait for its report.

        Unlike the other kinds, nothing runs in-process here: the platform is
        the control plane, the scalability agent (a separate service polling
        ``aion.scalability_jobs``) is the data plane. The scheduler has no
        user token, so upload resolution and the enqueue go through
        ``service_tx`` under the task's stored user_id/org_id, mirroring how
        ``_run_strategy`` uses service-level access.
        """
        with service_tx() as cur:
            upload_id = self._resolve_scalability_upload(cur, task, params)
            job_id = self._enqueue_scalability_job(cur, task, upload_id, params)
        job = self._wait_for_scalability_job(job_id)
        if job is None:
            # Timed out waiting: the agent may still finish, so record the job
            # id without a summary, as the other kinds do for slow work.
            return job_id, "scalability_report", None
        with service_tx() as cur:
            cur.execute(
                "SELECT id, current_venue, result FROM aion.scalability_reports "
                "WHERE id = %s",
                (str(job["report_id"]),),
            )
            report = cur.fetchone()
        if report is None:
            raise RuntimeError(
                f"scalability job {job_id} succeeded but report {job['report_id']} is missing"
            )
        return str(report["id"]), "scalability_report", _scalability_summary(report)

    @staticmethod
    def _resolve_scalability_upload(
        cur: Any, task: dict[str, Any], params: dict[str, Any]
    ) -> str:
        """Pick the upload to analyze: ``params.upload_id``, else the task
        owner's latest parsed upload. Service-role access, so ownership is
        scoped explicitly in the queries."""
        upload_id = params.get("upload_id")
        if upload_id:
            cur.execute(
                "SELECT id, status FROM aion.scalability_uploads "
                "WHERE id = %s AND user_id = %s",
                (upload_id, str(task["user_id"])),
            )
            row = cur.fetchone()
            if row is None:
                raise ValueError(f"scalability upload '{upload_id}' not found")
            if row["status"] != "parsed":
                raise ValueError(
                    f"scalability upload '{upload_id}' is not parsed "
                    f"(status={row['status']})"
                )
            return str(row["id"])
        cur.execute(
            "SELECT id FROM aion.scalability_uploads "
            "WHERE user_id = %s AND status = 'parsed' "
            "ORDER BY created_at DESC LIMIT 1",
            (str(task["user_id"]),),
        )
        row = cur.fetchone()
        if row is None:
            raise ValueError("no parsed scalability upload for this user")
        return str(row["id"])

    @staticmethod
    def _enqueue_scalability_job(
        cur: Any, task: dict[str, Any], upload_id: str, params: dict[str, Any]
    ) -> str:
        """Insert the queued ``analyze`` job the agent will claim; returns the job id."""
        job_params: dict[str, Any] = {"upload_id": upload_id}
        candidate_venues = params.get("candidate_venues")
        if candidate_venues:
            job_params["candidate_venues"] = candidate_venues
        cur.execute(
            "INSERT INTO aion.scalability_jobs (user_id, org_id, kind, status, params, upload_id) "
            "VALUES (%s, %s, 'analyze', 'queued', %s, %s) RETURNING id",
            (str(task["user_id"]), str(task["org_id"]), json.dumps(job_params), upload_id),
        )
        return str(cur.fetchone()["id"])

    @staticmethod
    def _wait_for_scalability_job(job_id: str) -> dict[str, Any] | None:
        """Poll the job row until the agent finishes it; return the terminal row.

        A failed job raises so ``_dispatch`` records the error; a timeout
        returns None like the other summary waiters.
        """
        deadline = time.monotonic() + _SUMMARY_WAIT_SECONDS
        poll = 2.0
        while time.monotonic() < deadline:
            with service_tx() as cur:
                cur.execute(
                    "SELECT status, error, report_id FROM aion.scalability_jobs "
                    "WHERE id = %s",
                    (job_id,),
                )
                row = cur.fetchone()
            if row is None:
                raise ValueError(f"scalability job {job_id} disappeared")
            if row["status"] == "succeeded":
                return row
            if row["status"] == "failed":
                raise RuntimeError(f"scalability job {job_id} failed: {row['error']}")
            time.sleep(poll)
            poll = min(poll * 1.5, 10.0)
        logger.warning("timed out waiting for scalability job %s", job_id)
        return None


    # ------------------------------------------------------------------
    # Summary capture
    # ------------------------------------------------------------------
    @staticmethod
    def _wait_for_macro_summary(
        job_id: str, macro_router: Any
    ) -> dict[str, Any] | None:
        """Poll the in-memory macro job until it finishes; return a plain-language summary."""
        deadline = time.monotonic() + _SUMMARY_WAIT_SECONDS
        poll = 2.0
        while time.monotonic() < deadline:
            try:
                job = macro_router._get_job(job_id)
            except Exception:  # noqa: BLE001
                return None
            if job.get("status") != "running":
                return _macro_summary(job)
            time.sleep(poll)
            poll = min(poll * 1.5, 10.0)
        logger.warning("timed out waiting for macro job %s summary", job_id)
        return None

    @staticmethod
    def _wait_for_ingest_summary(
        job_id: str, ingest_router: Any
    ) -> dict[str, Any] | None:
        """Poll the in-memory ingest job until it finishes; return a plain-language summary."""
        deadline = time.monotonic() + _SUMMARY_WAIT_SECONDS
        poll = 2.0
        while time.monotonic() < deadline:
            try:
                job = ingest_router._get_job(job_id)
            except Exception:  # noqa: BLE001
                return None
            if job.get("status") != "running":
                return _ingest_summary(job)
            time.sleep(poll)
            poll = min(poll * 1.5, 10.0)
        logger.warning("timed out waiting for ingest job %s summary", job_id)
        return None

    def _wait_for_run_summary(
        self, run_id: str, principal: Principal
    ) -> dict[str, Any] | None:
        """Poll the run until it reaches a terminal status; return a plain-language summary."""
        from .routers.runs import _runs

        deadline = time.monotonic() + _SUMMARY_WAIT_SECONDS
        poll = 2.0
        while time.monotonic() < deadline:
            run = _runs.get(principal, run_id)
            if run is None:
                return None
            status = run.meta.get("status")
            if status in ("succeeded", "failed", "cancelled"):
                return _run_summary(run.meta)
            time.sleep(poll)
            poll = min(poll * 1.5, 10.0)
        logger.warning("timed out waiting for run %s summary", run_id)
        return None


def _macro_summary(job: dict[str, Any]) -> dict[str, Any] | None:
    summary = job.get("summary") or {}
    return {
        "kind": "macro_job",
        "status": job.get("status"),
        "error": job.get("error"),
        "calendar_rows": summary.get("calendar_rows"),
        "indicator_rows": summary.get("indicator_rows"),
        "indicators": summary.get("indicators"),
        "warnings_count": len(summary.get("warnings") or []),
    }


def _ingest_summary(job: dict[str, Any]) -> dict[str, Any] | None:
    summary = job.get("summary") or {}
    return {
        "kind": "ingest_job",
        "status": job.get("status"),
        "error": job.get("error"),
        "restart_required": job.get("restart_required", False),
        "symbols_requested": summary.get("symbols_requested"),
        "symbols_written": summary.get("symbols_written"),
        "symbols_failed": summary.get("symbols_failed"),
        "failed_sample": summary.get("failed_sample") or [],
        "universe": summary.get("universe"),
        "start": summary.get("start"),
        "end": summary.get("end"),
        "non_trading_days_pruned": summary.get("non_trading_days_pruned"),
    }


def _run_summary(meta: dict[str, Any]) -> dict[str, Any] | None:
    metrics = meta.get("metrics") or {}
    risk = metrics.get("risk") or {}
    excess = risk.get("excess_return_with_cost") or {}
    period = metrics.get("period") or {}
    return {
        "kind": "run",
        "status": meta.get("status"),
        "error": meta.get("error") or meta.get("error_hint"),
        "name": meta.get("name"),
        "model": meta.get("model"),
        "handler": meta.get("handler"),
        "universe": meta.get("universe"),
        "benchmark": meta.get("benchmark"),
        "annual_return": excess.get("annualized_return"),
        "max_drawdown": excess.get("max_drawdown"),
        "information_ratio": excess.get("information_ratio"),
        "volatility": excess.get("volatility"),
        "period_start": period.get("start"),
        "period_end": period.get("end"),
    }


def _scalability_summary(report: dict[str, Any]) -> dict[str, Any] | None:
    """Distill a scalability_reports row into the scheduled-task output summary.

    Reads the ceilings out of the engine's ``result`` jsonb: the current
    venue's ceiling under ``result.comparison.current.ceiling_usd`` and the
    best-ranked eligible alternative under ``result.comparison.best_alternative``
    (falling back to the first alternative, which compare orders best-first).
    Keys must stay in sync with scalability_agent's engine.
    """
    result = report.get("result") or {}
    comparison = result.get("comparison") or {}
    current = comparison.get("current") or {}
    alternatives = comparison.get("alternatives") or []
    best = comparison.get("best_alternative") or (alternatives[0] if alternatives else {})
    return {
        "kind": "scalability_report",
        "current_venue": report.get("current_venue"),
        "current_ceiling": current.get("ceiling_usd"),
        "best_alternative": best.get("venue"),
        "best_alternative_ceiling": best.get("ceiling_usd"),
    }


# Module-level singleton used by main.py and the router.
_scheduler = TaskScheduler()


def get_scheduler() -> TaskScheduler:
    return _scheduler
