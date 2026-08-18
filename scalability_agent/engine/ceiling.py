"""M5 — ceiling engine: the AUM at which costs consume the strategy's edge.

Two independent caps are computed and the lower one wins:

- **cost ceiling** — binary search for the AUM where total daily cost bps
  (fees + spread + square-root impact) equals the estimated edge bps. Beyond
  it the strategy trades away more than it earns.
- **liquidity ceiling** — the AUM where the largest symbol flow reaches
  ``P_MAX`` of that symbol's estimated ADV, solved in closed form. Beyond it
  the square-root model itself stops being credible, so this is a hard cap.

The result always carries a decomposition (what caps it) and a coarse
confidence band — PRD: "confidence intervals, not a single point number".
"""
from __future__ import annotations

from scalability_agent.engine import costs, params
from scalability_agent.engine.profile import StrategyProfile


def _cost_ceiling(venue: dict, profile: StrategyProfile) -> float:
    edge = profile.edge_bps
    # If even a token AUM loses money, the venue is simply uneconomic.
    if costs.daily_cost_bps(venue, profile, params.CEILING_SEARCH_MIN_AUM)["total_bps"] >= edge:
        return params.CEILING_SEARCH_MIN_AUM
    lo, hi = params.CEILING_SEARCH_MIN_AUM, params.CEILING_SEARCH_MAX_AUM
    if costs.daily_cost_bps(venue, profile, hi)["total_bps"] < edge:
        # Costs never catch the edge within the credible range.
        return hi
    for _ in range(params.BISECTION_ITERS):
        mid = (lo + hi) / 2.0
        if costs.daily_cost_bps(venue, profile, mid)["total_bps"] >= edge:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2.0


def _liquidity_ceiling(venue: dict, profile: StrategyProfile) -> float:
    """AUM where the heaviest symbol's participation hits ``P_MAX``.

    Participation is measured against *effective* depth — the ADV proxy
    scaled by the venue's liquidity multiplier, the same convention
    ``liquidity.impact_bps`` documents. Without the multiplier here every
    venue would share one venue-independent liquidity cap and a deeper venue
    could never lift the ceiling when participation is what binds (which is
    precisely the IBKR→UBS case the tool exists to surface).
    """
    f = profile.turnover_fraction
    if f <= 0:
        return params.CEILING_SEARCH_MAX_AUM
    cap = params.CEILING_SEARCH_MAX_AUM
    for symbol, weight in profile.symbol_weights.items():
        adv = profile.adv_proxy_usd[symbol] * venue["liquidity_multiplier"]
        if weight <= 0 or adv <= 0:
            continue
        cap = min(cap, params.P_MAX * adv / (f * weight))
    return cap


def evaluate_ceiling(venue: dict, profile: StrategyProfile, aum_usd: float | None) -> dict:
    """Ceiling estimate for one venue: value, band, and what binds."""
    cost_cap = _cost_ceiling(venue, profile)
    liq_cap = _liquidity_ceiling(venue, profile)
    ceiling = min(cost_cap, liq_cap)
    binding = "liquidity" if liq_cap <= cost_cap else "impact"

    at_ceiling = costs.daily_cost_bps(venue, profile, ceiling)
    # At the ceiling, how much of the consumed edge is explicit costs vs
    # impact — the "what is capping me" answer the report leads with.
    decomposition = {
        "edge_bps": profile.edge_bps,
        "fees_bps": at_ceiling["fees_bps"],
        "spread_bps": at_ceiling["spread_bps"],
        "impact_bps": at_ceiling["impact_bps"],
        "explicit_costs_share": (
            (at_ceiling["fees_bps"] + at_ceiling["spread_bps"]) / at_ceiling["total_bps"]
            if at_ceiling["total_bps"] > 0
            else 0.0
        ),
    }

    return {
        "venue": venue["venue"],
        "display_name": venue["display_name"],
        "eligible": costs.is_eligible(venue, aum_usd),
        "near_miss": costs.is_near_miss(venue, aum_usd),
        "ceiling_usd": ceiling,
        "confidence_band_usd": {
            "low": ceiling * params.CEILING_CONFIDENCE_LOW_MULT,
            "high": ceiling * params.CEILING_CONFIDENCE_HIGH_MULT,
        },
        "binding_constraint": binding,
        "decomposition": decomposition,
        "conditions": {
            "min_aum": venue["min_aum"],
            "min_ticket_usd": venue["min_ticket_usd"],
            # A ticket minimum above the fund's current clip size forces
            # larger orders — a conditions note, not a scalability cap.
            "min_ticket_above_typical_clip": venue["min_ticket_usd"] > profile.typical_clip_usd,
        },
        "booking_link": venue["booking_link"],
    }
