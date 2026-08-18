"""Tests for /api/agenda/outlook and its context helpers.

The LLM call is always mocked: these tests prove the date arithmetic, context
assembly and caching behaviour without an OpenRouter key.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from webapp.api import agenda_outlook
from webapp.api.main import app
from webapp.api.routers import ingest as ingest_router
from webapp.api.routers import macro as macro_router


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


# ---------------------------------------------------------------------------
# Date arithmetic
# ---------------------------------------------------------------------------

def test_outlook_window_day():
    assert agenda_outlook.outlook_window("day", "2026-08-13") == ("2026-08-13", "2026-08-13")


def test_outlook_window_week():
    start, end = agenda_outlook.outlook_window("week", "2026-08-13")  # Thursday
    assert start == "2026-08-10"  # Monday
    assert end == "2026-08-16"    # Sunday


def test_outlook_window_month():
    start, end = agenda_outlook.outlook_window("month", "2026-08-13")
    assert start == "2026-08-01"
    assert end == "2026-08-31"


def test_outlook_expires_at_end_of_day():
    expires = agenda_outlook.outlook_expires_at("day", "2026-08-13")
    assert expires.isoformat() == "2026-08-13T23:59:59+00:00"


def test_outlook_expires_at_end_of_week():
    expires = agenda_outlook.outlook_expires_at("week", "2026-08-13")  # Thursday -> Sunday
    assert expires.isoformat() == "2026-08-16T23:59:59+00:00"


def test_outlook_expires_at_end_of_month():
    expires = agenda_outlook.outlook_expires_at("month", "2026-08-13")
    assert expires.isoformat() == "2026-08-31T23:59:59+00:00"


def test_outlook_expires_at_handles_leap_year():
    expires = agenda_outlook.outlook_expires_at("month", "2024-02-15")
    assert expires.isoformat() == "2024-02-29T23:59:59+00:00"


# ---------------------------------------------------------------------------
# Context assembly
# ---------------------------------------------------------------------------

def test_activity_context_filters_by_finished_at():
    items = [
        {"id": "run:a", "kind": "run", "status": "succeeded", "finished_at": "2026-08-13T10:00:00+00:00", "title": "A"},
        {"id": "run:b", "kind": "run", "status": "failed", "finished_at": "2026-08-10T10:00:00+00:00", "title": "B"},
        {"id": "run:c", "kind": "run", "status": "running", "finished_at": None, "title": "C"},
    ]
    ctx = agenda_outlook._activity_context(items, "2026-08-13", "2026-08-13")
    assert len(ctx["runs"]) == 1
    assert ctx["runs"][0]["title"] == "A"
    assert ctx["failed_count"] == 0


def test_activity_context_counts_failures():
    items = [
        {"id": "run:a", "kind": "run", "status": "failed", "finished_at": "2026-08-13T10:00:00+00:00", "title": "A"},
        {"id": "ingest:b", "kind": "ingest", "status": "succeeded", "finished_at": "2026-08-13T11:00:00+00:00", "title": "B"},
    ]
    ctx = agenda_outlook._activity_context(items, "2026-08-13", "2026-08-13")
    assert ctx["failed_count"] == 1
    assert len(ctx["jobs"]) == 1


# ---------------------------------------------------------------------------
# Fallback summary
# ---------------------------------------------------------------------------

def test_fallback_summary_mentions_headlines():
    context = {
        "calendar": {"available": True, "events": [
            {"type": "CPI", "importance": "headline", "date": "2026-08-13"},
            {"type": "Claims", "importance": "standard", "date": "2026-08-13"},
        ]},
        "activity": {"runs": [], "jobs": [], "failed_count": 0},
        "rebalances": [],
        "signals": [],
        "regime": {"available": False, "lenses": []},
    }
    summary = agenda_outlook._fallback_summary(context, "day", "2026-08-13", "2026-08-13")
    assert "headline" in summary
    assert "CPI" in summary


def test_fallback_summary_handles_uncached_calendar():
    context = {
        "calendar": {"available": False, "reason": "not cached"},
        "activity": {"runs": [], "jobs": [], "failed_count": 0},
        "rebalances": [],
        "signals": [],
        "regime": {"available": False, "lenses": []},
    }
    summary = agenda_outlook._fallback_summary(context, "day", "2026-08-13", "2026-08-13")
    assert "not cached" in summary


# ---------------------------------------------------------------------------
# Router endpoint
# ---------------------------------------------------------------------------

def test_endpoint_returns_summary_without_llm_when_no_key(client, monkeypatch):
    monkeypatch.setattr("webapp.api.routers.agenda.activity_feed",
                        lambda **kwargs: {"items": [], "generated_at": "2026-08-13T00:00:00+00:00"})
    monkeypatch.setattr("webapp.api.routers.agenda.get_settings",
                        lambda: type("S", (), {"openrouter_api_key": "", "openrouter_model": "x", "database_url": ""})())

    resp = client.get("/api/agenda/outlook", params={"scope": "day", "date": "2026-08-13"})
    assert resp.status_code == 200
    body = resp.json()
    assert "summary" in body
    assert body["cached"] is False  # fallback is generated on the fly, not cached


def test_endpoint_caches_llm_response(client, monkeypatch):
    """A generated summary is returned and flagged as freshly generated."""
    monkeypatch.setattr("webapp.api.routers.agenda.activity_feed",
                        lambda **kwargs: {"items": [], "generated_at": "2026-08-13T00:00:00+00:00"})

    class FakeSettings:
        openrouter_api_key = "fake"
        openrouter_model = "fake-model"
        database_url = ""

    monkeypatch.setattr("webapp.api.routers.agenda.get_settings", FakeSettings)
    monkeypatch.setattr("webapp.api.agenda_outlook._call_openrouter", lambda *a, **k: "- Market is quiet.")

    resp = client.get("/api/agenda/outlook", params={"scope": "day", "date": "2026-08-13"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["summary"] == "- Market is quiet."
    assert body["cached"] is False
    assert body["expires_at"].startswith("2026-08-13T23:59:59")


def test_endpoint_serves_cached_summary_on_second_call(client, monkeypatch):
    """A fresh outlook is cached and reused for the same (scope, date)."""
    monkeypatch.setattr("webapp.api.routers.agenda.activity_feed",
                        lambda **kwargs: {"items": [], "generated_at": "2030-08-13T00:00:00+00:00"})

    class FakeSettings:
        openrouter_api_key = "fake"
        openrouter_model = "fake-model"
        database_url = "postgres://fake"

    monkeypatch.setattr("webapp.api.routers.agenda.get_settings", FakeSettings)

    llm_calls: list[int] = []

    def fake_openrouter(*a, **k):
        llm_calls.append(1)
        return f"- Generation {len(llm_calls)}."

    monkeypatch.setattr("webapp.api.agenda_outlook._call_openrouter", fake_openrouter)

    rows: list[dict] = []

    class FakeCursor:
        def __init__(self):
            self._query: str | None = None
            self._params: tuple | None = None

        def execute(self, query: str, params: tuple | None = None):
            self._query = query
            self._params = params

        def fetchone(self):
            if self._query and "SELECT" in self._query:
                return rows[-1] if rows else None
            return None

    class FakeTx:
        def __init__(self, user_id: str):
            self.user_id = user_id
            self._cur: FakeCursor | None = None

        def __enter__(self):
            self._cur = FakeCursor()
            return self._cur

        def __exit__(self, exc_type, exc, tb):
            if self._cur and self._cur._query and "INSERT" in self._cur._query:
                keys = ["scope", "date", "summary", "generated_at", "expires_at"]
                rows.append(dict(zip(keys, self._cur._params)))
            return False

    monkeypatch.setattr("webapp.api.routers.agenda.user_tx", FakeTx)

    resp1 = client.get("/api/agenda/outlook", params={"scope": "day", "date": "2030-08-13"})
    assert resp1.status_code == 200
    body1 = resp1.json()
    assert body1["cached"] is False
    assert body1["summary"] == "- Generation 1."

    resp2 = client.get("/api/agenda/outlook", params={"scope": "day", "date": "2030-08-13"})
    assert resp2.status_code == 200
    body2 = resp2.json()
    assert body2["cached"] is True
    assert body2["summary"] == "- Generation 1."
    assert len(llm_calls) == 1
