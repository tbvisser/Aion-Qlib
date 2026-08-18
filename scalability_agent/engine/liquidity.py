"""M3 — venue depth and market-impact model.

v1 has no order-book data (PRD open question 3), so depth per symbol is the
ADV proxy from the strategy profile scaled by the venue's
``liquidity_multiplier``: multiplier > 1 models a venue whose effective depth
at the fund's clip sizes is that many times deeper, which is exactly the
IBKR (1.0) vs UBS (1.4) distinction in the seeded catalog.
"""
from __future__ import annotations

from scalability_agent.engine import params


def impact_bps(
    trade_notional_usd: float,
    adv_usd: float,
    liquidity_multiplier: float,
    sigma_bps: float = params.DEFAULT_SIGMA_BPS,
) -> float:
    """Square-root impact of pushing ``trade_notional_usd`` through one symbol.

    Dividing by ``liquidity_multiplier`` is the whole venue story: deeper
    venues absorb the same flow at proportionally lower impact.
    """
    if adv_usd <= 0 or trade_notional_usd <= 0:
        return 0.0
    participation = trade_notional_usd / adv_usd
    return params.IMPACT_Y * sigma_bps * participation**0.5 / liquidity_multiplier


def participation(trade_notional_usd: float, adv_usd: float) -> float:
    """Share of daily volume the flow represents; capped by ``P_MAX`` upstream."""
    if adv_usd <= 0:
        return 1.0
    return trade_notional_usd / adv_usd
