"""M4 — venue cost & conditions evaluation against catalog profiles.

Venue profiles come from ``aion.venue_catalog`` rows: the row carries
``venue``/``version`` and a ``profile`` jsonb with the commercial terms
(fees, spread, minimums, liquidity multiplier). Everything here treats that
jsonb as read-only structured data so catalog updates need no code change.
"""
from __future__ import annotations

from scalability_agent.engine import liquidity, params
from scalability_agent.engine.profile import StrategyProfile


def normalize_venue(row: dict) -> dict:
    """Flatten a catalog row into one dict: profile fields + venue + version.

    The engine consumes this flat view everywhere so the rest of the code
    never has to remember which fields live in the jsonb blob.
    """
    profile = dict(row.get("profile") or {})
    return {
        "venue": row.get("venue"),
        "version": row.get("version"),
        "display_name": profile.get("display_name", row.get("venue")),
        "min_aum": float(profile.get("min_aum", 0.0)),
        "fee_bps_per_side": float(profile.get("fee_bps_per_side", 0.0)),
        "spread_bps": float(profile.get("spread_bps", 0.0)),
        "min_ticket_usd": float(profile.get("min_ticket_usd", 0.0)),
        "liquidity_multiplier": float(profile.get("liquidity_multiplier", 1.0)),
        "booking_link": profile.get("booking_link"),
    }


def is_eligible(venue: dict, aum_usd: float | None) -> bool:
    """Gate on the venue's minimum AUM. Unknown AUM cannot fail the gate."""
    if aum_usd is None:
        return True
    return aum_usd >= venue["min_aum"]


def is_near_miss(venue: dict, aum_usd: float | None) -> bool:
    """Ineligible but close — the PRD's "you almost qualify" case."""
    if aum_usd is None or is_eligible(venue, aum_usd) or venue["min_aum"] <= 0:
        return False
    return aum_usd >= venue["min_aum"] * params.NEAR_MISS_AUM_FACTOR


def daily_cost_bps(venue: dict, profile: StrategyProfile, aum_usd: float) -> dict:
    """Total daily trading cost in bps of traded notional at scaled ``aum_usd``.

    Scaling assumes the strategy keeps its measured shape: same symbol mix,
    same turnover fraction, so per-symbol daily flow grows linearly with AUM
    and impact grows with its square root.
    """
    fee_bps = venue["fee_bps_per_side"]
    spread_bps = venue["spread_bps"] * params.SPREAD_COST_FRACTION

    impact = 0.0
    max_participation = 0.0
    for symbol, weight in profile.symbol_weights.items():
        adv = profile.adv_proxy_usd[symbol]
        flow = profile.turnover_fraction * aum_usd * weight
        impact += weight * liquidity.impact_bps(flow, adv, venue["liquidity_multiplier"])
        # Participation is measured against effective depth (ADV × venue
        # multiplier), matching _liquidity_ceiling's convention.
        max_participation = max(
            max_participation,
            liquidity.participation(flow, adv * venue["liquidity_multiplier"]),
        )

    return {
        "fees_bps": fee_bps,
        "spread_bps": spread_bps,
        "impact_bps": impact,
        "total_bps": fee_bps + spread_bps + impact,
        "max_participation": max_participation,
    }
