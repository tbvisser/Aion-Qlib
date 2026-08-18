"""Engine math tests: profile, impact law, ceiling, ranking, eligibility."""
from __future__ import annotations

import pytest

from scalability_agent.engine import costs, liquidity, params
from scalability_agent.engine.ceiling import evaluate_ceiling
from scalability_agent.engine.compare import compare_venues
from scalability_agent.engine.profile import build_profile
from scalability_agent.tests.conftest import IBKR_ROW, UBS_ROW


def test_profile_measures_shape(trades):
    profile = build_profile(trades, aum_usd=20_000_000)
    assert profile.n_trades == 200
    assert profile.n_days == 20
    assert profile.symbols == ["AAPL", "MSFT"]
    # 10 trades/day * $10k clips = $100k daily turnover.
    assert profile.daily_turnover_usd == 100_000.0
    assert profile.symbol_weights == {"AAPL": 0.5, "MSFT": 0.5}
    assert profile.typical_clip_usd == 10_000.0
    # ADV proxy: own daily flow per symbol ($50k) at 5% participation = $1M.
    assert profile.adv_proxy_usd["AAPL"] == 1_000_000.0
    # Edge: observed 3 bps fees * multiple 3 = 9 bps, floored at default 50.
    assert profile.observed_fee_bps == pytest.approx(3.0)
    assert profile.edge_bps == params.DEFAULT_EDGE_BPS
    assert profile.turnover_fraction == 100_000.0 / 20_000_000


def test_profile_edge_uses_fee_multiple_when_fees_are_high(trades):
    expensive = [t.__class__(**{**t.__dict__, "fee": t.notional * 0.0040}) for t in trades]
    profile = build_profile(expensive, aum_usd=20_000_000)
    assert profile.edge_bps == 40.0 * params.EDGE_FEE_MULTIPLE


def test_profile_unknown_aum_uses_turnover_fallback(trades):
    profile = build_profile(trades, aum_usd=None)
    assert profile.turnover_fraction == params.DEFAULT_DAILY_TURNOVER_FRACTION


def test_impact_square_root_law():
    # Quadrupling flow doubles impact; deeper venue divides it.
    base = liquidity.impact_bps(10_000, 1_000_000, 1.0)
    assert liquidity.impact_bps(40_000, 1_000_000, 1.0) == base * 2.0
    assert liquidity.impact_bps(10_000, 1_000_000, 2.0) == base / 2.0
    assert liquidity.impact_bps(0, 1_000_000, 1.0) == 0.0


def test_deeper_venue_lowers_daily_cost(trades):
    profile = build_profile(trades, aum_usd=20_000_000)
    ibkr = costs.normalize_venue(IBKR_ROW)
    ubs = costs.normalize_venue(UBS_ROW)
    at = 50_000_000
    ibkr_cost = costs.daily_cost_bps(ibkr, profile, at)
    ubs_cost = costs.daily_cost_bps(ubs, profile, at)
    assert ubs_cost["impact_bps"] < ibkr_cost["impact_bps"]
    assert ubs_cost["fees_bps"] + ubs_cost["spread_bps"] < ibkr_cost["fees_bps"] + ibkr_cost["spread_bps"]
    assert ubs_cost["total_bps"] < ibkr_cost["total_bps"]


def test_ubs_ceiling_strictly_above_ibkr(trades):
    """The PRD's worked scenario: the same strategy must scale further on the
    deeper, cheaper venue — otherwise the engine cannot justify the product."""
    profile = build_profile(trades, aum_usd=20_000_000)
    ibkr = evaluate_ceiling(costs.normalize_venue(IBKR_ROW), profile, 20_000_000)
    ubs = evaluate_ceiling(costs.normalize_venue(UBS_ROW), profile, 20_000_000)
    assert ubs["ceiling_usd"] > ibkr["ceiling_usd"]
    assert ibkr["confidence_band_usd"]["low"] < ibkr["ceiling_usd"] < ibkr["confidence_band_usd"]["high"]
    assert ibkr["decomposition"]["impact_bps"] > 0


def test_ceiling_never_exceeds_participation_cap(trades):
    profile = build_profile(trades, aum_usd=20_000_000)
    venue = costs.normalize_venue(UBS_ROW)
    result = evaluate_ceiling(venue, profile, 20_000_000)
    at = costs.daily_cost_bps(venue, profile, result["ceiling_usd"])
    assert at["max_participation"] <= params.P_MAX + 1e-9


def test_min_aum_eligibility_and_near_miss(trades):
    profile = build_profile(trades, aum_usd=18_000_000)
    comparison = compare_venues([IBKR_ROW, UBS_ROW], "IBKR", profile, 18_000_000)
    ubs = next(a for a in comparison["alternatives"] if a["venue"] == "UBS")
    # $18M vs $20M minimum: ineligible but a near miss (>= 80% of the gate).
    assert ubs["eligible"] is False
    assert ubs["near_miss"] is True
    assert any("almost qualify" in r for r in ubs["reasons"])
    # Ineligible venues must never be recommended, even with a higher ceiling.
    assert comparison["best_alternative"] is None


def test_far_from_min_aum_is_not_near_miss(trades):
    profile = build_profile(trades, aum_usd=5_000_000)
    comparison = compare_venues([IBKR_ROW, UBS_ROW], "IBKR", profile, 5_000_000)
    ubs = next(a for a in comparison["alternatives"] if a["venue"] == "UBS")
    assert ubs["eligible"] is False
    assert ubs["near_miss"] is False


def test_eligible_ubs_is_ranked_and_recommended(trades):
    profile = build_profile(trades, aum_usd=25_000_000)
    comparison = compare_venues([IBKR_ROW, UBS_ROW], "IBKR", profile, 25_000_000)
    best = comparison["best_alternative"]
    assert best is not None
    assert best["venue"] == "UBS"
    assert best["eligible"] is True
    assert best["ceiling_usd"] > comparison["current"]["ceiling_usd"]
    assert best["reasons"]  # plain-language why, non-empty
    assert best["booking_link"] == "https://example.com/book/ubs"
