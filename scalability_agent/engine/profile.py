"""M2 — strategy fingerprint derived from normalized trades.

The whole product promise is "specific to the fund's actual strategy", so the
engine never asks the fund to describe its strategy: it measures instruments,
clip sizes and turnover from the upload itself. Everything downstream
(liquidity, costs, ceiling) consumes only the StrategyProfile produced here.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

from scalability_agent.engine import params
from scalability_agent.ingest.models import NormalizedTrade


@dataclass(frozen=True)
class StrategyProfile:
    """Measured fingerprint of the uploaded strategy.

    All notional figures are USD as-uploaded (v1 ignores FX conversion).
    ``adv_proxy_usd`` is per-symbol estimated venue daily volume, derived from
    the fund's own flow via ``HISTORICAL_PARTICIPATION`` — a v1 proxy until
    real depth data is wired in (PRD open question 3).
    """

    n_trades: int
    n_days: int
    symbols: list[str]
    daily_turnover_usd: float
    symbol_weights: dict[str, float]  # share of daily traded notional
    adv_proxy_usd: dict[str, float]
    typical_clip_usd: float  # median per-trade notional
    p90_clip_usd: float
    observed_fee_bps: float
    edge_bps: float
    turnover_fraction: float  # daily traded notional / AUM (fallback if AUM unknown)

    def to_dict(self) -> dict:
        return asdict(self)


def _percentile(sorted_values: list[float], pct: float) -> float:
    """Linear-interpolation percentile; avoids a numpy dependency here."""
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return sorted_values[0]
    rank = (pct / 100.0) * (len(sorted_values) - 1)
    low = int(rank)
    high = min(low + 1, len(sorted_values) - 1)
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (rank - low)


def build_profile(trades: list[NormalizedTrade], aum_usd: float | None = None) -> StrategyProfile:
    """Measure the strategy fingerprint from executed trades.

    ``aum_usd`` is the fund's current AUM when known; with it the turnover
    fraction is measured, without it we fall back to
    ``DEFAULT_DAILY_TURNOVER_FRACTION`` and the ceiling is correspondingly
    coarser (reflected in the confidence band, not hidden).
    """
    if not trades:
        raise ValueError("cannot profile an empty trade list")

    per_symbol: dict[str, float] = {}
    days: set = set()
    clips: list[float] = []
    fee_bps_samples: list[float] = []
    for trade in trades:
        notional = trade.notional
        per_symbol[trade.symbol] = per_symbol.get(trade.symbol, 0.0) + notional
        days.add(trade.timestamp.date())
        clips.append(notional)
        if trade.fee > 0 and notional > 0:
            fee_bps_samples.append(trade.fee / notional * 1e4)

    n_days = max(len(days), 1)
    total_notional = sum(per_symbol.values())
    daily_turnover_usd = total_notional / n_days
    symbol_weights = {s: v / total_notional for s, v in per_symbol.items()}
    adv_proxy_usd = {
        s: (v / n_days) / params.HISTORICAL_PARTICIPATION for s, v in per_symbol.items()
    }

    clips.sort()
    observed_fee_bps = (
        sum(fee_bps_samples) / len(fee_bps_samples) if fee_bps_samples else 0.0
    )
    edge_bps = (
        max(params.DEFAULT_EDGE_BPS, observed_fee_bps * params.EDGE_FEE_MULTIPLE)
        if fee_bps_samples
        else params.DEFAULT_EDGE_BPS
    )
    turnover_fraction = (
        daily_turnover_usd / aum_usd
        if aum_usd and aum_usd > 0
        else params.DEFAULT_DAILY_TURNOVER_FRACTION
    )

    return StrategyProfile(
        n_trades=len(trades),
        n_days=n_days,
        symbols=sorted(per_symbol),
        daily_turnover_usd=daily_turnover_usd,
        symbol_weights=symbol_weights,
        adv_proxy_usd=adv_proxy_usd,
        typical_clip_usd=_percentile(clips, 50),
        p90_clip_usd=_percentile(clips, 90),
        observed_fee_bps=observed_fee_bps,
        edge_bps=edge_bps,
        turnover_fraction=turnover_fraction,
    )
