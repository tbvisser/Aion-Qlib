"""Tests for the background EODHD macro auto-refresh."""
from __future__ import annotations

from webapp.api import macro_auto_refresh


def test_run_once_refreshes_when_cache_is_stale(monkeypatch):
    """A stale cache triggers the EODHD-backed refresh path."""
    calls = []

    def fake_run_macro_refresh(api_key, macro_dir, **kwargs):
        calls.append((api_key, str(macro_dir)))
        return {"calendar_rows": 10, "indicator_rows": 5, "warnings": []}

    monkeypatch.setattr(macro_auto_refresh, "_cache_is_stale", lambda: True)
    monkeypatch.setattr(
        "webapp.ingest.eodhd.run_macro_refresh", fake_run_macro_refresh
    )

    summary = macro_auto_refresh._run_once()
    assert summary is not None
    assert summary["calendar_rows"] == 10
    assert len(calls) == 1


def test_run_once_logs_and_survives_eodhd_error(monkeypatch):
    """An EODHD error is caught and reported as None, not an unhandled exception."""
    from webapp.ingest.eodhd import EodhdError

    def fake_run_macro_refresh(*_args, **_kwargs):
        raise EodhdError("EODHD plan error")

    monkeypatch.setattr(
        "webapp.ingest.eodhd.run_macro_refresh", fake_run_macro_refresh
    )

    assert macro_auto_refresh._run_once() is None


def test_auto_refresh_can_be_started_and_stopped(monkeypatch):
    """The daemon thread starts and stops cleanly without touching the network."""
    monkeypatch.setattr(macro_auto_refresh, "_cache_is_stale", lambda: False)

    service = macro_auto_refresh.MacroAutoRefresh(interval_seconds=3600)
    service.start()
    assert service._thread is not None
    assert service._thread.is_alive()
    service.stop()
    # The thread should exit quickly because we signal the stop event.
    service._thread.join(timeout=1)
    assert not service._thread.is_alive()
