"""The symbol catalog, and bars for assets qlib does not hold.

Two responsibilities, both of which exist because the qlib store is not enough:

* **The catalog** is ticker -> name/class/exchange/store. The qlib store holds
  tickers and nothing else, so without this the UI can only match substrings of
  a ticker -- searching "apple" finds nothing.
* **The market store** serves crypto, FX and indices. They do not share the
  .US 252-day trading calendar, and qlib keeps one calendar per store, so they
  cannot live in the qlib store without either losing their weekend bars or
  corrupting the equity calendar every backtest depends on. They are plain
  per-symbol parquet here, and are never queried by qlib.
"""
from __future__ import annotations

import json
import logging
import math
import threading
from pathlib import Path

import pandas as pd

from .config import get_settings

logger = logging.getLogger(__name__)

BAR_FIELDS = ("open", "high", "low", "close", "volume", "factor", "change")

_lock = threading.Lock()
_cache: dict | None = None
_cache_mtime: float | None = None


def _safe_name(symbol: str) -> str:
    """Mirrors ingest.eodhd._safe_name — identity for ordinary tickers."""
    import re

    return re.sub(r'[/\\:*?"<>|]', "_", symbol)


def _catalog_path() -> Path:
    return Path(get_settings().catalog_path).expanduser()


def load_catalog() -> dict:
    """The catalog, reloaded when the ingest rewrites it.

    Keyed on mtime rather than cached forever: an ingest run replaces this file
    while the API is up, and serving a stale catalog would hide every asset the
    user just waited an hour to download.
    """
    global _cache, _cache_mtime
    path = _catalog_path()
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return {"count": 0, "classes": [], "by_symbol": {}, "symbols": []}

    with _lock:
        if _cache is not None and _cache_mtime == mtime:
            return _cache
        try:
            raw = json.loads(path.read_text())
        except (OSError, ValueError) as exc:
            logger.warning("unreadable catalog %s: %s", path, exc)
            return {"count": 0, "classes": [], "by_symbol": {}, "symbols": []}

        symbols = _dedupe(raw.get("symbols", []))
        _cache = {
            "count": len(symbols),
            "classes": sorted({e["c"] for e in symbols}),
            "symbols": symbols,
            "by_symbol": {e["s"].upper(): e for e in symbols},
        }
        _cache_mtime = mtime
        return _cache


# A ticker means one asset. EODHD reuses codes across exchanges -- NOK is both
# Nokia and the Norwegian Krone, DRV a Direxion ETF and a coin, JPY/USD both FX
# codes and ETFs. The qlib store can only hold one of each, so the one that owns
# the ticker there wins and the other is dropped rather than left to shadow it.
_CLASS_PRIORITY = {"equity": 0, "etf": 1, "index": 2, "crypto": 3, "fx": 4}


def _dedupe(symbols: list[dict]) -> list[dict]:
    best: dict[str, dict] = {}
    for e in symbols:
        key = e["s"].upper()
        rank = (0 if e.get("st") == "qlib" else 1, _CLASS_PRIORITY.get(e["c"], 9))
        current = best.get(key)
        if current is None or rank < current[0]:
            best[key] = (rank, e)
    dropped = len(symbols) - len(best)
    if dropped:
        logger.info("catalog: %d duplicate tickers resolved to one asset each", dropped)
    return sorted((v[1] for v in best.values()), key=lambda e: (e["c"], e["s"]))


def entry_for(symbol: str) -> dict | None:
    return load_catalog()["by_symbol"].get(symbol.upper())


def class_counts() -> list[dict]:
    counts: dict[str, int] = {}
    for e in load_catalog()["symbols"]:
        counts[e["c"]] = counts.get(e["c"], 0) + 1
    return [{"asset_class": k, "count": v} for k, v in sorted(counts.items())]


def _rank(entry: dict, needle: str) -> int:
    """Lower sorts first: exact ticker, ticker prefix, name prefix, then any."""
    sym = entry["s"].upper()
    name = entry["n"].upper()
    if sym == needle:
        return 0
    if sym.startswith(needle):
        return 1
    if name.startswith(needle):
        return 2
    if needle in sym:
        return 3
    return 4


def search(query: str = "", asset_class: str = "", limit: int = 200) -> dict:
    """Catalog search over ticker *and* name.

    Ranked so an exact ticker wins over a name that merely contains the query --
    "apple" must put AAPL above every fund with Apple in its description.
    """
    rows = load_catalog()["symbols"]
    if asset_class:
        rows = [e for e in rows if e["c"] == asset_class]

    needle = query.strip().upper()
    if needle:
        rows = [e for e in rows if needle in e["s"].upper() or needle in e["n"].upper()]
        rows = sorted(rows, key=lambda e: (_rank(e, needle), e["s"]))

    return {
        "total": len(rows),
        "asset_class": asset_class or None,
        "instruments": [
            {"symbol": e["s"], "name": e["n"], "asset_class": e["c"],
             "exchange": e["x"], "store": e["st"]}
            for e in rows[:limit]
        ],
    }


def data_stores() -> list[dict]:
    """The qlib stores a backtest can run against.

    Two, because a store has exactly one trading calendar. `qrun` runs as a
    subprocess and does its own ``qlib.init()``, so a backtest is free to use a
    store the API process never mounted -- which is what makes the 365-day
    crypto store usable at all. The API's own inline queries (Factor Lab,
    /features) can only ever see the mounted store.

    Cached on the instrument directories' mtimes, keyed the same way
    `load_catalog` is. Every call globs both stores' instrument directories and
    counts every line of both calendars -- ten thousand lines -- and lowering a
    template calls this two or three times. At thirty templates the gallery was
    reading a million lines per request to answer a question whose inputs only
    change when an ingest runs.
    """
    settings = get_settings()
    key = _stores_signature(settings)
    with _stores_lock:
        if _stores_cache is not None and _stores_key == key:
            return _stores_cache
    built = _build_data_stores(settings)
    with _stores_lock:
        _set_stores_cache(key, built)
    return built


_stores_lock = threading.Lock()
_stores_cache: list[dict] | None = None
_stores_key: tuple | None = None


def _set_stores_cache(key: tuple, value: list[dict]) -> None:
    global _stores_cache, _stores_key
    _stores_cache, _stores_key = value, key


def _stores_signature(settings) -> tuple:
    """What must change before the answer can change.

    The mounted store is in the key because it is the one field of the payload
    that depends on process state rather than on disk.
    """
    parts: list = [qlib_status_provider_uri()]
    for uri in (settings.provider_uri, settings.crypto_provider_uri):
        path = Path(uri).expanduser()
        for child in ("instruments", "calendars/day.txt"):
            try:
                parts.append((str(path / child), (path / child).stat().st_mtime))
            except OSError:
                parts.append((str(path / child), None))
    return tuple(parts)


def _build_data_stores(settings) -> list[dict]:
    mounted = qlib_status_provider_uri()
    out = []
    for key, label, uri, region, note in (
        ("us", "US market (252-day)", settings.provider_uri, "us",
         "Equities, ETFs, crypto, FX and indices on the NYSE calendar. "
         "Cross-asset strategies live here."),
        ("crypto_365", "Crypto (365-day)", settings.crypto_provider_uri, "us",
         "Crypto only, every calendar day including weekends. "
         "Nothing else trades on a Sunday, so no other class can join it."),
    ):
        path = Path(uri).expanduser()
        universes = sorted(p.stem for p in (path / "instruments").glob("*.txt")) \
            if (path / "instruments").is_dir() else []
        # Read the calendar once and take both answers from it. Everything here
        # is inlined rather than routed through `store_calendar_end` /
        # `store_symbols`, because those resolve a store via `store_for` ->
        # `data_stores` -> here, and would recurse before the cache is set.
        days_list = _calendar_days(path / "calendars" / "day.txt")
        out.append({
            "key": key,
            "label": label,
            "provider_uri": str(path),
            "region": region,
            "note": note,
            "exists": len(days_list) > 0,
            "calendar_days": len(days_list),
            "universes": [u for u in universes if u != "benchmarks"],
            #: The first date this store can answer for. Free -- `days_list` is
            #: already read for the two answers below -- and the builder cannot
            #: draw a training window against the data it actually has without
            #: it. `/health` reports a range, but only for the *mounted* store,
            #: which is no help for a store you selected and never mounted.
            "calendar_start": days_list[0] if days_list else None,
            #: The last date a backtest may safely end on -- see
            #: `store_calendar_end`. Served so the builder can default a new
            #: strategy to a date that runs, rather than to a literal that goes
            #: stale the next time an ingest extends the calendar.
            "calendar_end": _safe_end(days_list),
            #: This store's own benchmark symbols. 'us' ships SPY and QQQ;
            #: crypto_365 ships none, and an empty list must read as "this
            #: store has no benchmark" rather than as a list still loading.
            "benchmarks": _instrument_symbols(path / "instruments" / "benchmarks.txt"),
            # Only the mounted store answers Factor Lab / /features queries.
            # Compare resolved paths: qlib reports the configured value, which
            # is usually still "~/..." while `path` is expanded.
            "mounted": bool(mounted) and Path(mounted).expanduser() == path,
        })
    return out


def store_for(key: str) -> dict | None:
    return next((s for s in data_stores() if s["key"] == key), None)


class StoreError(ValueError):
    """An unusable data store. The message is user-facing prose."""


def resolve_store(key: str | None) -> tuple[str, str]:
    """The provider_uri/region a run's YAML should carry, for ``key``.

    Resolved from the requested store rather than the API's own mounted one:
    qrun is a subprocess with its own ``qlib.init()``, so a run can target a
    store this process never mounted -- which is how the 365-day crypto store
    is reachable at all.

    Raises ``StoreError`` rather than ``HTTPException`` so the CLI seeder can
    call it; ``routers/runs.py`` wraps it back into HTTP status codes.
    """
    key = key or "us"
    store = store_for(key)
    if store is None:
        raise StoreError(f"Unknown data store '{key}'")
    if not store["exists"]:
        raise StoreError(
            f"Data store '{key}' has not been built yet ({store['provider_uri']})."
        )
    return store["provider_uri"], store["region"]


def store_calendar_end(store_key: str, buffer_sessions: int = 5) -> str | None:
    """The last date a backtest may safely end on, for ``store_key``.

    Not the store's final calendar day. ``TradeCalendarManager.get_step_time``
    (qlib/backtest/utils.py) reads ``calendar[i + 1]`` to find the end of the
    current step, so a backtest whose ``end_time`` is the store's final day
    raises ``IndexError: index 4174 is out of bounds for axis 0 with size
    4174`` on the last bar.

    It only bites when a trade decision is generated on that final bar, which
    is why two of the runs already in data/runs/ died this way while two others
    with an identical end date succeeded. Intermittent and irreproducible is
    worse than broken, so callers that generate a config -- the seeder above
    all -- should end a few sessions early instead.

    (``ingest.eodhd.write_future_calendar()`` is the other fix, appending
    padding days to the store. It exists but ``run_class_ingest`` never calls
    it, so no store on disk currently has that buffer.)

    Returns None when the store or its calendar is missing; the caller decides
    whether that is a refusal or a shrug.

    Cached per calendar on mtime. Every spec that reaches `build_workflow_config`
    asks this, and the debounced YAML preview rebuilds a config on each
    keystroke -- so an uncached read here would be a 4000-line file parsed per
    character typed.
    """
    store = store_for(store_key)
    if store is None:
        return None
    return _safe_end(_calendar_days(Path(store["provider_uri"]) / "calendars" / "day.txt"),
                     buffer_sessions)


#: Sessions left between a backtest's end and the store's final bar.
CALENDAR_BUFFER = 5


def _safe_end(days: list[str], buffer_sessions: int = CALENDAR_BUFFER) -> str | None:
    """The last safely-backtestable date in an already-read calendar."""
    if not days:
        return None
    # Clamp rather than raise: a store with fewer days than the buffer is a
    # broken store, but returning its first day is still a usable answer.
    return days[max(0, len(days) - 1 - max(0, buffer_sessions))]


def _calendar_days(calendar: Path) -> list[str]:
    """Every trading day in a qlib calendar file, cached on mtime.

    Both `data_stores` and `store_calendar_end` want this, and the debounced
    YAML preview rebuilds a config on every keystroke -- so an uncached read
    would be a four-thousand-line file parsed per character typed.
    """
    try:
        mtime = calendar.stat().st_mtime
    except OSError:
        return []

    key = (str(calendar), mtime)
    with _calendar_lock:
        hit = _calendar_cache.get(key)
    if hit is not None:
        return hit

    try:
        days = [line.strip() for line in calendar.read_text().splitlines() if line.strip()]
    except OSError:
        logger.warning("unreadable calendar %s", calendar)
        return []

    with _calendar_lock:
        if len(_calendar_cache) > 8:
            _calendar_cache.clear()
        _calendar_cache[key] = days
    return days


_calendar_lock = threading.Lock()
_calendar_cache: dict[tuple[str, float], list[str]] = {}


def store_symbols(store_key: str, instrument_set: str = "all") -> list[str]:
    """The symbols in one of a store's instrument files.

    Membership has to be answered per store, not from the mounted catalog:
    ``qrun`` inits against whichever store the strategy names, so 'is SPY in
    here?' has a different answer for the 252-day store and the 365-day crypto
    one. (It is no, for crypto -- which is why a crypto strategy that inherits
    the default SPY benchmark is a real failure, not a theoretical one.)

    Returns [] for an unknown store or a missing file; callers decide whether
    that is a refusal or a shrug.

    Cached per file on mtime. `all.txt` is ten thousand lines and every draft
    lowered against this machine reads it once to check a benchmark.
    """
    store = store_for(store_key)
    if store is None:
        return []
    return _instrument_symbols(Path(store["provider_uri"]) / "instruments"
                               / f"{instrument_set}.txt")


def _instrument_symbols(path: Path) -> list[str]:
    """The symbols in one qlib instrument file, cached on mtime.

    Path-level rather than store-level so `_build_data_stores` can call it
    without recursing back through `store_for`.
    """
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return []

    key = (str(path), mtime)
    with _symbols_lock:
        hit = _symbols_cache.get(key)
    if hit is not None:
        return hit

    out = []
    for line in path.read_text().splitlines():
        # qlib instrument files are "SYMBOL<tab>start<tab>end".
        symbol = line.split("\t")[0].strip()
        if symbol:
            out.append(symbol)

    with _symbols_lock:
        # Bounded so a long-lived process cannot accumulate one entry per
        # rewrite of every instrument file; the working set is a handful.
        if len(_symbols_cache) > 64:
            _symbols_cache.clear()
        _symbols_cache[key] = out
    return out


_symbols_lock = threading.Lock()
_symbols_cache: dict[tuple[str, float], list[str]] = {}


def qlib_status_provider_uri() -> str | None:
    from . import qlib_session

    try:
        return qlib_session.status().get("provider_uri")
    except Exception:
        return None


def _clean(value) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def has_bars(symbol: str) -> bool:
    entry = entry_for(symbol)
    return bool(entry) and entry["st"] == "market"


def bars(symbol: str, start: str | None = None, end: str | None = None) -> list[dict]:
    """OHLCV from the market store, in the same shape /api/bars already emits."""
    entry = entry_for(symbol)
    if entry is None or entry["st"] != "market":
        return []

    path = (
        Path(get_settings().market_dir).expanduser()
        / entry["c"]
        / f"{_safe_name(entry['s'])}.parquet"
    )
    if not path.exists():
        return []

    try:
        df = pd.read_parquet(path)
    except Exception:
        logger.exception("unreadable parquet %s", path)
        return []
    if df.empty:
        return []

    if start:
        df = df[df["date"] >= start]
    if end:
        df = df[df["date"] <= end]

    return [
        {"time": row["date"], **{f: _clean(row.get(f)) for f in BAR_FIELDS}}
        for _, row in df.iterrows()
    ]
