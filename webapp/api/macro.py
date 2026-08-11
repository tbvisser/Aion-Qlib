"""Reading the curated macro series, and aligning them onto a common index.

Mirrors ``marketdata.py``: an mtime-keyed cache over per-symbol parquet, no
FastAPI, and no top-level qlib import (a few series are ETFs in the qlib store,
and importing qlib at module scope would make this unusable in a test with no
store built).

The alignment rules below are the whole point of the module. Macro series do
not share a calendar with each other or with the equity store -- ``US2Y`` has
154 weekend rows and 281 dates ``GSPC`` has never heard of -- so every number
the analytics see has to be put on one index first, and the order of operations
is not interchangeable:

1. **One reference index per request.** For run and portfolio analytics that is
   the equity curve's own dates; otherwise the qlib trading calendar.
2. **Reindex, then forward-fill with a limit.** Extra dates drop out; genuine
   gaps fill for at most ``macro_ffill_limit`` sessions. Past that the value is
   null, never a week-old level presented as today's.
3. **Never fill past the last observation.** ``reindex`` onto an index that
   runs beyond the series would carry the final print forward for ever. A stale
   cache would then flatline every driver at zero change and every correlation
   would read 0.00 -- wrong, and wrong in the direction that looks fine.
4. **Changes come off the aligned level, never the raw one.** Load, scale,
   reindex, fill, mask, *then* transform. Differencing first would date a
   three-day yield move to a session the strategy never traded.
5. **Derived series are built on the aligned frame too.** ``US10Y - US2Y`` on a
   date only one of them has is not a spread, it is a subtraction against NaN.

One more trap: the parquet carries its own ``change`` column, which is a
percentage change of the raw close. That is wrong for every yield in here -- a
move from 4.20% to 4.25% is 5 basis points, not +1.19% -- so it is ignored and
recomputed from ``close``.
"""
from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Literal, Sequence

import numpy as np
import pandas as pd

from . import macro_registry as registry
from .config import get_settings
from .macro_registry import MacroSeries

logger = logging.getLogger(__name__)

#: qlib-sourced leaves have no single file mtime to key a cache on, so they get
#: a wall-clock TTL instead. Long enough that a page load is one read; short
#: enough that an ingest lands within a coffee break.
QLIB_TTL_SECONDS = 900

_lock = threading.Lock()
#: symbol -> (mtime or fetch time, raw level series). Leaves only: a derived
#: series is a vectorised op over cached leaves, so caching it separately would
#: buy microseconds and cost an invalidation bug.
_levels: dict[str, tuple[float, pd.Series]] = {}


def reset_cache() -> None:
    """Drop the level cache. For tests that rewrite fixtures underneath us."""
    with _lock:
        _levels.clear()


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------
def _market_path(series: MacroSeries) -> Path:
    return (
        Path(get_settings().market_dir).expanduser()
        / series.asset_class
        / f"{series.resolved_symbol}.parquet"
    )


def _read_market_parquet(path: Path) -> pd.Series | None:
    try:
        df = pd.read_parquet(path, columns=["date", "close"])
    except Exception:
        # The ingest rewrites these files while the API is live, and a
        # half-written parquet raises. Same shrug as marketdata.bars.
        logger.warning("unreadable macro parquet %s", path, exc_info=True)
        return None
    if df.empty:
        return None
    # `date` is stored as a string, not a timestamp — verified on disk.
    index = pd.to_datetime(df["date"], errors="coerce").dt.normalize()
    out = pd.Series(pd.to_numeric(df["close"], errors="coerce").to_numpy(), index=index)
    out = out[out.index.notna()]
    out = out[~out.index.duplicated(keep="last")].sort_index()
    return out.astype(float) if not out.empty else None


def _load_market_level(series: MacroSeries) -> tuple[pd.Series | None, str | None]:
    """The raw level for a market-store leaf, and the symbol it came from.

    Falls back to the CBOE alias when the primary file is absent -- ``TNX`` for
    ``US10Y`` and so on, scaled by the factor in ``FALLBACK_SYMBOLS`` because
    three of the four quote ten times the yield. The substitution is returned
    so callers can report it; silently serving a different series would be the
    worst possible outcome here.
    """
    path = _market_path(series)
    if path.exists():
        level = _read_market_parquet(path)
        if level is not None:
            return level * series.scale, None

    fallback = registry.FALLBACK_SYMBOLS.get(series.key)
    if fallback is None:
        return None, None
    symbol, scale = fallback
    alt = path.parent / f"{symbol}.parquet"
    if not alt.exists():
        return None, None
    level = _read_market_parquet(alt)
    if level is None:
        return None, None
    logger.info("macro: %s served from %s (x%s)", series.key, symbol, scale)
    return level * scale, symbol


def _load_qlib_level(series: MacroSeries) -> pd.Series | None:
    """The adjusted close for a qlib-store leaf (the credit/inflation ETFs)."""
    from . import qlib_session

    state = qlib_session.init_qlib()
    if not state.get("ready"):
        return None
    try:
        from qlib.data import D

        frame = D.features([series.resolved_symbol], ["$close"])
    except Exception:
        logger.warning("qlib read failed for %s", series.resolved_symbol, exc_info=True)
        return None
    if frame is None or frame.empty:
        return None
    # D.features returns a (instrument, datetime) MultiIndex.
    out = frame["$close"]
    if isinstance(out.index, pd.MultiIndex):
        out = out.droplevel(0)
    out = pd.Series(pd.to_numeric(out, errors="coerce").to_numpy(),
                    index=pd.to_datetime(out.index).normalize())
    out = out[out.index.notna()]
    out = out[~out.index.duplicated(keep="last")].sort_index()
    return out.astype(float) * series.scale if not out.empty else None


def raw_level(key: str) -> pd.Series | None:
    """The cached, scaled, *unaligned* level for a leaf series.

    Derived series are not leaves and are refused here -- use ``level``.
    """
    series = registry.get(key)
    if series is None or series.derivation is not None:
        return None
    if series.source == "eodhd_indicator":
        return _eodhd_indicator_level(series)

    cache_key = f"{series.source}:{series.asset_class}:{series.resolved_symbol}"
    if series.source == "qlib":
        stamp = time.time() // QLIB_TTL_SECONDS
    else:
        try:
            stamp = _market_path(series).stat().st_mtime
        except OSError:
            stamp = -1.0
            fallback = registry.FALLBACK_SYMBOLS.get(series.key)
            if fallback:
                alt = _market_path(series).parent / f"{fallback[0]}.parquet"
                try:
                    stamp = alt.stat().st_mtime
                except OSError:
                    return None
            else:
                return None

    with _lock:
        hit = _levels.get(cache_key)
        if hit is not None and hit[0] == stamp:
            return hit[1]

    if series.source == "qlib":
        level = _load_qlib_level(series)
    else:
        level, _substituted = _load_market_level(series)
    if level is None:
        return None

    with _lock:
        _levels[cache_key] = (stamp, level)
    return level


def substituted_from(key: str) -> str | None:
    """The feed symbol standing in for ``key``, when one is."""
    series = registry.get(key)
    if series is None or series.source != "market":
        return None
    if _market_path(series).exists():
        return None
    fallback = registry.FALLBACK_SYMBOLS.get(series.key)
    return fallback[0] if fallback else None


def _eodhd_indicator_level(series: MacroSeries) -> pd.Series | None:
    """An annual country indicator, read from the EODHD cache.

    Imported lazily, and a cold or absent cache is None rather than an error:
    every caller already handles a missing series, and the desk is expected to
    work before anyone has run the macro refresh.
    """
    try:
        from . import macro_cache
    except ImportError:  # pragma: no cover - the cache module is optional
        return None
    return macro_cache.indicator_series(series.key)


# --------------------------------------------------------------------------
# Alignment
# --------------------------------------------------------------------------
def reference_index(
    start: str | None = None,
    end: str | None = None,
    store_key: str | None = "us",
) -> pd.DatetimeIndex:
    """The index everything in one request is put on.

    The qlib trading calendar when a store is named, because that is the set of
    days a strategy could actually have traded. Otherwise the union of the
    default basket's own dates, which is the best available answer when no
    store is built.
    """
    from . import marketdata

    if store_key:
        store = marketdata.store_for(store_key)
        if store is not None and store["exists"]:
            path = Path(store["provider_uri"]) / "calendars" / "day.txt"
            try:
                days = [l.strip() for l in path.read_text().splitlines() if l.strip()]
            except OSError:
                days = []
            if days:
                index = pd.DatetimeIndex(pd.to_datetime(days)).normalize()
                return _clip(index, start, end)

    union: pd.DatetimeIndex | None = None
    for entry in registry.default_basket():
        for leaf in registry.leaves_of(entry.key):
            level = raw_level(leaf)
            if level is None:
                continue
            union = level.index if union is None else union.union(level.index)
    if union is None:
        return pd.DatetimeIndex([])
    return _clip(pd.DatetimeIndex(union).sort_values(), start, end)


def _clip(index: pd.DatetimeIndex, start: str | None, end: str | None) -> pd.DatetimeIndex:
    if start:
        index = index[index >= pd.Timestamp(start)]
    if end:
        index = index[index <= pd.Timestamp(end)]
    return index


def _align(level: pd.Series, index: pd.DatetimeIndex, ffill_limit: int | None) -> pd.Series:
    """Rules 2 and 3: reindex, fill with a limit, never fill past the end."""
    if ffill_limit is None:
        ffill_limit = get_settings().macro_ffill_limit
    last = level.index.max()
    out = level.reindex(index)
    if ffill_limit > 0:
        out = out.ffill(limit=ffill_limit)
    # Rule 3. `reindex` alone happily carries the final print forward for ever.
    out[out.index > last] = np.nan
    return out


def level(
    key: str,
    index: pd.DatetimeIndex | None = None,
    ffill_limit: int | None = None,
) -> pd.Series:
    """The aligned level for ``key``, recursing through derivations.

    Rule 5: a derived series is computed from its legs *after* both have been
    put on ``index``, so a date only one leg has yields NaN rather than a
    subtraction against a stale value.
    """
    series = registry.get(key)
    if series is None:
        return pd.Series(dtype=float)
    if index is None:
        index = reference_index()
    if len(index) == 0:
        return pd.Series(dtype=float)

    if series.derivation is None:
        raw = raw_level(series.key)
        if raw is None:
            return pd.Series(np.nan, index=index)
        return _align(raw, index, ffill_limit)

    left = level(series.derivation.left, index, ffill_limit)
    right = level(series.derivation.right, index, ffill_limit)
    if series.derivation.kind == "spread":
        return left - right
    # log_ratio: guard both legs strictly positive. A non-positive price is a
    # data error, and log() of it is -inf, which would poison every downstream
    # statistic instead of dropping one day.
    valid = (left > 0) & (right > 0)
    out = pd.Series(np.nan, index=index)
    out[valid] = np.log(left[valid] / right[valid])
    return out


def change(
    key: str,
    index: pd.DatetimeIndex | None = None,
    ffill_limit: int | None = None,
) -> pd.Series:
    """The aligned change for ``key``: basis points, or a log return.

    The single place ``MacroSeries.transform`` is read. Rule 4 -- this operates
    on the aligned level, so the difference is always between two consecutive
    sessions of the reference calendar.
    """
    series = registry.get(key)
    if series is None:
        return pd.Series(dtype=float)
    aligned = level(key, index, ffill_limit)
    if aligned.empty:
        return aligned
    if series.transform == "diff":
        # percent -> basis points, and log_ratio -> its own difference, which
        # is the relative performance of the two legs.
        scale = 100.0 if series.unit == "percent" else 1.0
        return aligned.diff() * scale
    with np.errstate(divide="ignore", invalid="ignore"):
        positive = aligned.where(aligned > 0)
        return np.log(positive).diff()


def levels(
    keys: Sequence[str],
    index: pd.DatetimeIndex | None = None,
    ffill_limit: int | None = None,
) -> pd.DataFrame:
    if index is None:
        index = reference_index()
    return pd.DataFrame({k: level(k, index, ffill_limit) for k in keys}, index=index)


def changes(
    keys: Sequence[str],
    index: pd.DatetimeIndex | None = None,
    ffill_limit: int | None = None,
) -> pd.DataFrame:
    if index is None:
        index = reference_index()
    return pd.DataFrame({k: change(k, index, ffill_limit) for k in keys}, index=index)


def change_unit(key: str) -> Literal["bps", "log"] | None:
    series = registry.get(key)
    return series.change_unit if series else None


# --------------------------------------------------------------------------
# Availability
# --------------------------------------------------------------------------
def coverage(key: str) -> dict:
    """What is actually on disk for ``key``, without aligning anything."""
    series = registry.get(key)
    if series is None:
        return {"available": False, "reason": f"unknown series {key!r}"}

    leaves = registry.leaves_of(series.key)
    missing = [leaf for leaf in leaves if raw_level(leaf) is None]
    if missing:
        return {
            "available": False,
            "reason": (
                f"no data on disk for {', '.join(missing)}"
                if len(missing) > 1
                else f"no data on disk for {missing[0]}"
            ),
            "source": series.source,
        }

    spans = [raw_level(leaf) for leaf in leaves]
    first = max(s.index.min() for s in spans)
    last = min(s.index.max() for s in spans)
    return {
        "available": True,
        "reason": None,
        "source": series.source,
        "first": first.strftime("%Y-%m-%d"),
        "last": last.strftime("%Y-%m-%d"),
        "n": int(min(len(s) for s in spans)),
        "substituted_from": substituted_from(series.key),
    }


def catalog() -> list[dict]:
    """Every offered series with its availability, for /api/macro/series."""
    out = []
    for series in registry.offered():
        cov = coverage(series.key)
        out.append({
            "key": series.key,
            "label": series.label,
            "group": series.group,
            "unit": series.unit,
            "change_unit": series.change_unit,
            "source": series.source,
            "derived": series.derivation is not None,
            "in_basket": series.in_basket,
            "daily_ok": series.daily_ok,
            "note": series.note,
            **cov,
        })
    return out


def resample(
    points: pd.Series,
    freq: Literal["daily", "weekly", "monthly"] = "daily",
) -> pd.Series:
    """Last observation per period. Daily is a no-op."""
    if freq == "daily" or points.empty:
        return points
    rule = {"weekly": "W-FRI", "monthly": "ME"}[freq]
    return points.resample(rule).last().dropna()
