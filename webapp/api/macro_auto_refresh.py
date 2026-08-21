"""Background EODHD macro refresh for the API process.

The macro desk's read paths never fetch from the network on a GET. That keeps
page loads fast and predictable, but it means someone has to write the cache.
This module runs a daemon thread that refreshes the cached EODHD macro calendar
and country indicators every two hours, independent of any user or admin call.

It reuses the same ingest path as POST /api/macro/refresh and resets the same
in-memory caches, so the next API request after a refresh sees new data.
"""
from __future__ import annotations

import logging
import os
import threading
import time

from .config import get_settings
from . import macro_cache, macro_regime

logger = logging.getLogger(__name__)

# Two hours, per the Macro Desk refresh requirement.
DEFAULT_INTERVAL_SECONDS = 2 * 60 * 60


def _in_test() -> bool:
    """True when pytest is driving the process.

    The auto-refresh thread must not make real EODHD network calls during
    unit tests that happen to spin up the FastAPI app.
    """
    return bool(os.environ.get("PYTEST_CURRENT_TEST"))


def _run_once() -> dict | None:
    """One refresh cycle. Returns the ingest summary, or None if skipped."""
    settings = get_settings()
    if not settings.eodhd_api_key:
        logger.debug("EODHD_API_KEY is not set; skipping background macro refresh")
        return None

    # Lazy import: ingest/eodhd pulls httpx/pandas and is only needed when work
    # actually runs, not at module import time.
    from webapp.ingest.eodhd import EodhdError, run_macro_refresh

    logger.info("starting background macro refresh from EODHD")
    try:
        summary = run_macro_refresh(
            settings.eodhd_api_key,
            settings.macro_dir,
            start="2015-01-01",
            end=None,
            what="all",
            event_countries=settings.event_countries,
            indicator_countries=settings.indicator_countries,
        )
    except EodhdError as exc:
        logger.warning("background macro refresh failed from EODHD: %s", exc)
        return None
    except Exception:  # noqa: BLE001
        logger.exception("background macro refresh crashed")
        return None

    # Derived state is cached against the old calendar mtime; drop it so the
    # next request recomputes from the new files.
    macro_cache.reset_cache()
    from . import macro as macro_module

    macro_module.reset_cache()
    macro_regime.reset_cache()

    logger.info(
        "background macro refresh finished: %d calendar rows, %d indicator rows",
        summary.get("calendar_rows", 0),
        summary.get("indicator_rows", 0),
    )
    return summary


class MacroAutoRefresh:
    """Owns the daemon thread that refreshes macro data on a fixed interval."""

    def __init__(self, interval_seconds: float = DEFAULT_INTERVAL_SECONDS) -> None:
        self._interval = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Start the background refresh loop. Safe to call more than once."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="macro-auto-refresh", daemon=True
        )
        self._thread.start()
        logger.info(
            "macro auto-refresh started (interval=%.0fs, immediate=%s)",
            self._interval,
            _cache_is_stale(),
        )

    def stop(self) -> None:
        """Signal the loop to exit and wait briefly for it to finish."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self._interval + 1)

    def refresh_now(self) -> dict | None:
        """Run one refresh cycle synchronously."""
        return _run_once()

    def _loop(self) -> None:
        # Run immediately if the cache is missing or stale, so a newly started
        # API does not serve 11-day-old data until the first interval fires.
        # Skip the immediate run under pytest to avoid real network calls.
        if not _in_test() and _cache_is_stale():
            self.refresh_now()

        while not self._stop.wait(timeout=self._interval):
            if _in_test():
                continue
            self.refresh_now()


def _cache_is_stale() -> bool:
    """True when the calendar cache is missing or older than the TTL."""
    status = macro_cache.calendar_status()
    if not status.get("available"):
        return True
    return bool(status.get("stale"))


# Module-level singleton started/stopped from main.py.
_auto_refresh = MacroAutoRefresh()


def start_macro_auto_refresh() -> None:
    _auto_refresh.start()


def stop_macro_auto_refresh() -> None:
    _auto_refresh.stop()
