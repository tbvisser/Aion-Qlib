"""A portfolio's NAV, computed from real bars.

Four decisions here are not preferences, and getting any of them wrong
produces a curve that looks entirely plausible and is wrong:

1. **NAV is built from returns, never from prices x shares.** ``$close`` in the
   qlib store is back-adjusted *and rebased* to ~1.0 at each symbol's first bar
   (see ``ingest/eodhd.py``'s docstring), so a price-times-shares NAV mixing
   ``SPY`` at ~1.0 with ``BTC-USD`` at ~$63,000 raw produces numbers that pass
   the eye test and mean nothing. Returns are scale-invariant, so the rebasing
   stops mattering.

2. **Adjusted close, not ``$close / $factor``.** Dividing by the factor
   recovers the traded price, which would silently drop fifteen years of SPY
   dividends from a total-return NAV.

3. **The coarsest calendar wins.** If any holding or the benchmark lives in the
   qlib store, the whole book is put on the equity trading calendar. A 60/40
   book with a ``BTC-USD`` benchmark evaluated on a 365-day index would
   forward-fill ``SPY`` across every weekend and understate volatility by
   roughly 20%. The consequence -- a Saturday crypto move landing in Monday's
   return -- is correct, because Saturday was not tradeable.

4. **Returns are computed after reindexing.** The other order smuggles a
   three-day crypto weekend into a single Monday twice over.

The output is deliberately key-compatible with ``results.build_report``:
``curves.nav`` carries ``NAV_t / NAV_0 - 1``, the same unit as
``curves.strategy``, so one chart component and one macro-analytics path serve
a backtest and a portfolio interchangeably.
"""
from __future__ import annotations

import logging
import math
import threading
from typing import Literal

import numpy as np
import pandas as pd

from . import marketdata
from .portfolios import PortfolioSpec

logger = logging.getLogger(__name__)

TRADING_DAYS = 252
#: A holding may be carried this many sessions before a gap is a real gap.
FFILL_LIMIT = 5

#: USD per one unit of the currency (True), or units per USD (False). Every
#: instrument in this dataset is USD-quoted, so base-currency conversion is one
#: extra return leg on the NAV rather than a per-holding FX translation.
_FX_FOR_CCY: dict[str, tuple[str, bool]] = {
    "EUR": ("EURUSD", True),
    "GBP": ("GBPUSD", True),
    "JPY": ("USDJPY", False),
    "CHF": ("USDCHF", False),
}

_cache_lock = threading.Lock()
_nav_cache: dict[tuple, dict] = {}
_CACHE_MAX = 32


class NavError(ValueError):
    """A portfolio that cannot be priced. The message is user-facing."""


def _clean(value) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


# --------------------------------------------------------------------------
# Prices
# --------------------------------------------------------------------------
def price_series(symbol: str, start: str | None = None,
                 end: str | None = None) -> tuple[pd.Series, str] | None:
    """A total-return price series for ``symbol``, and the store it came from.

    Market-store assets (crypto, FX, indices) have no corporate actions, so
    their raw close *is* the total-return series. Everything else comes from
    qlib's adjusted ``$close``.
    """
    entry = marketdata.entry_for(symbol)
    if entry is None:
        return None

    if entry["st"] == "market":
        rows = marketdata.bars(symbol, start, end)
        if not rows:
            return None
        index = pd.DatetimeIndex(pd.to_datetime([r["time"] for r in rows])).normalize()
        series = pd.Series([r["close"] for r in rows], index=index, dtype="float64")
        series = series[~series.index.duplicated(keep="last")].sort_index().dropna()
        return (series, "market") if not series.empty else None

    from . import qlib_session

    state = qlib_session.init_qlib()
    if not state.get("ready"):
        return None
    try:
        from qlib.data import D

        frame = D.features([symbol], ["$close"], start_time=start, end_time=end)
    except Exception:
        logger.warning("qlib read failed for %s", symbol, exc_info=True)
        return None
    if frame is None or frame.empty:
        return None
    series = frame["$close"]
    if isinstance(series.index, pd.MultiIndex):
        series = series.droplevel(0)
    series = pd.Series(
        pd.to_numeric(series, errors="coerce").to_numpy(),
        index=pd.DatetimeIndex(pd.to_datetime(series.index)).normalize(),
    )
    series = series[~series.index.duplicated(keep="last")].sort_index().dropna()
    return (series, "qlib") if not series.empty else None


def _is_qlib(symbol: str) -> bool:
    entry = marketdata.entry_for(symbol)
    return entry is not None and entry["st"] == "qlib"


def reference_index(symbols: list[str], start: str, end: str | None,
                    priced: dict[str, pd.Series]) -> pd.DatetimeIndex:
    """The sessions the book is evaluated on. Coarsest calendar wins."""
    if any(_is_qlib(s) for s in symbols):
        store = marketdata.store_for("us")
        if store is not None and store["exists"]:
            from pathlib import Path

            path = Path(store["provider_uri"]) / "calendars" / "day.txt"
            try:
                days = [d.strip() for d in path.read_text().splitlines() if d.strip()]
            except OSError:
                days = []
            if days:
                index = pd.DatetimeIndex(pd.to_datetime(days)).normalize()
                return _clip(index, start, end)

    union: pd.DatetimeIndex | None = None
    for series in priced.values():
        union = series.index if union is None else union.union(series.index)
    if union is None:
        return pd.DatetimeIndex([])
    return _clip(pd.DatetimeIndex(union).sort_values(), start, end)


def _clip(index: pd.DatetimeIndex, start: str | None, end: str | None) -> pd.DatetimeIndex:
    if start:
        index = index[index >= pd.Timestamp(start)]
    if end:
        index = index[index <= pd.Timestamp(end)]
    return index


def _returns_on(series: pd.Series, index: pd.DatetimeIndex) -> pd.Series:
    """Reindex first, then difference. Decision 4 in the module docstring."""
    aligned = series.reindex(index).ffill(limit=FFILL_LIMIT)
    aligned[aligned.index > series.index.max()] = np.nan
    return (aligned / aligned.shift(1) - 1.0).replace([np.inf, -np.inf], np.nan)


def _rebalance_dates(index: pd.DatetimeIndex, rule: str) -> set[pd.Timestamp]:
    """The last session of each period — when weights snap back to target."""
    if rule == "none" or len(index) == 0:
        return set()
    freq = {"monthly": "M", "quarterly": "Q", "annual": "Y"}[rule]
    series = index.to_series()
    return set(series.groupby(index.to_period(freq)).max())


# --------------------------------------------------------------------------
# NAV
# --------------------------------------------------------------------------
def build_nav(spec: PortfolioSpec, start: str | None = None,
              end: str | None = None, portfolio_id: str = "",
              updated_at: str = "") -> dict:
    """Price a portfolio and return its curves, metrics and contributions."""
    cache_key = (portfolio_id, updated_at, start, end)
    if portfolio_id and updated_at:
        with _cache_lock:
            hit = _nav_cache.get(cache_key)
        if hit is not None:
            return hit

    start = start or spec.inception
    warnings: list[str] = list(spec.validate_weights())
    unpriced: list[dict] = []
    priced: dict[str, pd.Series] = {}
    sources: dict[str, str] = {}

    wanted = [h.symbol for h in spec.holdings]
    for symbol in wanted:
        found = price_series(symbol, start, end)
        if found is None:
            unpriced.append({
                "symbol": symbol,
                "reason": "no price history in either data store over this window",
            })
            continue
        priced[symbol], sources[symbol] = found

    if not priced:
        raise NavError(
            "none of this portfolio's holdings could be priced — check the symbols, "
            "or run the data ingest"
        )

    benchmark_series = price_series(spec.benchmark, start, end)
    if benchmark_series is None:
        warnings.append(
            f"benchmark {spec.benchmark} has no price history over this window; "
            "the NAV is shown without one"
        )

    calendar_symbols = list(priced) + ([spec.benchmark] if benchmark_series else [])
    index = reference_index(calendar_symbols, start, end, priced)
    if len(index) < 2:
        raise NavError(
            f"only {len(index)} trading session(s) between {start} and "
            f"{end or 'today'} — not enough to compute a NAV"
        )

    if any(sources.get(s) == "market" for s in priced) and any(
        sources.get(s) == "qlib" for s in priced
    ):
        warnings.append(
            "this book mixes 365-day and exchange-traded assets; it is evaluated on "
            "the exchange calendar, so a weekend move in the 365-day leg lands in "
            "Monday's return — which is when it could first have been traded"
        )

    returns = pd.DataFrame(
        {s: _returns_on(series, index) for s, series in priced.items()}, index=index
    ).fillna(0.0)

    for symbol, series in priced.items():
        first = series.index.min()
        if first > index[0]:
            warnings.append(
                f"{symbol} has no bars before {first:%Y-%m-%d}; it contributes "
                "nothing to the book before then"
            )

    targets = np.array([
        h.weight for h in spec.holdings if h.symbol in priced
    ], dtype=float)
    symbols = [h.symbol for h in spec.holdings if h.symbol in priced]
    matrix = returns[symbols].to_numpy(dtype=float)

    rebalance_on = _rebalance_dates(index, spec.rebalance)
    cost_rate = spec.cost_bps / 1e4

    weights = targets.copy()
    gross = np.zeros(len(index))
    net = np.zeros(len(index))
    turnover_total = 0.0
    contribution = np.zeros(len(symbols))

    for t in range(1, len(index)):
        step = matrix[t]
        period_return = float(weights @ step)
        contribution += weights * step
        gross[t] = period_return
        charged = 0.0
        # Drift: a holding that rose is now a bigger share of the book. Cash
        # (1 - sum of weights) is carried implicitly and earns nothing.
        denom = 1.0 + period_return
        if abs(denom) > 1e-12:
            weights = weights * (1.0 + step) / denom
        if index[t] in rebalance_on:
            turnover = 0.5 * float(np.abs(weights - targets).sum())
            turnover_total += turnover
            charged = turnover * cost_rate
            weights = targets.copy()
        net[t] = period_return - charged

    # Base currency as an extra return leg, not a level conversion.
    #
    # Applied to the gross stream as well as the net one. Translating only the
    # net curve leaves `cost_drag = gross - nav` measuring the currency move
    # instead of the costs -- the EUR 60/40 reported a -9.7% "cost drag" that
    # was entirely EURUSD, against 0.08% for the identical USD book.
    base_note = None
    if spec.base_ccy != "USD":
        net, _, base_note = _apply_fx(spec.base_ccy, net, index)
        gross, _, _ = _apply_fx(spec.base_ccy, gross, index)

    nav_curve = np.cumprod(1.0 + net) - 1.0
    gross_curve = np.cumprod(1.0 + gross) - 1.0

    bench_curve = None
    if benchmark_series is not None:
        bench_returns = _returns_on(benchmark_series[0], index).fillna(0.0).to_numpy()
        bench_curve = np.cumprod(1.0 + bench_returns) - 1.0

    years = max((index[-1] - index[0]).days / 365.25, 1e-9)
    sd = float(np.std(net[1:], ddof=1)) if len(net) > 2 else 0.0
    total_return = float(nav_curve[-1])
    peak = np.maximum.accumulate(1.0 + nav_curve)
    drawdown = (1.0 + nav_curve) / peak - 1.0

    report = {
        "portfolio_id": portfolio_id or None,
        "base_ccy": spec.base_ccy,
        "benchmark": spec.benchmark if benchmark_series else None,
        "rebalance": spec.rebalance,
        "period": {
            "start": index[0].strftime("%Y-%m-%d"),
            "end": index[-1].strftime("%Y-%m-%d"),
            "days": int(len(index)),
        },
        "curves": {
            "nav": _points(index, nav_curve),
            "gross": _points(index, gross_curve),
            "benchmark": _points(index, bench_curve) if bench_curve is not None else [],
            "excess": (
                _points(index, nav_curve - bench_curve) if bench_curve is not None else []
            ),
            "drawdown": _points(index, drawdown),
        },
        "metrics": {
            "total_return": _clean(total_return),
            "annualised_return": _clean((1.0 + total_return) ** (1.0 / years) - 1.0),
            "annualised_vol": _clean(sd * np.sqrt(TRADING_DAYS)),
            "sharpe": _clean(np.mean(net[1:]) / sd * np.sqrt(TRADING_DAYS)) if sd > 0 else None,
            "max_drawdown": _clean(float(drawdown.min())),
            "annual_turnover": _clean(turnover_total / years),
            "cost_drag": _clean(float(gross_curve[-1] - nav_curve[-1])),
            "hit_rate": _clean(float((net[1:] > 0).mean())) if len(net) > 1 else None,
        },
        "contribution": [
            {
                "symbol": symbol,
                "asset_class": (marketdata.entry_for(symbol) or {}).get("c"),
                "name": (marketdata.entry_for(symbol) or {}).get("n"),
                "source": sources.get(symbol),
                "weight": _clean(target),
                "total_return": _clean(float(np.prod(1.0 + matrix[1:, i]) - 1.0)),
                "contribution": _clean(float(contribution[i])),
            }
            for i, (symbol, target) in enumerate(zip(symbols, targets))
        ],
        "allocation": _allocation(symbols, targets),
        "unpriced": unpriced,
        "warnings": warnings + ([base_note] if base_note else []),
    }

    if portfolio_id and updated_at:
        with _cache_lock:
            if len(_nav_cache) >= _CACHE_MAX:
                _nav_cache.clear()
            _nav_cache[cache_key] = report
    return report


def _apply_fx(base_ccy: str, net: np.ndarray,
              index: pd.DatetimeIndex) -> tuple[np.ndarray, np.ndarray, str]:
    """Translate a USD return stream into ``base_ccy``.

    ``r_base = (1 + r_usd) / (1 + r_fx) - 1`` where ``r_fx`` is the return of
    the base currency against the dollar. A missing FX series is a refusal, not
    a silent fallback to USD -- reporting a EUR book's return in dollars while
    labelling it EUR is exactly the kind of quiet lie this codebase avoids.
    """
    pair = _FX_FOR_CCY.get(base_ccy)
    if pair is None:
        raise NavError(f"no FX series is configured for {base_ccy}")
    symbol, usd_per_unit = pair
    found = price_series(symbol)
    if found is None:
        raise NavError(
            f"cannot report this book in {base_ccy}: no {symbol} history is "
            "available to convert with"
        )
    fx_returns = _returns_on(found[0], index).fillna(0.0).to_numpy()
    if not usd_per_unit:
        # Quoted as units-per-USD, so the base currency's move is the inverse.
        fx_returns = 1.0 / (1.0 + fx_returns) - 1.0
    converted = (1.0 + net) / (1.0 + fx_returns) - 1.0
    note = (
        f"holdings are USD-quoted; returns are translated into {base_ccy} using "
        f"{symbol}, so this book carries the currency move as well as the assets"
    )
    return converted, np.cumprod(1.0 + converted) - 1.0, note


def _allocation(symbols: list[str], weights: np.ndarray) -> list[dict]:
    """Target weights grouped by asset class, with the residual as cash."""
    buckets: dict[str, float] = {}
    for symbol, weight in zip(symbols, weights):
        entry = marketdata.entry_for(symbol)
        key = (entry or {}).get("c", "equity")
        buckets[key] = buckets.get(key, 0.0) + float(weight)
    residual = 1.0 - float(np.sum(weights))
    if abs(residual) > 1e-6:
        buckets["cash"] = residual
    labels = {"equity": "Equity", "etf": "Funds", "index": "Indices",
              "crypto": "Crypto", "fx": "FX", "cash": "Cash"}
    return [
        {"asset_class": k, "label": labels.get(k, k.title()), "weight": _clean(v)}
        for k, v in sorted(buckets.items(), key=lambda kv: -abs(kv[1]))
    ]


def _points(index: pd.DatetimeIndex, values) -> list[dict]:
    return [
        {"date": stamp.strftime("%Y-%m-%d"), "value": _clean(value)}
        for stamp, value in zip(index, values)
    ]


def resolve(spec: PortfolioSpec) -> dict:
    """Dry-run the pricing without computing a NAV, for /portfolios/validate."""
    resolved, unpriced = [], []
    for holding in spec.holdings:
        found = price_series(holding.symbol, spec.inception, None)
        if found is None:
            unpriced.append({
                "symbol": holding.symbol,
                "reason": "no price history in either data store",
            })
            continue
        series, source = found
        resolved.append({
            "symbol": holding.symbol,
            "source": source,
            "first": series.index.min().strftime("%Y-%m-%d"),
            "last": series.index.max().strftime("%Y-%m-%d"),
            "n": int(len(series)),
        })
    return {
        "resolved": resolved,
        "unpriced": unpriced,
        "warnings": spec.validate_weights(),
        "errors": spec.validate_holdings(),
    }
