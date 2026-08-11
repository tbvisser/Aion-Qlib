"""Build qlib stores from CSVs the ingest already downloaded.

Separate from ``eodhd.py`` because nothing here talks to the network. The bars
are on disk; this module decides which *store* they belong in, and a store is
defined by its trading calendar.

Two stores exist:

* **us_eodhd** (252-day NYSE calendar) — equities, ETFs, and now crypto/FX/
  indices clipped to that calendar. One calendar means everything in it is
  mutually backtestable, so a strategy can hold BTC and AAPL together. Crypto
  loses its weekend bars here, which is the honest model anyway: a portfolio
  containing equities can only rebalance on business days.
* **crypto_365** (365-day calendar) — crypto at full fidelity, for strategies
  that trade every day. Nothing else can join it, because the equities have no
  bars on a Sunday and every cross-sectional operator would see holes.

The market parquet store (``webapp/data/market``) is untouched by all of this:
it keeps the raw 365-day series that the Markets charts read.
"""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import pandas as pd

from .eodhd import (
    FEATURE_FIELDS, _safe_name, _write_vwap_proxy, dump_to_qlib, write_future_calendar,
)

logger = logging.getLogger(__name__)


def rebase_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Put an un-rebased frame onto the qlib store's price convention.

    Every symbol in a qlib store must share one convention or ``$close/$factor``
    stops meaning "the price actually traded". The market store keeps raw prices
    for charting; this is the same transform ``normalize_symbol(rebase=True)``
    applies, done here from the CSV so nothing has to be re-downloaded.
    """
    out = df.copy()
    closes = out["close"].dropna()
    if closes.empty:
        return pd.DataFrame()
    first_close = float(closes.iloc[0])
    if not np.isfinite(first_close) or first_close == 0:
        return pd.DataFrame()

    for col in ("open", "high", "low", "close", "factor"):
        if col in out.columns:
            out[col] = out[col] / first_close
    out["volume"] = out["volume"] * first_close
    return out


def promote_to_qlib(
    src_dirs: dict[str, Path], dst_csv_dir: Path, calendar: set[str]
) -> dict[str, list[str]]:
    """Rebase + clip a class's CSVs into the main store's staging directory.

    Clipping to the existing calendar is what keeps ``calendars/day.txt``
    byte-identical across the re-dump: dump_bin rebuilds the calendar from the
    union of all CSV dates, and a subset cannot change a union. That in turn is
    what guarantees no existing backtest shifts.
    """
    dst_csv_dir.mkdir(parents=True, exist_ok=True)
    existing = {p.stem for p in dst_csv_dir.glob("*.csv")}
    written: dict[str, list[str]] = {}

    for cls, src in src_dirs.items():
        if not src.is_dir():
            logger.warning("no CSVs for %s at %s", cls, src)
            continue
        promoted: list[str] = []
        collisions: list[str] = []
        for path in sorted(src.glob("*.csv")):
            if path.stem in existing:
                # A ticker cannot mean two things in one store. NOK is Nokia
                # *and* the Norwegian Krone; DRV is a Direxion ETF and a coin.
                # First claimant keeps the ticker; the loser is returned to the
                # caller so it can be kept out of that class's universe file --
                # listing it would point a crypto backtest at an ETF's bars.
                collisions.append(path.stem)
                continue
            try:
                df = pd.read_csv(path)
            except Exception:
                logger.exception("unreadable %s", path)
                continue
            if df.empty:
                continue
            df = df[df["date"].isin(calendar)]
            if df.empty:
                continue
            df = rebase_frame(df)
            if df.empty:
                continue
            df = df[["symbol", "date", *FEATURE_FIELDS]]
            df.to_csv(dst_csv_dir / f"{path.stem}.csv", index=False)
            existing.add(path.stem)
            promoted.append(str(df["symbol"].iloc[0]))
        if collisions:
            logger.warning("%s: %d ticker collisions skipped (kept out of the "
                           "%s universe): %s", cls, len(collisions), cls, collisions[:10])
        written[cls] = promoted
        logger.info("%s: promoted %d symbols into the main store", cls, len(promoted))
    return written


def build_standalone_store(
    src_csv_dir: Path, staging_dir: Path, qlib_dir: Path, repo_root: Path
) -> dict:
    """Build a store with its own calendar from one class's CSVs.

    No date clipping and no non-trading-day pruning: the calendar is exactly the
    union of the dates these symbols traded, which for crypto is every day.
    """
    staging_dir.mkdir(parents=True, exist_ok=True)
    for old in staging_dir.glob("*.csv"):
        old.unlink()

    written = 0
    for path in sorted(src_csv_dir.glob("*.csv")):
        try:
            df = pd.read_csv(path)
        except Exception:
            logger.exception("unreadable %s", path)
            continue
        if df.empty:
            continue
        df = rebase_frame(df)
        if df.empty:
            continue
        df[["symbol", "date", *FEATURE_FIELDS]].to_csv(staging_dir / path.name, index=False)
        written += 1

    if not written:
        raise RuntimeError(f"no usable CSVs in {src_csv_dir}")

    dump_to_qlib(staging_dir, qlib_dir, repo_root, mode="all")
    _write_vwap_proxy(qlib_dir, overwrite=True)
    write_future_calendar(qlib_dir)

    days = [
        line.strip()
        for line in (qlib_dir / "calendars" / "day.txt").read_text().splitlines()
        if line.strip()
    ]
    return {"symbols": written, "calendar_days": len(days),
            "start": days[0] if days else None, "end": days[-1] if days else None}


def dollar_volume(csv_dir: Path, symbol: str, lookback: int = 250) -> float:
    """Median close*volume over the last ``lookback`` bars.

    The rebase divides close and multiplies volume by the same constant, so this
    product is scale-invariant -- it means the same thing for a rebased equity
    and a raw crypto series, which is what makes the ranking comparable.
    """
    path = csv_dir / f"{_safe_name(symbol)}.csv"
    if not path.exists():
        return 0.0
    try:
        df = pd.read_csv(path, usecols=["close", "volume"]).tail(lookback)
    except Exception:
        return 0.0
    product = (df["close"] * df["volume"]).replace([np.inf, -np.inf], np.nan).dropna()
    return float(product.median()) if len(product) else 0.0


def write_universe_file(qlib_dir: Path, name: str, csv_dir: Path, symbols: list[str]) -> int:
    """instruments/<name>.txt with each symbol's real first/last traded date.

    Per-symbol spans (rather than one global span) are what let qlib exclude a
    name from dates it did not trade -- a crypto listed in 2021 must not appear
    in a 2015 cross-section.
    """
    instruments_dir = qlib_dir / "instruments"
    instruments_dir.mkdir(parents=True, exist_ok=True)

    lines: list[str] = []
    for symbol in symbols:
        path = csv_dir / f"{_safe_name(symbol)}.csv"
        if not path.exists():
            continue
        try:
            df = pd.read_csv(path, usecols=["date", "close"])
        except Exception:
            continue
        traded = df.loc[df["close"].notna(), "date"]
        if traded.empty:
            continue
        lines.append(f"{symbol}\t{traded.iloc[0]}\t{traded.iloc[-1]}")

    if not lines:
        return 0
    (instruments_dir / f"{name}.txt").write_text("\n".join(lines) + "\n")
    return len(lines)
