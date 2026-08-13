"""The /api/activity aggregate: three job surfaces, one vocabulary.

Seeds the sibling routers' in-memory ``_JOBS`` registries directly, the same
way test_ingest_router.py and test_macro_router.py do, and monkeypatches the
run manager's ``list`` — the feed itself must not care where items came from.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from webapp.api.main import app
from webapp.api.routers import ingest as ingest_router
from webapp.api.routers import macro as macro_router
from webapp.api.routers import runs as runs_router


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def clean_jobs():
    ingest_router._JOBS.clear()
    macro_router._JOBS.clear()
    yield
    ingest_router._JOBS.clear()
    macro_router._JOBS.clear()


@pytest.fixture
def no_runs(monkeypatch):
    monkeypatch.setattr(runs_router._runs, "list", lambda principal, limit=100: [])


def _job(job_id: str, status: str, started: str, **extra) -> dict:
    return {
        "job_id": job_id, "status": status, "started_at": started,
        "finished_at": None if status == "running" else started,
        "params": extra.pop("params", {}),
        "progress": extra.pop("progress",
                              {"stage": "queued", "message": "", "done": 0, "total": 0}),
        "summary": None, "error": extra.pop("error", None), **extra,
    }


def _run_meta(run_id: str, status: str, created: str) -> dict:
    return {
        "id": run_id, "name": f"run {run_id}", "kind": "backtest",
        "strategy_id": None, "status": status, "phase": "Done",
        "created_at": created, "started_at": created, "finished_at": created,
        "error": None, "error_hint": None,
    }


def test_empty_feed_is_ok(client, no_runs):
    resp = client.get("/api/activity")
    assert resp.status_code == 200
    body = resp.json()
    assert body["items"] == []
    assert body["generated_at"]


def test_normalizes_job_statuses(client, no_runs):
    ingest_router._JOBS["i1"] = _job(
        "i1", "running", "2026-08-11T10:00:00+00:00",
        params={"universe_size": 500, "mode": "update"},
        progress={"stage": "prices", "message": "AAPL", "done": 3, "total": 500},
        restart_required=False,
    )
    macro_router._JOBS["m1"] = _job(
        "m1", "done", "2026-08-11T09:00:00+00:00", params={"what": "calendar"})
    macro_router._JOBS["m2"] = _job(
        "m2", "error", "2026-08-11T08:00:00+00:00", error="boom")

    items = {i["id"]: i for i in client.get("/api/activity").json()["items"]}
    assert set(items) == {"ingest:i1", "macro:m1", "macro:m2"}

    ingest = items["ingest:i1"]
    assert ingest["status"] == "running"
    assert ingest["kind"] == "ingest"
    assert ingest["title"] == "Data refresh · 500 symbols (update)"
    assert ingest["progress"] == {"stage": "prices", "message": "AAPL",
                                  "done": 3, "total": 500}
    assert ingest["restart_required"] is False

    assert items["macro:m1"]["status"] == "succeeded"
    assert items["macro:m1"]["kind"] == "macro_refresh"
    assert items["macro:m1"]["title"] == "Macro refresh · calendar"
    assert items["macro:m2"]["status"] == "failed"
    assert items["macro:m2"]["error"] == "boom"


def test_merges_and_sorts_newest_first(client, monkeypatch):
    ingest_router._JOBS["i1"] = _job("i1", "done", "2026-08-11T10:00:00+00:00")
    macro_router._JOBS["m1"] = _job("m1", "done", "2026-08-11T12:00:00+00:00")
    monkeypatch.setattr(
        runs_router._runs, "list",
        lambda principal, limit=100: [
            _run_meta("r1", "succeeded", "2026-08-11T11:00:00+00:00")],
    )

    ids = [i["id"] for i in client.get("/api/activity").json()["items"]]
    assert ids == ["macro:m1", "run:r1", "ingest:i1"]


def test_limit_truncates(client, monkeypatch):
    for hour in range(5):
        macro_router._JOBS[f"m{hour}"] = _job(
            f"m{hour}", "done", f"2026-08-11T0{hour}:00:00+00:00")
    monkeypatch.setattr(runs_router._runs, "list", lambda principal, limit=100: [])

    items = client.get("/api/activity", params={"limit": 2}).json()["items"]
    assert [i["id"] for i in items] == ["macro:m4", "macro:m3"]
