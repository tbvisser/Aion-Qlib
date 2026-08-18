"""M6 — venue comparison, ranking and plain-language "why".

Guardrail from the PRD: never *recommend* a venue the fund doesn't qualify
for — ineligible venues are evaluated (so the report can say what they'd be
worth) but ranked separately, with near-miss eligibility surfaced explicitly.
"""
from __future__ import annotations

from scalability_agent.engine import ceiling, costs
from scalability_agent.engine.profile import StrategyProfile


def _fmt_usd(value: float) -> str:
    if value >= 1e9:
        return f"${value / 1e9:.1f}B"
    if value >= 1e6:
        return f"${value / 1e6:.0f}M"
    if value >= 1e3:
        return f"${value / 1e3:.0f}K"
    return f"${value:.0f}"


def _reasons(entry: dict, current: dict, venue: dict, aum_usd: float | None) -> list[str]:
    """Plain-language explanations a fund can act on (PRD M6)."""
    reasons: list[str] = []
    if not entry["eligible"]:
        if entry["near_miss"]:
            reasons.append(
                f"You almost qualify: {venue['display_name']} requires a minimum of "
                f"{_fmt_usd(venue['min_aum'])} AUM and you are at ~{_fmt_usd(aum_usd or 0)}."
            )
        else:
            reasons.append(
                f"Requires a minimum of {_fmt_usd(venue['min_aum'])} AUM — "
                f"not eligible at your current size."
            )
        return reasons

    fee_now = current["decomposition"]["fees_bps"] + current["decomposition"]["spread_bps"]
    fee_new = entry["decomposition"]["fees_bps"] + entry["decomposition"]["spread_bps"]
    if fee_new < fee_now:
        reasons.append(
            f"Lower explicit costs: {fee_new:.1f} bps vs {fee_now:.1f} bps per side "
            f"on your current venue."
        )
    cur_mult = current.get("liquidity_multiplier", 1.0)
    if venue["liquidity_multiplier"] > cur_mult:
        reasons.append(
            f"Deeper book at your clip size: liquidity multiplier "
            f"{venue['liquidity_multiplier']:.1f}x vs {cur_mult:.1f}x."
        )
    if current["ceiling_usd"] > 0:
        delta = entry["ceiling_usd"] / current["ceiling_usd"] - 1.0
        if delta > 0.01:
            reasons.append(
                f"Estimated {delta:.0%} more headroom: ceiling "
                f"{_fmt_usd(entry['ceiling_usd'])} vs {_fmt_usd(current['ceiling_usd'])}."
            )
    if not reasons:
        reasons.append("No material advantage over your current venue for this strategy.")
    return reasons


def compare_venues(
    venue_rows: list[dict],
    current_venue: str,
    profile: StrategyProfile,
    aum_usd: float | None,
) -> dict:
    """Evaluate every catalog venue for this strategy and rank the eligible ones."""
    venues = [costs.normalize_venue(row) for row in venue_rows]
    if not venues:
        raise ValueError("venue catalog is empty")

    current = next((v for v in venues if v["venue"] == current_venue), None)
    if current is None:
        # The fund's current venue may not be in the catalog; rank everything
        # against the weakest venue rather than failing the whole report.
        current = min(venues, key=lambda v: v["liquidity_multiplier"])

    current_result = ceiling.evaluate_ceiling(current, profile, aum_usd)
    current_result["liquidity_multiplier"] = current["liquidity_multiplier"]

    alternatives = []
    for venue in venues:
        if venue["venue"] == current["venue"]:
            continue
        entry = ceiling.evaluate_ceiling(venue, profile, aum_usd)
        entry["liquidity_multiplier"] = venue["liquidity_multiplier"]
        entry["fee_bps_per_side"] = venue["fee_bps_per_side"]
        entry["reasons"] = _reasons(entry, current_result, venue, aum_usd)
        alternatives.append(entry)

    eligible = sorted(
        (a for a in alternatives if a["eligible"]),
        key=lambda a: a["ceiling_usd"],
        reverse=True,
    )
    ineligible = sorted(
        (a for a in alternatives if not a["eligible"]),
        key=lambda a: (not a["near_miss"], -a["ceiling_usd"]),
    )

    best = eligible[0] if eligible and eligible[0]["ceiling_usd"] > current_result["ceiling_usd"] else None
    return {
        "current_venue": current["venue"],
        "current": current_result,
        "alternatives": eligible + ineligible,
        "best_alternative": best,
        "aum_usd": aum_usd,
    }
