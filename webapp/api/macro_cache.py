"""Reading the cached EODHD macro: the economic calendar and country indicators.

The write side lives in ``ingest/eodhd.py``. This is the read side, and it
follows the same rule as ``/api/bars``: **a GET never fetches**. Everything
here serves whatever is on disk and reports how old it is. An endpoint that
quietly made 120 network calls under a page load is exactly the surprise this
codebase avoids, and a cold cache is a stated ``available: false`` rather than
a 404 pretending the feature does not exist.

Cached behind file mtime, like ``marketdata.load_catalog`` -- the refresh job
rewrites these files while the API is up, and serving a stale calendar would
hide the release the user just waited for.
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path

import pandas as pd

from .config import get_settings

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_cache: dict[str, tuple[float, pd.DataFrame]] = {}


def reset_cache() -> None:
    with _lock:
        _cache.clear()


def _macro_dir() -> Path:
    return Path(get_settings().macro_dir).expanduser()


def _read_cached(path: Path) -> pd.DataFrame | None:
    """A parquet behind an mtime cache. None when absent or unreadable."""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None

    key = str(path)
    with _lock:
        hit = _cache.get(key)
        if hit is not None and hit[0] == mtime:
            return hit[1]
    try:
        frame = pd.read_parquet(path)
    except Exception:
        # The refresh job rewrites this file atomically, so a partial read
        # should be impossible -- but an unreadable cache must never 500.
        logger.warning("unreadable macro cache %s", path, exc_info=True)
        return None
    with _lock:
        _cache[key] = (mtime, frame)
    return frame


def _read_meta(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def _staleness(meta: dict, ttl_seconds: float) -> dict:
    fetched = meta.get("fetched_at")
    if not fetched:
        return {"fetched_at": None, "age_seconds": None, "stale": True}
    try:
        stamp = pd.Timestamp(fetched)
    except ValueError:
        return {"fetched_at": fetched, "age_seconds": None, "stale": True}
    now = pd.Timestamp.utcnow()
    if stamp.tzinfo is None:
        stamp = stamp.tz_localize("UTC")
    age = float((now - stamp).total_seconds())
    return {
        "fetched_at": stamp.isoformat(),
        "age_seconds": age,
        "stale": age > ttl_seconds,
    }


# --------------------------------------------------------------------------
# Economic calendar
# --------------------------------------------------------------------------
def calendar_frame() -> pd.DataFrame | None:
    from webapp.ingest import eodhd

    return _read_cached(eodhd.macro_calendar_path(_macro_dir()))


def calendar_status() -> dict:
    settings = get_settings()
    meta = _read_meta(_macro_dir() / "calendar" / "_meta.json")
    frame = calendar_frame()
    status = {
        "available": frame is not None and not frame.empty,
        "rows": int(len(frame)) if frame is not None else 0,
        **_staleness(meta, settings.macro_calendar_ttl_hours * 3600),
        "countries": meta.get("countries", []),
        "from": meta.get("from"),
        "to": meta.get("to"),
    }
    if not status["available"]:
        status["reason"] = (
            "no economic calendar cached yet — run POST /api/macro/refresh"
        )
    return status


def releases(
    start: str | None = None,
    end: str | None = None,
    country: str = "",
    event_type: str = "",
    limit: int = 500,
) -> list[dict]:
    """Cached releases in a window, oldest first.

    ``actual`` is null on a future release and on a past one nobody has filed
    yet; the two are distinguished by the date, not by inventing a zero.
    """
    frame = calendar_frame()
    if frame is None or frame.empty:
        return []
    out = frame
    if start:
        out = out[out["date"] >= pd.Timestamp(start)]
    if end:
        out = out[out["date"] <= pd.Timestamp(end)]
    if country:
        out = out[out["country"].str.upper() == country.upper()]
    if event_type:
        wanted = event_type.lower()
        out = out[
            (out["event_key"].str.lower() == wanted)
            | (out["type"].str.lower() == wanted)
        ]
    out = out.sort_values(["date", "country", "type"]).head(limit)
    return [_release_row(r) for _, r in out.iterrows()]


def _clean(value) -> float | None:
    if value is None or pd.isna(value):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if pd.notna(number) and abs(number) != float("inf") else None


def _text(value) -> str | None:
    if value is None or pd.isna(value):
        return None
    return str(value)


def _release_row(row) -> dict:
    return {
        "date": row["date"].strftime("%Y-%m-%d"),
        "time": _text(row.get("time")),
        "country": _text(row.get("country")),
        "type": _text(row.get("type")),
        "event_key": _text(row.get("event_key")),
        "period": _text(row.get("period")),
        "comparison": _text(row.get("comparison")),
        "actual": _clean(row.get("actual")),
        "estimate": _clean(row.get("estimate")),
        "previous": _clean(row.get("previous")),
        "surprise": _clean(row.get("surprise")),
        "is_forecast": bool(row.get("is_forecast")),
    }


def event_types(country: str = "", min_count: int = 4) -> list[dict]:
    """Distinct release types in the cache, commonest first.

    Populates the event-study picker from what is actually there, so the UI
    cannot offer a study of a release nobody has data for.
    """
    frame = calendar_frame()
    if frame is None or frame.empty:
        return []
    out = frame
    if country:
        out = out[out["country"].str.upper() == country.upper()]
    # Only releases with an `actual` can be studied.
    out = out[out["actual"].notna()]
    grouped = (
        out.groupby(["country", "type", "event_key"], dropna=False)
        .size().reset_index(name="n")
    )
    grouped = grouped[grouped["n"] >= min_count].sort_values("n", ascending=False)
    return [
        {"country": _text(r["country"]), "type": _text(r["type"]),
         "event_key": _text(r["event_key"]), "n": int(r["n"])}
        for _, r in grouped.iterrows()
    ]


def release_series(
    event_type: str,
    country: str = "",
    column: str = "actual",
) -> pd.Series:
    """One release type as a session-shifted ``date -> value`` series.

    A release timestamped after ``macro_session_shift_hour`` UTC belongs to the
    next session -- a 21:30 print lands after the US close, so the first
    tradeable reaction is the following day. Making that an explicit rule beats
    letting the mapping happen by accident.

    **Indexed on the release date, never on the reference period.** The August
    CPI reference period prints in September; keying on ``period`` would make
    the August figure visible on 1 August and turn every historical regime read
    into a lookahead artefact.

    Duplicates on one shifted date -- a revision, or the mom and yoy rows of the
    same print -- keep the last row. Callers wanting a specific basis should
    pass the qualified ``event_key`` (``inflation_rate__yoy``), not the bare
    type.
    """
    frame = calendar_frame()
    if frame is None or frame.empty:
        return pd.Series(dtype="float64")
    wanted = (event_type or "").lower()
    out = frame[
        (frame["event_key"].str.lower() == wanted)
        | (frame["type"].str.lower() == wanted)
    ]
    if country:
        out = out[out["country"].str.upper() == country.upper()]
    out = out[out[column].notna()]
    if out.empty:
        return pd.Series(dtype="float64")

    shift_hour = get_settings().macro_session_shift_hour
    hours = pd.to_numeric(
        out["time"].astype("string").str.slice(0, 2), errors="coerce"
    ).fillna(0)
    dates = pd.DatetimeIndex(
        out["date"] + pd.to_timedelta((hours >= shift_hour).astype(int), unit="D")
    ).normalize()

    series = pd.Series(
        pd.to_numeric(out[column], errors="coerce").to_numpy(), index=dates
    ).sort_index()
    return series[~series.index.duplicated(keep="last")].dropna()


def release_dates(event_type: str, country: str = "") -> list[pd.Timestamp]:
    """Session-shifted dates for one release type, for the event study."""
    return list(release_series(event_type, country).index)


def calendar_mtime() -> float | None:
    """The calendar cache's mtime, for keying derived caches.

    Exposed here rather than letting callers resolve the path themselves, so
    the location stays owned by one module.
    """
    from webapp.ingest import eodhd

    try:
        return eodhd.macro_calendar_path(_macro_dir()).stat().st_mtime
    except OSError:
        return None


# --------------------------------------------------------------------------
# Country indicators
# --------------------------------------------------------------------------
def indicator_status() -> dict:
    settings = get_settings()
    meta = _read_meta(_macro_dir() / "indicators" / "_meta.json")
    root = _macro_dir() / "indicators"
    files = list(root.glob("*/*.parquet")) if root.is_dir() else []
    status = {
        "available": bool(files),
        "series": len(files),
        **_staleness(meta, settings.macro_indicator_ttl_days * 86400),
        "countries": meta.get("countries", []),
    }
    if not status["available"]:
        status["reason"] = (
            "no country indicators cached yet — run POST /api/macro/refresh"
        )
    return status


def indicators(country: str = "USA") -> list[dict]:
    """Every cached annual indicator for a country, newest value first.

    The year is part of every value and is never dropped: an annual print
    rendered as "current" is the classic way this kind of data lies.
    """
    from webapp.ingest import eodhd

    root = _macro_dir() / "indicators" / country.upper()
    if not root.is_dir():
        return []
    out = []
    for path in sorted(root.glob("*.parquet")):
        frame = _read_cached(path)
        if frame is None or frame.empty:
            continue
        slug = path.stem
        spec = eodhd.MACRO_INDICATORS.get(slug)
        frame = frame.sort_values("date")
        history = [
            {"year": int(r["date"].year), "value": _clean(r["value"])}
            for _, r in frame.iterrows()
            if _clean(r["value"]) is not None
        ]
        if not history:
            continue
        out.append({
            "key": slug,
            "label": spec.label if spec else str(frame["indicator"].iloc[-1]),
            "group": spec.group if spec else "other",
            "unit": spec.unit if spec else "",
            "frequency": spec.frequency if spec else "annual",
            "country": country.upper(),
            "latest_year": history[-1]["year"],
            "latest": history[-1]["value"],
            "previous": history[-2]["value"] if len(history) > 1 else None,
            "history": history,
        })
    return out


def indicator_series(registry_key: str) -> pd.Series | None:
    """A registry-declared annual indicator, as a daily-indexable series.

    Only ``CPI_YOY_US`` uses this today. The values step once a year, which is
    why the registry marks these ``daily_ok=False`` and bans them from the
    regression -- they are honest as a chart and meaningless as a regressor.
    """
    mapping = {"CPI_YOY_US": ("USA", "inflation_consumer_prices_annual")}
    target = mapping.get(registry_key)
    if target is None:
        return None
    from webapp.ingest import eodhd

    frame = _read_cached(eodhd.macro_indicator_path(_macro_dir(), *target))
    if frame is None or frame.empty:
        return None
    series = pd.Series(
        pd.to_numeric(frame["value"], errors="coerce").to_numpy(),
        index=pd.DatetimeIndex(frame["date"]).normalize(),
    ).sort_index()
    return series.dropna() if not series.empty else None
