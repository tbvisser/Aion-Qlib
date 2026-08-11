"""EODHD -> normalized CSV -> qlib binary store.

The normalization here is not a matter of taste: it reproduces exactly what
``scripts/data_collector/yahoo/collector.py`` does, because that is the
convention every qlib expression, handler and benchmark assumes.

    factor = adjusted_close / close            (forward-filled)
    o/h/l/c *= factor ;  volume /= factor      (back-adjusted series)
    change  = pct-change of the RAW close      (computed before adjustment)
    then every column except symbol/change is divided by the first valid
    adjusted close (volume is multiplied by it)

The last step is what makes ``$close`` a small number near 1.0 at the start of
a symbol's history, and it is why ``$close / $factor`` recovers the true traded
price -- verified against the bundled CN store, where SH600519 on 2020-01-02
gives 1130.00, Moutai's actual close.

Binary writing is delegated to ``scripts/dump_bin.py`` rather than
reimplemented; getting the calendar/instrument bookkeeping subtly wrong is a
class of bug that is very hard to see from the UI.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Sequence

import httpx
import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

BASE_URL = "https://eodhd.com/api"
# Real exchanges only. PINK/OTC/NMFQS carry the bulk of the 51k symbol list and
# almost none of the tradeable liquidity.
DEFAULT_EXCHANGES = ("NASDAQ", "NYSE", "NYSE MKT", "AMEX", "BATS", "NYSE ARCA")
DEFAULT_TYPES = ("Common Stock",)
# The fields qlib's CN store carries, so handlers like Alpha158 find what they expect.
FEATURE_FIELDS = ("open", "high", "low", "close", "volume", "factor", "change")


@dataclass(frozen=True)
class AssetClass:
    """One tradeable class and everything that differs about ingesting it.

    The `store` split is forced by the calendar, not by preference. qlib keeps a
    single trading calendar per store and ``prune_non_trading_days`` deletes any
    date most symbols didn't report -- so 365-day assets (crypto) either lose
    every weekend bar or, if they outnumbered the equities, inject weekend
    sessions into the equity calendar and corrupt every backtest. Assets that
    don't share the .US 252-day calendar therefore go to a separate, plain
    store that has no calendar at all and is only ever charted.
    """

    key: str
    label: str
    #: EODHD `exchange-symbol-list/{exchange}` code.
    exchange: str
    #: EODHD `eod/{symbol}.{suffix}` selector.
    suffix: str
    #: 'qlib' (backtestable, shares the equity calendar) or 'market' (chart-only).
    store: str
    #: Accepted `Type` values from the symbol list; None accepts every type.
    types: tuple[str, ...] | None = None
    #: Accepted `Exchange` values; None accepts every exchange.
    exchanges: tuple[str, ...] | None = None
    #: qlib's handlers need back-adjusted, rebased prices. Chart-only assets
    #: keep raw prices -- rebasing would draw BTC at 0.0012 instead of $63,460.
    rebase: bool = False
    #: Class/unit oddities like BRK-B. Never set for crypto: every EODHD crypto
    #: ticker is `BTC-USD` shaped and this filter would reject all 1,917.
    skip_hyphen: bool = False
    #: Whether a zero-volume bar means "did not trade". True for equities, ETFs
    #: and crypto, where a flat/halted day must not masquerade as an
    #: observation. False for FX and indices: EODHD reports volume 0 on *every*
    #: FX bar, so treating that as "no trade" blanks the entire history.
    require_volume: bool = True


ASSET_CLASSES: dict[str, AssetClass] = {
    "equity": AssetClass(
        key="equity", label="Equities", exchange="US", suffix="US", store="qlib",
        types=DEFAULT_TYPES, exchanges=DEFAULT_EXCHANGES, rebase=True, skip_hyphen=True,
    ),
    "etf": AssetClass(
        key="etf", label="ETFs", exchange="US", suffix="US", store="qlib",
        types=("ETF",), exchanges=DEFAULT_EXCHANGES, rebase=True, skip_hyphen=True,
    ),
    "crypto": AssetClass(
        key="crypto", label="Crypto", exchange="CC", suffix="CC", store="market",
    ),
    "fx": AssetClass(
        key="fx", label="FX", exchange="FOREX", suffix="FOREX", store="market",
        require_volume=False,
    ),
    "index": AssetClass(
        key="index", label="Indices", exchange="INDX", suffix="INDX", store="market",
        require_volume=False,
    ),
}


_RATE_LIMIT_RETRIES = 6

#: Max rows EODHD will return in one economic-events page.
MACRO_EVENT_PAGE = 1000
#: Max usable offset. 1500 is a 422, so this plus MACRO_EVENT_PAGE is the hard
#: ceiling on rows per query window.
MACRO_EVENT_MAX_OFFSET = 1000
#: Window size for chunking. A quarter saturates for the US; a month does not.
MACRO_CHUNK_MONTHS = 1

# Shared across worker threads: when one hits a 429 the whole pool eases off,
# because the limit is per-account, not per-connection.
_throttle_lock = threading.Lock()
_throttle_until = 0.0


class EodhdError(RuntimeError):
    """A user-facing ingest failure."""


@dataclass
class IngestProgress:
    """Coarse progress for the SSE stream; every field is safe to serialise."""

    stage: str = "idle"
    message: str = ""
    done: int = 0
    total: int = 0
    symbols_ok: int = 0
    symbols_failed: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "stage": self.stage,
            "message": self.message,
            "done": self.done,
            "total": self.total,
            "symbols_ok": self.symbols_ok,
            "failed_count": len(self.symbols_failed),
            "failed_sample": self.symbols_failed[:10],
        }


ProgressFn = Callable[[IngestProgress], None]


class EodhdClient:
    """Thin, retrying HTTP client. One instance per ingest run."""

    def __init__(self, api_key: str, timeout: float = 60.0):
        if not api_key:
            raise EodhdError("EODHD_API_KEY is not set — add it to webapp/.env")
        self._key = api_key
        self._client = httpx.Client(
            timeout=httpx.Timeout(timeout, connect=10.0),
            transport=httpx.HTTPTransport(retries=3),
            headers={"User-Agent": "aion/0.1"},
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "EodhdClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _get(self, path: str, **params) -> list | dict:
        """One GET, with backoff on rate limiting.

        EODHD throttles per minute, and a whole-market ingest is tens of
        thousands of requests -- so 429 is an expected part of normal operation,
        not an error. The transport's `retries=3` only covers connection
        failures; a 429 is a valid response and would otherwise abort the run.
        """
        params = {"api_token": self._key, "fmt": "json", **params}
        url = f"{BASE_URL}/{path}"

        for attempt in range(_RATE_LIMIT_RETRIES):
            resp = self._client.get(url, params=params)
            if resp.status_code == 401:
                raise EodhdError("EODHD rejected the API key (401)")
            if resp.status_code == 402:
                raise EodhdError("EODHD plan does not cover this endpoint (402)")
            if resp.status_code == 429:
                # Honour Retry-After when offered, else exponential backoff.
                retry_after = resp.headers.get("Retry-After")
                delay = float(retry_after) if retry_after and retry_after.isdigit() else 2.0 * (2 ** attempt)
                delay = min(delay, 60.0)
                with _throttle_lock:
                    # One thread hitting the limit means every thread should
                    # ease off; pausing them all is what actually clears it.
                    global _throttle_until
                    _throttle_until = max(_throttle_until, time.monotonic() + delay)
                logger.warning("rate limited; backing off %.1fs (attempt %d)", delay, attempt + 1)
                time.sleep(delay)
                continue
            resp.raise_for_status()
            return resp.json()

        raise EodhdError(f"EODHD kept rate limiting after {_RATE_LIMIT_RETRIES} retries")

    def _wait_for_throttle(self) -> None:
        """Block while a sibling thread's 429 backoff is still in effect."""
        while True:
            with _throttle_lock:
                remaining = _throttle_until - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(remaining, 5.0))

    # --- macro ------------------------------------------------------------
    def economic_events(
        self,
        *,
        start: str,
        end: str,
        country: str = "",
        limit: int = MACRO_EVENT_PAGE,
        offset: int = 0,
    ) -> list[dict]:
        """One page of the economic calendar.

        Note the defaults EODHD applies when you leave these off: `limit`
        defaults to **50**, not "everything". Both `limit` and `offset` are
        capped at 1000 -- 1500 returns a 422 -- so a single query window can
        yield at most 2000 rows. `iter_economic_events` is what makes that
        safe; calling this directly will silently under-fetch.
        """
        params = {"from": start, "to": end, "limit": limit}
        if offset:
            params["offset"] = offset
        if country:
            params["country"] = country
        data = self._get("economic-events", **params)
        if not isinstance(data, list):
            raise EodhdError("Unexpected economic-events response from EODHD")
        return data

    def macro_indicator(self, country3: str, indicator: str) -> list[dict]:
        """One annual country indicator series (World Bank style)."""
        data = self._get(f"macro-indicator/{country3}", indicator=indicator)
        if not isinstance(data, list):
            raise EodhdError("Unexpected macro-indicator response from EODHD")
        return data

    def list_symbols(self, exchange: str = "US") -> list[dict]:
        data = self._get(f"exchange-symbol-list/{exchange}")
        if not isinstance(data, list):
            raise EodhdError("Unexpected symbol-list response from EODHD")
        return data

    def bulk_last_day(self, exchange: str = "US") -> list[dict]:
        data = self._get(f"eod-bulk-last-day/{exchange}")
        if not isinstance(data, list):
            raise EodhdError("Unexpected bulk-last-day response from EODHD")
        return data

    def eod_history(
        self, symbol: str, start: str, end: str | None = None, suffix: str = "US"
    ) -> list[dict]:
        # The suffix is EODHD's exchange selector: .US equities/ETFs, .CC crypto,
        # .FOREX pairs, .INDX indices. (.COMM is not on this plan -- it 404s.)
        params = {"from": start, "period": "d", "order": "a"}
        if end:
            params["to"] = end
        data = self._get(f"eod/{symbol}.{suffix}", **params)
        return data if isinstance(data, list) else []


def select_universe(
    client: EodhdClient,
    size: int,
    exchanges: Iterable[str] = DEFAULT_EXCHANGES,
    types: Iterable[str] = DEFAULT_TYPES,
) -> tuple[list[str], str]:
    """Top ``size`` tickers by most-recent dollar volume, plus that day's date.

    Ranking on a single recent session is a deliberate, documented compromise:
    EODHD has no clean historical index-membership feed, and one bulk request
    ranks the whole market. It does bias the universe toward today's winners --
    the UI says so rather than hiding it, and the per-symbol start/end dates
    written into the instruments file still keep qlib's own point-in-time
    handling honest.
    """
    exchanges = {e.upper() for e in exchanges}
    types = set(types)

    eligible = {
        row["Code"]
        for row in client.list_symbols()
        if row.get("Type") in types
        and str(row.get("Exchange", "")).upper() in exchanges
        and "-" not in str(row.get("Code", ""))  # skip class/unit oddities
    }
    logger.info("eligible symbols after exchange/type filter: %d", len(eligible))

    bulk = client.bulk_last_day()
    as_of = ""
    ranked: list[tuple[float, str]] = []
    for row in bulk:
        code = row.get("code")
        if code not in eligible:
            continue
        close, volume = row.get("close"), row.get("volume")
        if not close or not volume:
            continue
        as_of = as_of or str(row.get("date", ""))
        ranked.append((float(close) * float(volume), code))

    ranked.sort(reverse=True)
    return [code for _, code in ranked[:size]], as_of


def list_class_symbols(client: EodhdClient, cls: AssetClass) -> list[dict]:
    """Every symbol in a class, as EODHD metadata rows (Code/Name/Type/Exchange).

    Returned as rows rather than codes because the Name is what makes the UI
    searchable -- the store holds tickers only, so today "apple" finds nothing.
    """
    rows = []
    for row in client.list_symbols(cls.exchange):
        code = str(row.get("Code", ""))
        if not code:
            continue
        if cls.types is not None and row.get("Type") not in cls.types:
            continue
        if cls.exchanges is not None and str(row.get("Exchange", "")).upper() not in {
            e.upper() for e in cls.exchanges
        }:
            continue
        if cls.skip_hyphen and "-" in code:
            continue
        rows.append(row)
    logger.info("%s: %d symbols after filters", cls.key, len(rows))
    return rows


def normalize_symbol(
    rows: list[dict], symbol: str, rebase: bool = True, require_volume: bool = True
) -> pd.DataFrame:
    """One symbol's EODHD bars -> a normalized CSV frame.

    With ``rebase`` (the qlib store) this mirrors YahooNormalize1d: adjust,
    derive change from the raw close, then rebase everything on the first valid
    adjusted close -- the convention every qlib handler assumes.

    Without it (the chart-only market store) prices stay as traded. Crypto, FX
    and indices have no corporate actions, so there is nothing to adjust for,
    and rebasing would only make every chart unreadable.
    """
    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    required = {"date", "open", "high", "low", "close", "volume"}
    if not required.issubset(df.columns):
        return pd.DataFrame()

    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None)
    df = df.drop_duplicates(subset="date", keep="first").sort_values("date").set_index("date")

    numeric = ["open", "high", "low", "close", "volume", "adjusted_close"]
    for col in numeric:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # A zero/absent volume bar is not a trading observation; blank the row so it
    # cannot masquerade as a flat day in a rolling window. adjusted_close must be
    # blanked too -- EODHD reports 0.0 there on halted days, and a zero left in
    # place makes the next day's return divide by zero (inf).
    # FX reports volume 0 on every bar and many indices report none at all, so
    # for those classes this rule would blank the entire history.
    if require_volume:
        dead = (df["volume"] <= 0) | df["volume"].isna()
        blank_cols = [
            c for c in ("open", "high", "low", "close", "volume", "adjusted_close") if c in df.columns
        ]
        df.loc[dead, blank_cols] = np.nan

    # `change` is the true close-to-close return, so it must come from the
    # ADJUSTED series. Yahoo's `close` is already split-adjusted, which is why
    # qlib's yahoo normalizer can derive change from it; EODHD's `close` is the
    # raw traded price, so doing the same here would print a -90% return on
    # NVDA's 2024-06-10 10:1 split instead of the actual +0.75%.
    adj_close = (df["adjusted_close"] if "adjusted_close" in df.columns else df["close"]).ffill()
    df["change"] = (adj_close / adj_close.shift(1) - 1).replace([np.inf, -np.inf], np.nan)

    if "adjusted_close" in df.columns:
        df["factor"] = (df["adjusted_close"] / df["close"]).ffill()
    else:
        df["factor"] = 1.0
    df["factor"] = df["factor"].replace([np.inf, -np.inf], np.nan).ffill().fillna(1.0)

    for col in ("open", "high", "low", "close"):
        df[col] = df[col] * df["factor"]
    df["volume"] = df["volume"] / df["factor"]

    # Rebase on the first valid adjusted close, matching _manual_adj_data.
    first_idx = df["close"].first_valid_index()
    if first_idx is None:
        return pd.DataFrame()
    first_close = float(df.loc[first_idx, "close"])
    if not np.isfinite(first_close) or first_close == 0:
        return pd.DataFrame()

    if rebase:
        for col in ("open", "high", "low", "close", "factor"):
            df[col] = df[col] / first_close
        df["volume"] = df["volume"] * first_close

    df["symbol"] = symbol
    out = df.reset_index()[["symbol", "date", *FEATURE_FIELDS]]
    out["date"] = out["date"].dt.strftime("%Y-%m-%d")
    return out


def fetch_and_write(
    client: EodhdClient,
    symbols: list[str],
    csv_dir: Path,
    start: str,
    end: str | None,
    max_workers: int,
    progress: IngestProgress,
    on_progress: ProgressFn | None,
    suffix: str = "US",
    rebase: bool = True,
    calendar: set[str] | None = None,
    require_volume: bool = True,
    skip_existing: bool = False,
) -> None:
    """Download and normalize each symbol into ``csv_dir``.

    ``calendar``, when given, clips every bar to dates already in the qlib
    store's calendar. That is what lets ETFs join the equity store without
    moving ``calendars/day.txt``: dump_bin rebuilds the calendar from the union
    of all CSV dates, so a subset can never change it.
    """
    csv_dir.mkdir(parents=True, exist_ok=True)
    progress.stage = "download"
    progress.total = len(symbols)
    progress.done = 0

    def one(symbol: str) -> tuple[str, bool]:
        try:
            # Resume support: a whole-market ingest is tens of thousands of
            # requests and an hour long, so a failure near the end must not
            # throw away everything already downloaded.
            if skip_existing:
                existing = csv_dir / f"{_safe_name(symbol)}.csv"
                if existing.exists() and existing.stat().st_size > 0:
                    return symbol, True
            client._wait_for_throttle()
            rows = client.eod_history(symbol, start, end, suffix=suffix)
            frame = normalize_symbol(rows, symbol, rebase=rebase, require_volume=require_volume)
            if frame.empty:
                return symbol, False
            if calendar is not None:
                frame = frame[frame["date"].isin(calendar)]
                if frame.empty:
                    return symbol, False
            frame.to_csv(csv_dir / f"{_safe_name(symbol)}.csv", index=False)
            return symbol, True
        except Exception:
            logger.exception("failed to ingest %s", symbol)
            return symbol, False

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(one, s) for s in symbols]
        for future in as_completed(futures):
            symbol, ok = future.result()
            progress.done += 1
            if ok:
                progress.symbols_ok += 1
            else:
                progress.symbols_failed.append(symbol)
            if on_progress and progress.done % 10 == 0:
                progress.message = f"{progress.done}/{progress.total} symbols"
                on_progress(progress)

    if on_progress:
        progress.message = f"{progress.symbols_ok} symbols written"
        on_progress(progress)


def prune_non_trading_days(csv_dir: Path, quorum: float = 0.25) -> list[str]:
    """Drop bars dated on days the US market was closed.

    dump_bin derives the calendar from the union of dates across all CSVs, so a
    single misbehaving symbol puts a phantom trading day into the calendar for
    everyone -- which then shifts every rolling window and lets a backtest
    "trade" on Thanksgiving.

    A handful of foreign-listed names in the universe do exactly that. The
    separation is unambiguous in practice: real sessions see 328-500 of 500
    symbols report, market holidays see 1. A date survives only if at least
    ``quorum`` of the symbols *listed at the time* actually printed a bar --
    comparing against listed-at-the-time rather than the full universe is what
    keeps sparse early years (few of today's names existed in 2010) intact.

    Returns the dates removed.
    """
    files = sorted(csv_dir.glob("*.csv"))
    if not files:
        return []

    reporting: dict[str, int] = {}
    spans: list[tuple[str, str]] = []
    frames: dict[Path, pd.DataFrame] = {}

    for path in files:
        df = pd.read_csv(path)
        frames[path] = df
        traded = df.loc[df["close"].notna(), "date"]
        if traded.empty:
            continue
        spans.append((traded.iloc[0], traded.iloc[-1]))
        for date in traded:
            reporting[date] = reporting.get(date, 0) + 1

    if not reporting:
        return []

    all_dates = sorted(reporting)
    # active[date] = symbols whose listed span covers it.
    starts = sorted(s for s, _ in spans)
    ends = sorted(e for _, e in spans)
    import bisect

    dropped: list[str] = []
    for date in all_dates:
        listed = bisect.bisect_right(starts, date) - bisect.bisect_left(ends, date)
        threshold = max(2, int(quorum * max(listed, 1)))
        if reporting[date] < threshold:
            dropped.append(date)

    if dropped:
        drop_set = set(dropped)
        for path, df in frames.items():
            keep = df[~df["date"].isin(drop_set)]
            if len(keep) != len(df):
                keep.to_csv(path, index=False)
        logger.info("pruned %d non-trading dates from the calendar", len(dropped))

    return dropped


def dump_to_qlib(csv_dir: Path, qlib_dir: Path, repo_root: Path, mode: str = "all") -> None:
    """Run scripts/dump_bin.py in-process to build the binary store."""
    scripts_dir = repo_root / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))

    from dump_bin import DumpDataAll, DumpDataUpdate  # type: ignore[import-not-found]

    dumper_cls = DumpDataAll if mode == "all" else DumpDataUpdate
    dumper = dumper_cls(
        data_path=str(csv_dir),
        qlib_dir=str(qlib_dir),
        freq="day",
        date_field_name="date",
        symbol_field_name="symbol",
        include_fields=",".join(FEATURE_FIELDS),
    )
    dumper.dump()


def _write_vwap_proxy(qlib_dir: Path, *, overwrite: bool = True) -> None:
    """Add the derived `$vwap` column, and never fail an ingest over it.

    `$vwap` here is typical price, not a volume-weighted one — see
    `webapp.ingest.vwap`, which is where that sentence is defined. It has to be
    written after every dump because `dump_bin` rewrites high/low/close from the
    fresh bars and leaves any previous proxy sitting beside them, stale.

    A failure is logged rather than raised. The column is derived, and a store
    without it is a case everything downstream already handles: `_dead_columns`
    sees it missing and `build_workflow_config` drops the handler columns that
    read it. Aborting a ten-thousand-symbol ingest over a derived column would
    be the worse trade.
    """
    from webapp.ingest.vwap import write_vwap_proxy

    try:
        report = write_vwap_proxy(qlib_dir, overwrite=overwrite)
    except Exception:  # noqa: BLE001 — see the docstring
        logger.exception("could not write the $vwap proxy into %s", qlib_dir)
        return
    logger.info("$vwap proxy: %d written, %d skipped of %d in %s",
                report["written"], report["skipped"], report["total"], qlib_dir)
    if report["skipped"]:
        logger.warning("%d instruments have no $vwap; expressions reading it will be "
                       "NaN for those names", report["skipped"])


def write_future_calendar(qlib_dir: Path, extra_days: int = 60) -> int:
    """Write calendars/day_future.txt — the trading calendar plus future dates.

    A backtest that runs to the last available bar still asks for the *next*
    step's timestamp (``TradeCalendarManager.get_step_time`` reads
    ``calendar[i + 1]``), so without this it dies with an IndexError on the
    final day and qlib logs "load calendar error: freq=day, future=True".
    The bundled CN dataset ships this file; a store built from scratch must
    produce it too.

    The appended dates are plain business days. They sit entirely beyond the
    last bar, where no price exists and no trade can be simulated, so their
    only job is to give that lookahead lookup somewhere to land.
    """
    calendar_path = qlib_dir / "calendars" / "day.txt"
    if not calendar_path.exists():
        return 0

    days = [line.strip() for line in calendar_path.read_text().splitlines() if line.strip()]
    if not days:
        return 0

    future = pd.bdate_range(
        start=pd.Timestamp(days[-1]) + pd.Timedelta(days=1), periods=extra_days
    )
    combined = days + [d.strftime("%Y-%m-%d") for d in future]
    (qlib_dir / "calendars" / "day_future.txt").write_text("\n".join(combined) + "\n")
    return len(combined)


def _safe_name(symbol: str) -> str:
    """Filesystem-safe stem for a ticker.

    Identity for every equity/ETF ticker, so the existing store is untouched.
    It only matters for the wider symbol space -- a few FX/index codes carry
    characters that cannot appear in a filename.
    """
    return re.sub(r'[/\\:*?"<>|]', "_", symbol)


def read_calendar(qlib_dir: Path) -> set[str]:
    """The qlib store's existing trading days, for clipping new .US symbols."""
    path = qlib_dir / "calendars" / "day.txt"
    if not path.exists():
        return set()
    return {line.strip() for line in path.read_text().splitlines() if line.strip()}


def write_market_store(csv_dir: Path, market_dir: Path, cls: AssetClass) -> int:
    """Normalized CSVs -> the chart-only parquet store for one class.

    No calendar, no pruning, no dump_bin: these assets are never queried by
    qlib, so none of that bookkeeping applies to them. Parquet because a
    per-symbol read is the only access pattern and it is both smaller and
    faster than CSV for it.
    """
    out_dir = market_dir / cls.key
    out_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for path in sorted(csv_dir.glob("*.csv")):
        try:
            df = pd.read_csv(path)
        except Exception:
            logger.exception("unreadable %s", path)
            continue
        if df.empty:
            continue
        df.to_parquet(out_dir / f"{path.stem}.parquet", index=False)
        written += 1
    return written


def write_catalog(catalog_path: Path, entries: list[dict]) -> int:
    """Ticker -> name/class/exchange/store, for search and bars dispatch.

    The store holds tickers only, which is why searching "apple" finds nothing
    today. EODHD's symbol lists carry the names and we were discarding them;
    this keeps them. Only symbols that actually produced data are listed, so
    the catalog never advertises a chart that cannot be drawn.
    """
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "count": len(entries),
        "classes": sorted({e["c"] for e in entries}),
        "symbols": sorted(entries, key=lambda e: (e["c"], e["s"])),
    }
    catalog_path.write_text(json.dumps(payload, separators=(",", ":")))
    return len(entries)


def catalog_entries_on_disk(
    cls: AssetClass, meta_rows: list[dict], csv_dir: Path | None, market_dir: Path | None
) -> list[dict]:
    """Catalog rows for the symbols of ``cls`` that have data on disk."""
    if cls.store == "qlib":
        have = {p.stem for p in csv_dir.glob("*.csv")} if csv_dir and csv_dir.is_dir() else set()
    else:
        d = (market_dir / cls.key) if market_dir else None
        have = {p.stem for p in d.glob("*.parquet")} if d and d.is_dir() else set()

    entries = []
    for row in meta_rows:
        code = str(row.get("Code", ""))
        if _safe_name(code) not in have:
            continue
        entries.append({
            "s": code,
            "n": str(row.get("Name") or code),
            "c": cls.key,
            "x": str(row.get("Exchange") or ""),
            "st": cls.store,
        })
    return entries


def write_universe(qlib_dir: Path, name: str, csv_dir: Path, symbols: list[str]) -> int:
    """Write instruments/<name>.txt with each symbol's real first/last date.

    Using each symbol's own coverage (rather than one global span) is what lets
    qlib exclude a name from dates it did not trade on.
    """
    instruments_dir = qlib_dir / "instruments"
    instruments_dir.mkdir(parents=True, exist_ok=True)

    lines: list[str] = []
    for symbol in symbols:
        path = csv_dir / f"{_safe_name(symbol)}.csv"
        if not path.exists():
            continue
        dates = pd.read_csv(path, usecols=["date"])["date"]
        if dates.empty:
            continue
        lines.append(f"{symbol}\t{dates.iloc[0]}\t{dates.iloc[-1]}")

    (instruments_dir / f"{name}.txt").write_text("\n".join(lines) + "\n")
    return len(lines)


def run_ingest(
    api_key: str,
    qlib_dir: Path,
    csv_dir: Path,
    repo_root: Path,
    universe_size: int = 500,
    start: str = "2010-01-01",
    end: str | None = None,
    max_workers: int = 8,
    mode: str = "all",
    on_progress: ProgressFn | None = None,
) -> dict:
    """Full pipeline. Returns a summary dict for the API/CLI to report."""
    progress = IngestProgress(stage="universe", message="Ranking symbols by liquidity")
    if on_progress:
        on_progress(progress)

    with EodhdClient(api_key) as client:
        symbols, as_of = select_universe(client, universe_size)
        if not symbols:
            raise EodhdError("No symbols selected — check the exchange/type filters")
        progress.message = f"{len(symbols)} symbols selected (ranked on {as_of})"
        if on_progress:
            on_progress(progress)

        fetch_and_write(client, symbols, csv_dir, start, end, max_workers, progress, on_progress)

    if progress.symbols_ok == 0:
        raise EodhdError("No symbol produced usable data — nothing was written")

    progress.stage = "calendar"
    progress.message = "Pruning non-trading days"
    if on_progress:
        on_progress(progress)
    dropped = prune_non_trading_days(csv_dir)

    progress.stage = "dump"
    progress.message = "Writing qlib binary store"
    if on_progress:
        on_progress(progress)
    dump_to_qlib(csv_dir, qlib_dir, repo_root, mode=mode)
    # The dump just rewrote high/low/close, so the proxy beside them is stale.
    _write_vwap_proxy(qlib_dir, overwrite=True)

    progress.stage = "universe-files"
    written = write_universe(qlib_dir, f"top{universe_size}", csv_dir, symbols)
    write_future_calendar(qlib_dir)
    if on_progress:
        on_progress(progress)

    progress.stage = "done"
    progress.message = f"{progress.symbols_ok} symbols in {qlib_dir}"
    if on_progress:
        on_progress(progress)

    return {
        "qlib_dir": str(qlib_dir),
        "symbols_requested": len(symbols),
        "symbols_written": progress.symbols_ok,
        "symbols_failed": len(progress.symbols_failed),
        "failed_sample": progress.symbols_failed[:10],
        "universe": f"top{universe_size}",
        "universe_members": written,
        "non_trading_days_pruned": len(dropped),
        "ranked_as_of": as_of,
        "start": start,
        "end": end,
    }


def run_class_ingest(
    api_key: str,
    classes: Iterable[str],
    *,
    qlib_dir: Path,
    market_dir: Path,
    csv_dir: Path,
    catalog_path: Path,
    repo_root: Path,
    start: str = "2010-01-01",
    end: str | None = None,
    max_workers: int = 8,
    limit: int | None = None,
    skip_existing: bool = False,
    on_progress: ProgressFn | None = None,
) -> dict:
    """Ingest whole asset classes, then rebuild the catalog.

    Two invariants this function exists to protect:

    * **The equity calendar never moves.** .US classes (ETFs) are clipped to the
      dates already in ``calendars/day.txt`` before dumping, so dump_bin's
      union-of-all-dates can only reproduce the existing calendar. Without this
      one ETF with a stray bar would shift every backtest's windows.
    * **top500 never moves.** ``write_universe`` is not called here, so the
      universe every stored strategy references is left exactly as it was.

    Equities are not re-fetched: they are already in ``csv_dir``. They are still
    catalogued, so names become searchable without spending 500 API calls.
    """
    selected = [ASSET_CLASSES[c] for c in classes]
    progress = IngestProgress(stage="catalog", message="Listing symbols")
    if on_progress:
        on_progress(progress)

    per_class: dict[str, dict] = {}
    entries: list[dict] = []
    dumped_to_qlib = False
    calendar = read_calendar(qlib_dir)

    with EodhdClient(api_key) as client:
        # Metadata for every class, fetched up front: it is one call each and
        # the names are needed for the catalog whether or not we fetch bars.
        meta = {cls.key: list_class_symbols(client, cls) for cls in ASSET_CLASSES.values()}

        for cls in selected:
            rows = meta[cls.key]
            symbols = [str(r["Code"]) for r in rows]
            if limit:
                symbols = symbols[:limit]

            if cls.store == "qlib":
                target_dir = csv_dir
                clip = calendar or None
            else:
                target_dir = csv_dir.parent / cls.key
                clip = None

            progress.stage = f"download:{cls.key}"
            progress.message = f"{cls.label}: {len(symbols)} symbols"
            if on_progress:
                on_progress(progress)

            before_ok = progress.symbols_ok
            fetch_and_write(
                client, symbols, target_dir, start, end, max_workers, progress, on_progress,
                suffix=cls.suffix, rebase=cls.rebase, calendar=clip,
                require_volume=cls.require_volume, skip_existing=skip_existing,
            )
            written = progress.symbols_ok - before_ok

            if cls.store == "market":
                stored = write_market_store(target_dir, market_dir, cls)
            else:
                stored = written
                dumped_to_qlib = True

            per_class[cls.key] = {
                "requested": len(symbols),
                "written": written,
                "stored": stored,
                "store": cls.store,
            }

    if dumped_to_qlib:
        progress.stage = "dump"
        progress.message = "Writing qlib binary store"
        if on_progress:
            on_progress(progress)
        dump_to_qlib(csv_dir, qlib_dir, repo_root, mode="all")
        _write_vwap_proxy(qlib_dir, overwrite=True)
        write_future_calendar(qlib_dir)

    # Catalog every class that has data on disk, not just the ones just fetched.
    progress.stage = "catalog"
    progress.message = "Writing symbol catalog"
    if on_progress:
        on_progress(progress)
    for cls in ASSET_CLASSES.values():
        entries.extend(catalog_entries_on_disk(
            cls,
            meta[cls.key],
            csv_dir if cls.store == "qlib" else None,
            market_dir if cls.store == "market" else None,
        ))
    write_catalog(catalog_path, entries)

    progress.stage = "done"
    progress.message = f"{len(entries)} symbols catalogued"
    if on_progress:
        on_progress(progress)

    counts: dict[str, int] = {}
    for e in entries:
        counts[e["c"]] = counts.get(e["c"], 0) + 1

    return {
        "classes": per_class,
        "catalog_total": len(entries),
        "catalog_by_class": counts,
        "catalog_path": str(catalog_path),
        "qlib_dir": str(qlib_dir),
        "market_dir": str(market_dir),
        "redumped_qlib_store": dumped_to_qlib,
    }


# ==========================================================================
# Macro: the economic calendar and annual country indicators
# ==========================================================================
#
# Two EODHD endpoints, both with sharper edges than they look:
#
# * ``/economic-events`` defaults to **50 rows**, caps ``limit`` at 1000, and
#   caps ``offset`` at 1000 (1500 -> HTTP 422). So one query window yields at
#   most 2000 rows -- and a single *quarter* of US releases already returns a
#   saturated 1000. Monthly windows run ~320-390 rows, which is why
#   ``MACRO_CHUNK_MONTHS`` is 1. Assuming one call returns everything is the
#   most likely way this ships silently short.
#
# * Rows that share ``(country, type, date)`` are usually **not duplicates**.
#   The same release is reported once per ``comparison`` basis: PCE Price Index
#   on 2024-01-26 carries a ``mom`` reading of 0.2 *and* a ``yoy`` reading of
#   2.6 at the identical timestamp. Deduping without ``comparison`` and
#   ``period`` in the key silently discards the year-over-year print of every
#   inflation release -- the single number a macro desk most wants.


@dataclass(frozen=True)
class MacroIndicator:
    slug: str
    label: str
    group: str
    unit: str
    frequency: str = "annual"


#: The annual country indicators worth showing. Every slug here returned 200
#: against /macro-indicator/USA; EODHD 404s on anything it does not recognise,
#: and its vocabulary is narrower than the docs suggest (``gross_savings_
#: percent_gdp``, ``government_debt_to_gdp`` and ``current_account_to_gdp`` are
#: all 404). These are annual World Bank series -- context tiles, never daily
#: regressors, which ``macro_registry.daily_ok`` enforces.
MACRO_INDICATORS: dict[str, MacroIndicator] = {
    m.slug: m for m in (
        MacroIndicator("gdp_growth_annual", "GDP growth", "growth", "percent"),
        MacroIndicator("gdp_current_usd", "GDP", "growth", "usd"),
        MacroIndicator("gdp_per_capita_usd", "GDP per capita", "growth", "usd"),
        MacroIndicator("inflation_consumer_prices_annual", "CPI inflation",
                       "inflation", "percent"),
        MacroIndicator("consumer_price_index", "CPI level", "inflation", "index"),
        MacroIndicator("unemployment_total_percent", "Unemployment", "labour", "percent"),
        MacroIndicator("real_interest_rate", "Real interest rate", "rates", "percent"),
        MacroIndicator("population_total", "Population", "demographics", "count"),
    )
}

#: ISO-2 for /economic-events, ISO-3 for /macro-indicator. EODHD uses different
#: code systems on the two endpoints, which is an easy and silent mistake.
EVENT_COUNTRIES: tuple[str, ...] = ("US", "DE", "GB", "JP", "CN")
INDICATOR_COUNTRIES: tuple[str, ...] = ("USA", "DEU", "GBR", "JPN", "CHN")

#: EODHD accepts ``country=GB`` on the request and then tags every row it
#: returns ``UK``. Left alone, the cache holds a code the caller never asked
#: for and a UI filtering on GB silently finds nothing, so responses are
#: normalised back to the requested vocabulary on the way in.
_COUNTRY_ALIASES: dict[str, str] = {"UK": "GB", "EA": "EU", "EMU": "EU"}

#: The columns an events frame always has, so an empty cache still round-trips
#: through parquet with the right dtypes instead of raising on read.
EVENT_COLUMNS: tuple[str, ...] = (
    "date", "time", "country", "type", "event_key", "period", "comparison",
    "actual", "previous", "estimate", "change", "change_percentage",
    "surprise", "is_forecast",
)
INDICATOR_COLUMNS: tuple[str, ...] = (
    "country_code", "country_name", "indicator", "date", "period", "value",
)


def _event_key(event_type: str, comparison=None) -> str:
    """A stable slug for a release type, qualifying the comparison basis.

    ``PCE Price Index`` yoy and mom are different numbers on the same
    timestamp, so they need different keys anywhere a value is displayed. The
    event *study* groups by timestamp regardless, so collapsing them there is
    handled by the study, not by this key.
    """
    slug = re.sub(r"[^a-z0-9]+", "_", str(event_type or "").strip().lower()).strip("_")
    basis = str(comparison).strip().lower() if comparison else ""
    return f"{slug}__{basis}" if basis and basis != "nan" else slug


def _months(start: str, end: str) -> list[tuple[str, str]]:
    """``[start, end]`` split into month-sized windows, inclusive."""
    first = pd.Timestamp(start).normalize().replace(day=1)
    last = pd.Timestamp(end).normalize()
    out: list[tuple[str, str]] = []
    cursor = first
    while cursor <= last:
        stop = cursor + pd.offsets.MonthEnd(MACRO_CHUNK_MONTHS)
        out.append((
            max(cursor, pd.Timestamp(start)).strftime("%Y-%m-%d"),
            min(stop, last).strftime("%Y-%m-%d"),
        ))
        cursor = stop + pd.Timedelta(days=1)
    return out


def iter_economic_events(
    client: "EodhdClient",
    *,
    start: str,
    end: str,
    country: str = "",
    on_progress: ProgressFn | None = None,
) -> list[dict]:
    """Every release in ``[start, end]``, chunked and paged so none is lost.

    Month windows, then offset pages within each window until a short page
    arrives or the offset ceiling is hit. A window that saturates *both* pages
    is logged loudly -- that is the only way rows can still go missing, and it
    should never happen at monthly granularity.
    """
    seen: dict[tuple, dict] = {}
    windows = _months(start, end)
    for i, (a, b) in enumerate(windows, 1):
        offset = 0
        while True:
            page = client.economic_events(
                start=a, end=b, country=country,
                limit=MACRO_EVENT_PAGE, offset=offset,
            )
            for row in page:
                # The full key. See the module note: comparison and period are
                # load-bearing, not noise.
                key = (
                    row.get("country"), row.get("type"), row.get("date"),
                    row.get("period"), row.get("comparison"),
                )
                seen[key] = row
            if len(page) < MACRO_EVENT_PAGE:
                break
            offset += MACRO_EVENT_PAGE
            if offset > MACRO_EVENT_MAX_OFFSET:
                logger.warning(
                    "economic-events saturated %s..%s for %s at the offset ceiling "
                    "— rows may be missing; shrink MACRO_CHUNK_MONTHS",
                    a, b, country or "all",
                )
                break
        if on_progress:
            on_progress(IngestProgress(
                stage="calendar",
                message=f"{country or 'all'} {a[:7]}",
                done=i, total=len(windows), symbols_ok=len(seen),
            ))
    return list(seen.values())


def _num(frame: pd.DataFrame, column: str) -> pd.Series:
    if column not in frame:
        return pd.Series([np.nan] * len(frame), index=frame.index, dtype="float64")
    return pd.to_numeric(frame[column], errors="coerce")


def normalize_economic_events(rows: list[dict]) -> pd.DataFrame:
    """Raw calendar rows -> a typed frame. Pure; the testable surface.

    Future-dated rows are **kept**, flagged ``is_forecast``. The desk needs the
    upcoming calendar, and dropping them is a loss the event study would never
    notice because it only ever looks backwards.
    """
    if not rows:
        return pd.DataFrame({c: pd.Series(dtype="object") for c in EVENT_COLUMNS})

    raw = pd.DataFrame(rows)
    stamp = pd.to_datetime(raw.get("date"), errors="coerce")
    country = (
        raw.get("country", pd.Series(dtype=object))
        .astype("string").str.upper().replace(_COUNTRY_ALIASES)
    )
    out = pd.DataFrame({
        "date": stamp.dt.normalize(),
        "time": stamp.dt.strftime("%H:%M:%S"),
        "country": country,
        "type": raw.get("type", pd.Series(dtype=object)).astype("string"),
        "period": raw.get("period", pd.Series(dtype=object)).astype("string"),
        "comparison": raw.get("comparison", pd.Series(dtype=object)).astype("string"),
        "actual": _num(raw, "actual"),
        "previous": _num(raw, "previous"),
        "estimate": _num(raw, "estimate"),
        "change": _num(raw, "change"),
        "change_percentage": _num(raw, "change_percentage"),
    })
    out["event_key"] = [
        _event_key(t, c) for t, c in zip(raw.get("type", []), raw.get("comparison", []))
    ]
    # Null when either side is missing -- never derived from `previous`, which
    # would be a different statistic wearing the same label.
    out["surprise"] = out["actual"] - out["estimate"]
    out["is_forecast"] = out["actual"].isna()

    out = out[out["date"].notna()]
    out = out.drop_duplicates(
        subset=["country", "type", "date", "time", "period", "comparison"], keep="last"
    )
    return out.sort_values(["date", "country", "type"]).reset_index(drop=True)[list(EVENT_COLUMNS)]


def normalize_macro_indicator(rows: list[dict]) -> pd.DataFrame:
    """Raw annual indicator rows -> a typed frame. Pure."""
    if not rows:
        return pd.DataFrame({c: pd.Series(dtype="object") for c in INDICATOR_COLUMNS})
    raw = pd.DataFrame(rows)
    out = pd.DataFrame({
        "country_code": raw.get("CountryCode", pd.Series(dtype=object)).astype("string"),
        "country_name": raw.get("CountryName", pd.Series(dtype=object)).astype("string"),
        "indicator": raw.get("Indicator", pd.Series(dtype=object)).astype("string"),
        "date": pd.to_datetime(raw.get("Date"), errors="coerce").dt.normalize(),
        "period": raw.get("Period", pd.Series(dtype=object)).astype("string"),
        "value": _num(raw, "Value"),
    })
    out = out[out["date"].notna()]
    out = out.drop_duplicates(subset=["country_code", "indicator", "date"], keep="last")
    return out.sort_values("date").reset_index(drop=True)[list(INDICATOR_COLUMNS)]


def _write_parquet_atomic(frame: pd.DataFrame, path: Path) -> int:
    """Write via a temp file and ``os.replace``.

    ``write_market_store`` does not bother, because it rebuilds a store nobody
    reads concurrently. Here the API serves this exact file behind an mtime
    cache while the refresh job rewrites it, and ``pd.read_parquet`` on a
    half-written file raises.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    frame.to_parquet(tmp, index=False)
    os.replace(tmp, path)
    return len(frame)


def macro_calendar_path(macro_dir: Path) -> Path:
    return Path(macro_dir) / "calendar" / "events.parquet"


def macro_indicator_path(macro_dir: Path, country3: str, slug: str) -> Path:
    return Path(macro_dir) / "indicators" / country3.upper() / f"{slug}.parquet"


def write_macro_calendar(macro_dir: Path, frame: pd.DataFrame) -> int:
    return _write_parquet_atomic(frame, macro_calendar_path(macro_dir))


def write_macro_indicators(macro_dir: Path, country3: str, slug: str,
                           frame: pd.DataFrame) -> int:
    return _write_parquet_atomic(frame, macro_indicator_path(macro_dir, country3, slug))


def _write_meta(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2))
    os.replace(tmp, path)


def run_macro_refresh(
    api_key: str,
    macro_dir: Path,
    *,
    start: str = "2010-01-01",
    end: str | None = None,
    event_countries: Sequence[str] = EVENT_COUNTRIES,
    indicator_countries: Sequence[str] = INDICATOR_COUNTRIES,
    indicators: Sequence[str] | None = None,
    what: str = "all",
    on_progress: ProgressFn | None = None,
) -> dict:
    """Refresh the macro cache from EODHD. The only networked path here.

    Upcoming releases matter as much as past ones, so ``end`` defaults to a
    year ahead rather than today.
    """
    macro_dir = Path(macro_dir)
    if end is None:
        end = (pd.Timestamp.utcnow().normalize() + pd.DateOffset(years=1)).strftime("%Y-%m-%d")
    slugs = list(indicators) if indicators else list(MACRO_INDICATORS)
    summary: dict = {"calendar_rows": 0, "indicator_rows": 0, "indicators": {}, "warnings": []}

    with EodhdClient(api_key) as client:
        if what in ("all", "calendar"):
            collected: list[dict] = []
            for country in event_countries:
                collected.extend(iter_economic_events(
                    client, start=start, end=end, country=country,
                    on_progress=on_progress,
                ))
            frame = normalize_economic_events(collected)
            summary["calendar_rows"] = write_macro_calendar(macro_dir, frame)
            _write_meta(macro_dir / "calendar" / "_meta.json", {
                "fetched_at": pd.Timestamp.utcnow().isoformat(),
                "from": start, "to": end,
                "countries": list(event_countries),
                "rows": int(len(frame)),
            })

        if what in ("all", "indicators"):
            total = len(indicator_countries) * len(slugs)
            done = 0
            for country in indicator_countries:
                for slug in slugs:
                    done += 1
                    try:
                        rows = client.macro_indicator(country, slug)
                    except (EodhdError, httpx.HTTPError) as exc:
                        # EODHD 404s on a slug it does not know, and not every
                        # indicator exists for every country. One missing
                        # series is a warning on the response, never the end of
                        # a refresh that has already pulled 50,000 calendar
                        # rows.
                        summary["warnings"].append(f"{country}/{slug}: {exc}")
                        continue
                    frame = normalize_macro_indicator(rows)
                    if frame.empty:
                        continue
                    written = write_macro_indicators(macro_dir, country, slug, frame)
                    summary["indicator_rows"] += written
                    summary["indicators"][f"{country}/{slug}"] = written
                    if on_progress:
                        on_progress(IngestProgress(
                            stage="indicators", message=f"{country} {slug}",
                            done=done, total=total, symbols_ok=summary["indicator_rows"],
                        ))
            _write_meta(macro_dir / "indicators" / "_meta.json", {
                "fetched_at": pd.Timestamp.utcnow().isoformat(),
                "countries": list(indicator_countries),
                "indicators": slugs,
                "rows_by_key": summary["indicators"],
            })

    return summary
