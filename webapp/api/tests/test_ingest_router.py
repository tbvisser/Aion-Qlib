"""The ingest job registry must never let two writers into one store.

An ingest rewrites the qlib binary store in place. Two concurrent runs would
interleave CSV writes and dump a store that looks valid but has bars from two
different universes -- the kind of corruption that only shows up as a strange
backtest months later. The API refuses the second start; these tests pin that,
and the reporting around it, without touching the network or the real store.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from webapp.api.main import app
from webapp.api.routers import ingest


def _running_job(job_id: str = "job-a") -> dict:
    return {
        "job_id": job_id,
        "status": "running",
        "started_at": "2026-01-01T00:00:00+00:00",
        "finished_at": None,
        "params": {"universe_size": 500},
        "progress": {"stage": "download", "message": "Fetching", "done": 3, "total": 10},
        "summary": None,
        "error": None,
        "restart_required": False,
    }


@pytest.fixture
def client():
    ingest._JOBS.clear()
    with TestClient(app) as c:
        yield c
    ingest._JOBS.clear()


def test_second_ingest_is_refused(client):
    ingest._JOBS["job-a"] = _running_job()

    resp = client.post("/api/data/refresh", json={"universe_size": 10})

    assert resp.status_code == 409
    assert "already running" in resp.json()["detail"]


def test_status_surfaces_the_running_job(client):
    ingest._JOBS["job-a"] = _running_job()

    body = client.get("/api/data/status").json()

    assert body["running_job"]["job_id"] == "job-a"
    assert body["running_job"]["progress"]["done"] == 3


def test_unknown_job_is_404_not_an_empty_success(client):
    assert client.get("/api/data/refresh/ghost").status_code == 404
    # The 404 must happen before the stream opens, or the UI subscribes to a
    # 200 that never emits anything.
    assert client.get("/api/data/refresh/ghost/stream").status_code == 404


def test_failure_is_reported_on_the_job_not_swallowed(client):
    ingest._JOBS["job-a"] = _running_job()

    ingest._finish("job-a", error="EODHD rejected the API key (401)")

    body = client.get("/api/data/refresh/job-a").json()
    assert body["status"] == "error"
    assert body["error"] == "EODHD rejected the API key (401)"
    assert body["progress"]["stage"] == "error"
    assert body["finished_at"] is not None


def test_stream_emits_the_terminal_state_and_closes(client):
    ingest._JOBS["job-a"] = _running_job()
    ingest._finish("job-a", summary={"symbols_written": 7}, restart_required=True)

    with client.stream("GET", "/api/data/refresh/job-a/stream") as resp:
        assert resp.headers["content-type"].startswith("text/event-stream")
        frames = [ln[len("data: "):] for ln in resp.iter_lines() if ln.startswith("data: ")]

    # A job that is already finished still gets one frame, then the stream ends
    # rather than hanging the browser's connection open.
    assert len(frames) == 1
    payload = json.loads(frames[0])
    assert payload["status"] == "done"
    assert payload["summary"]["symbols_written"] == 7
    assert payload["restart_required"] is True


def test_refresh_without_a_key_explains_itself(client, monkeypatch):
    from webapp.api import config

    settings = config.get_settings()
    monkeypatch.setattr(settings, "eodhd_api_key", "", raising=False)

    resp = client.post("/api/data/refresh", json={})

    assert resp.status_code == 400
    assert "EODHD_API_KEY" in resp.json()["detail"]
    # A refused start must not leave a phantom job behind.
    assert not ingest._JOBS
