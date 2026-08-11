"""Liveness plus a description of what the data layer actually has.

The UI shows this on the dashboard: which store is mounted, its date range, and
how many instruments it covers -- so "no data" is never a silent empty chart.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from .. import qlib_session
from ..config import get_settings

router = APIRouter()


@router.get("/health")
def health() -> dict:
    settings = get_settings()
    state = qlib_session.init_qlib()

    payload: dict = {
        "status": "ok" if state["ready"] else "degraded",
        "qlib": {
            "ready": state["ready"],
            "provider_uri": state["provider_uri"],
            "region": state["region"],
            "error": state["error"],
        },
        "services": {
            "eodhd": bool(settings.eodhd_api_key),
            "openrouter": bool(settings.openrouter_api_key),
        },
    }

    if state["ready"]:
        payload["qlib"].update(_store_summary(state["provider_uri"]))
        payload["qlib"]["is_fallback"] = state["provider_uri"] == settings.fallback_provider_uri

    return payload


def _store_summary(provider_uri: str) -> dict:
    """Date range and instrument count, read straight off the store."""
    from qlib.data import D

    summary: dict = {"qlib_version": _qlib_version()}
    try:
        calendar = D.calendar()
        if len(calendar):
            summary["start_date"] = str(calendar[0].date())
            summary["end_date"] = str(calendar[-1].date())
            summary["trading_days"] = len(calendar)
    except Exception as exc:  # pragma: no cover - depends on local data
        summary["calendar_error"] = str(exc)

    try:
        instruments_dir = Path(provider_uri).expanduser() / "instruments"
        summary["universes"] = sorted(p.stem for p in instruments_dir.glob("*.txt"))
        all_txt = instruments_dir / "all.txt"
        if all_txt.exists():
            with all_txt.open() as fh:
                summary["instrument_count"] = sum(1 for line in fh if line.strip())
    except Exception as exc:  # pragma: no cover
        summary["instruments_error"] = str(exc)

    return summary


def _qlib_version() -> str:
    import qlib

    return getattr(qlib, "__version__", "unknown")
