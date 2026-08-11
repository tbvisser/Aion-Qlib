"""The regime classifiers, on synthetic data with known answers.

Nothing here reads this machine's cache: ``release_series``, ``calendar_frame``
and the macro reader are monkeypatched, so the assertions are about the rules
rather than about today's prints.

Every threshold is a **strict** comparison, and the boundary tests below exist
because an off-by-one-epsilon here changes a headline verdict without changing
anything visible.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from webapp.api import macro_analytics as MA
from webapp.api import macro_regime as MR
from webapp.api.macro_analytics import MacroAnalyticsError

INDEX = pd.bdate_range("2019-01-01", "2026-08-07")


def monthly(values: dict[str, float]) -> pd.Series:
    """A sparse release series: release date -> printed value."""
    return pd.Series(
        list(values.values()),
        index=pd.DatetimeIndex(pd.to_datetime(list(values.keys()))),
    ).sort_index()


def steady(start: str, months: int, first: float, step: float) -> pd.Series:
    """A monthly series marching by ``step`` from ``first``.

    ``months`` is a floor: the series always runs to the end of ``INDEX``,
    because a print more than ``MONTHLY_STALE_DAYS`` old is deliberately
    treated as a dead feed and would make every one of these tests read
    "unknown" for reasons that have nothing to do with what they assert.
    """
    dates = pd.date_range(start, INDEX[-1], freq="MS")
    if len(dates) < months:
        dates = pd.date_range(start, periods=months, freq="MS")
    return pd.Series([first + step * i for i in range(len(dates))], index=dates)


@pytest.fixture(autouse=True)
def clean_cache():
    MR.reset_cache()
    yield
    MR.reset_cache()


@pytest.fixture
def fake_sources(monkeypatch):
    """Swap every input the classifiers read."""
    releases: dict[tuple[str, str], pd.Series] = {}
    levels: dict[str, pd.Series] = {}
    calendar = {"frame": None}

    def release_series(key, country="US", column="actual"):
        return releases.get((key, country.upper()), pd.Series(dtype="float64"))

    def level(key, index=None, ffill_limit=None):
        idx = INDEX if index is None else index
        series = levels.get(key)
        return series.reindex(idx) if series is not None else pd.Series(np.nan, index=idx)

    monkeypatch.setattr(MR.macro_cache, "release_series", release_series)
    monkeypatch.setattr(MR.macro_cache, "calendar_frame", lambda: calendar["frame"])
    monkeypatch.setattr(MR.macro_cache, "calendar_mtime", lambda: 1.0)
    monkeypatch.setattr(
        MR.macro_cache, "calendar_status", lambda: {"available": True, "stale": False}
    )
    monkeypatch.setattr(MR.macro, "level", level)
    monkeypatch.setattr(MR.macro, "reference_index", lambda *a, **k: INDEX)
    return releases, levels, calendar


# --------------------------------------------------------------------------
# _direction_frame — the primitive every axis rests on
# --------------------------------------------------------------------------
def direction_at(series: pd.Series, when: str) -> str | None:
    frame = MR._direction_frame(series, INDEX)
    return frame.loc[pd.Timestamp(when), "direction"]


def test_six_month_threshold_is_strict():
    """±0.1pp exactly is flat; a hair beyond it is a direction.

    Probed from a zero base so the delta is exactly the float literal
    ``DELTA_PP``. From a base of 2.0, ``2.1 - 2.0`` is 0.100000000000000089 and
    the test would be measuring floating-point representation rather than the
    rule.
    """
    for delta, expected in ((0.1, "flat"), (0.11, "rising"),
                            (-0.1, "flat"), (-0.11, "falling")):
        series = monthly({
            "2023-07-10": 0.0,                      # ~190 days before
            "2023-10-12": 0.0,                      # ~95 days before
            "2024-01-15": delta,
        })
        assert direction_at(series, "2024-01-16") == expected, delta


def test_three_month_delta_is_only_a_tie_break():
    """The six-month change decides first; three months breaks a tie.

    A six-month move of +0.2 with a three-month move of -0.5 is *rising*.
    Inverting that precedence is the easy mistake.
    """
    decisive_6m = monthly({
        "2023-07-10": 2.0, "2023-10-12": 2.7, "2024-01-15": 2.2,
    })
    assert direction_at(decisive_6m, "2024-01-16") == "rising"

    flat_6m_moving_3m = monthly({
        "2023-07-10": 2.0, "2023-10-12": 1.8, "2024-01-15": 2.05,
    })
    assert direction_at(flat_6m_moving_3m, "2024-01-16") == "rising"


def test_no_six_month_baseline_and_a_quiet_three_months_is_unknown():
    series = monthly({"2023-12-10": 2.0, "2024-01-15": 2.02})
    assert direction_at(series, "2024-01-16") is None


def test_no_six_month_baseline_but_a_decisive_three_months_reads():
    # A print before the 90-day mark but after the 180-day one.
    series = monthly({"2023-10-01": 2.0, "2024-01-15": 2.4})
    assert direction_at(series, "2024-01-16") == "rising"


def test_a_monthly_print_goes_unknown_rather_than_stale_forward():
    """Beyond MONTHLY_STALE_DAYS the feed is dead, not flat."""
    dates = pd.date_range("2023-01-01", periods=12, freq="MS")   # ends 2023-12-01
    series = pd.Series([2.0 + 0.2 * i for i in range(12)], index=dates)
    assert direction_at(series, "2023-12-15") is not None
    assert direction_at(series, "2024-03-01") is None, "45 days is the cap"


def test_direction_is_unknown_before_the_first_print():
    series = monthly({"2024-06-10": 2.0})
    assert direction_at(series, "2024-01-02") is None


# --------------------------------------------------------------------------
# Quadrant
# --------------------------------------------------------------------------
def set_quadrant(releases, cpi: pd.Series, unrate: pd.Series):
    releases[("inflation_rate__yoy", "US")] = cpi
    releases[("unemployment_rate", "US")] = unrate


@pytest.mark.parametrize("cpi_step,unrate_step,expected", [
    (0.2, -0.2, "Reflation"),                  # inflation up, growth up
    (-0.2, -0.2, "Goldilocks"),                # inflation down, growth up
    (0.2, 0.2, "Stagflation"),                 # inflation up, growth down
    (-0.2, 0.2, "Disinflationary Slowdown"),   # both down
])
def test_all_four_quadrants(fake_sources, cpi_step, unrate_step, expected):
    releases, _, _ = fake_sources
    set_quadrant(releases,
                 steady("2024-01-01", 24, 3.0, cpi_step),
                 steady("2024-01-01", 24, 4.0, unrate_step))
    assert MR.classify_quadrant().label == expected


def test_growth_is_unemployment_inverted(fake_sources):
    """Falling unemployment is rising growth, and the delta flips sign."""
    releases, _, _ = fake_sources
    set_quadrant(releases,
                 steady("2024-01-01", 24, 3.0, 0.2),
                 steady("2024-01-01", 24, 4.0, -0.1))
    read = MR.classify_quadrant()
    assert read.growth.direction == "rising"
    assert read.growth.delta_6m > 0, "unemployment fell, so growth rose"
    assert read.growth.latest < 4.0


def test_flat_growth_is_transitional_not_falling(fake_sources):
    """Aion collapses a residually flat axis to 'falling'. We do not.

    That collapse is a systematic bearish bias and it funnels every quiet month
    into one playbook cell, whose statistics then converge on the unconditional
    average.
    """
    releases, _, calendar = fake_sources
    calendar["frame"] = None                      # no surprises, so no tie-break
    set_quadrant(releases,
                 steady("2024-01-01", 24, 3.0, 0.2),     # inflation clearly rising
                 steady("2024-01-01", 24, 4.0, 0.0))     # unemployment dead flat
    read = MR.classify_quadrant()
    assert read.label == "Transitional"
    assert read.state == "transitional"
    assert read.growth.direction == "flat", "the flat axis is still reported"
    assert read.inflation.direction == "rising"


def test_surprise_tie_break_resolves_a_flat_growth_axis(fake_sources):
    releases, _, calendar = fake_sources
    set_quadrant(releases,
                 steady("2024-01-01", 24, 3.0, 0.2),
                 steady("2024-01-01", 24, 4.0, 0.0))
    # Beats on a positive-polarity growth release over the trailing window.
    # Inside the trailing SURPRISE_WINDOW_DAYS of the read, which is INDEX[-1].
    dates = pd.date_range(INDEX[-1] - pd.Timedelta(days=75), periods=6, freq="W")
    calendar["frame"] = pd.DataFrame({
        "country": "US", "event_key": "ism_manufacturing_pmi",
        "date": dates, "surprise": 1.5,
    })
    read = MR.classify_quadrant()
    assert read.growth.direction == "rising"
    assert read.tie_break_used is True
    assert read.label == "Reflation"


def test_a_zero_tilt_leaves_growth_flat(fake_sources):
    releases, _, calendar = fake_sources
    set_quadrant(releases,
                 steady("2024-01-01", 24, 3.0, 0.2),
                 steady("2024-01-01", 24, 4.0, 0.0))
    dates = pd.date_range(INDEX[-1] - pd.Timedelta(days=75), periods=4, freq="W")
    calendar["frame"] = pd.DataFrame({
        "country": "US", "event_key": "ism_manufacturing_pmi",
        "date": dates, "surprise": [1.0, -1.0, 1.0, -1.0],
    })
    assert MR.classify_quadrant().label == "Transitional"


def test_jobless_claims_participate_with_an_inverted_sign(fake_sources):
    """Aion drops them; a beat on claims means *weaker* growth."""
    assert MR.GROWTH_SURPRISE_POLARITY["initial_jobless_claims"] == -1
    assert MR.GROWTH_SURPRISE_POLARITY["unemployment_rate"] == -1
    assert MR.GROWTH_SURPRISE_POLARITY["non_farm_payrolls"] == 1

    releases, _, calendar = fake_sources
    set_quadrant(releases,
                 steady("2024-01-01", 24, 3.0, 0.2),
                 steady("2024-01-01", 24, 4.0, 0.0))
    dates = pd.date_range(INDEX[-1] - pd.Timedelta(days=80), periods=8, freq="W")
    calendar["frame"] = pd.DataFrame({
        "country": "US", "event_key": "initial_jobless_claims",
        "date": dates, "surprise": 12.0,     # more claims than expected
    })
    read = MR.classify_quadrant()
    assert read.growth.direction == "falling"
    assert read.label == "Stagflation"


def test_quadrant_is_unknown_without_cpi(fake_sources):
    releases, _, _ = fake_sources
    releases[("unemployment_rate", "US")] = steady("2024-01-01", 24, 4.0, -0.2)
    read = MR.classify_quadrant()
    assert read.state == "unknown"
    assert "CPI" in read.reason
    assert read.growth.direction == "rising", "whatever resolved is still reported"


def test_quadrant_is_unknown_without_unemployment(fake_sources):
    releases, _, _ = fake_sources
    releases[("inflation_rate__yoy", "US")] = steady("2024-01-01", 24, 3.0, 0.2)
    read = MR.classify_quadrant()
    assert read.state == "unknown"
    assert "unemployment" in read.reason


def test_quadrant_is_unknown_with_no_calendar_at_all(fake_sources):
    read = MR.classify_quadrant()
    assert read.state == "unknown"
    assert read.reason


def test_core_inflation_is_selectable(fake_sources):
    releases, _, _ = fake_sources
    releases[("core_inflation_rate__yoy", "US")] = steady("2024-01-01", 24, 2.0, -0.2)
    releases[("unemployment_rate", "US")] = steady("2024-01-01", 24, 4.0, -0.2)
    read = MR.classify_quadrant(inflation="core")
    assert read.inflation.source_key == "core_inflation_rate__yoy"
    assert read.label == "Goldilocks"


def test_point_in_time_a_print_is_invisible_before_its_release(fake_sources):
    """The load-bearing rule.

    Keying on the reference period instead of the release date would make a
    print visible weeks early, and every historical cell a lookahead artefact.
    """
    releases, _, _ = fake_sources
    set_quadrant(
        releases,
        # A big jump released on 2025-02-15, describing January.
        monthly({"2024-08-10": 2.0, "2024-11-12": 2.05,
                 "2025-01-14": 2.05, "2025-02-15": 4.0}),
        steady("2024-01-01", 24, 4.0, -0.2),
    )
    before = MR.classify_quadrant(as_of=pd.Timestamp("2025-02-10"))
    after = MR.classify_quadrant(as_of=pd.Timestamp("2025-02-20"))
    assert before.inflation.latest == pytest.approx(2.05)
    assert after.inflation.latest == pytest.approx(4.0)
    assert before.inflation.direction != "rising"
    assert after.inflation.direction == "rising"


# --------------------------------------------------------------------------
# Rate cycle
# --------------------------------------------------------------------------
def front_end(path: list[tuple[str, float]]) -> pd.Series:
    """A daily front-end level built by forward-filling checkpoints."""
    stamps = pd.DatetimeIndex([pd.Timestamp(d) for d, _ in path])
    return pd.Series([v for _, v in path], index=stamps).reindex(INDEX).ffill()


#: (a year before, 90 days before, now) -> stage. The read is taken on
#: 2026-08-07, so the checkpoints below straddle its 365- and 90-day marks.
@pytest.mark.parametrize("year_ago,quarter_ago,now,expected", [
    (2.0, 2.5, 3.0, "Hiking"),                       # d3 +0.5, d12 +1.0
    (4.0, 3.5, 3.0, "Cutting"),                      # d3 -0.5, d12 -1.0
    (2.5, 3.0, 3.0, "Hold (post-hike plateau)"),     # d3  0.0, d12 +0.5
    (3.5, 3.0, 3.0, "Hold (post-cut trough)"),       # d3  0.0, d12 -0.5
    (3.0, 3.0, 3.0, "Neutral / on hold"),            # d3  0.0, d12  0.0
])
def test_every_rate_stage(fake_sources, year_ago, quarter_ago, now, expected):
    _, levels, _ = fake_sources
    levels["US3M"] = front_end([
        ("2019-01-01", year_ago),
        ("2025-09-01", quarter_ago),   # in force at the 365-day mark? no: after it
        ("2026-06-01", now),           # in force at the read, not at the 90-day mark
    ])
    levels["SLOPE_3M10Y"] = pd.Series(0.5, index=INDEX)
    read = MR.classify_rate_cycle(as_of=pd.Timestamp("2026-08-07"))
    assert read.stage == expected


def test_rate_step_boundary_is_strict(fake_sources):
    _, levels, _ = fake_sources
    for move, expected in ((0.125, False), (0.126, True)):
        levels["US3M"] = front_end([
            ("2019-01-01", 3.0), ("2026-05-10", 3.0), ("2026-08-06", 3.0 + move),
        ])
        stage = MR.classify_rate_cycle(as_of=pd.Timestamp("2026-08-07")).stage
        MR.reset_cache()
        assert (stage == "Hiking") is expected, move


def test_policy_overlay_uses_the_target_midpoint(fake_sources):
    """Fed decisions publish the range's UPPER bound.

    Comparing the front end against the upper bound makes it read ~12.5bp
    "below policy" even at perfect neutrality.
    """
    releases, levels, _ = fake_sources
    levels["US3M"] = pd.Series(3.625, index=INDEX)
    releases[("fed_interest_rate_decision", "US")] = monthly({"2026-06-17": 3.75})
    read = MR.classify_rate_cycle(as_of=pd.Timestamp("2026-08-07"))
    assert read.policy_rate == pytest.approx(3.75)
    assert read.front_end_vs_policy == pytest.approx(0.0), (
        "3.625 is the midpoint of a 3.50-3.75 range, so the spread is zero"
    )


def test_curve_inversion_flag(fake_sources):
    _, levels, _ = fake_sources
    levels["US3M"] = pd.Series(4.0, index=INDEX)
    for spread, inverted in ((0.0, False), (-0.2, True), (0.2, False)):
        levels["SLOPE_3M10Y"] = pd.Series(spread, index=INDEX)
        MR.reset_cache()
        assert MR.classify_rate_cycle().inverted is inverted


def test_missing_curve_leaves_inversion_unknown(fake_sources):
    _, levels, _ = fake_sources
    levels["US3M"] = pd.Series(4.0, index=INDEX)
    read = MR.classify_rate_cycle()
    assert read.curve_spread is None
    assert read.inverted is None
    assert read.stage != "unknown", "the stage does not need the curve"


def test_rate_cycle_falls_back_to_decisions_and_says_so(fake_sources):
    releases, _, _ = fake_sources
    releases[("fed_interest_rate_decision", "US")] = steady("2024-01-01", 24, 5.5, -0.1)
    read = MR.classify_rate_cycle()
    assert read.source == "fomc_decisions"
    assert read.stage != "unknown"


def test_rate_cycle_unknown_without_any_history(fake_sources):
    read = MR.classify_rate_cycle()
    assert read.stage == "unknown"
    assert read.reason


# --------------------------------------------------------------------------
# Risk appetite
# --------------------------------------------------------------------------
def flat_then(level: float, final: float, n: int = 15) -> pd.Series:
    """A constant series that steps to ``final`` for the last ``n`` sessions.

    ``n`` must be under ``RISK_WINDOW`` or the 20-day return spans two points
    inside the step and reads zero.
    """
    assert n < MR.RISK_WINDOW, "the step has to be inside the return window"
    values = pd.Series(level, index=INDEX, dtype="float64")
    values.iloc[-n:] = final
    return values


def test_risk_votes_and_label(fake_sources):
    _, levels, _ = fake_sources
    levels["GSPC"] = flat_then(100.0, 105.0)      # +5% over 20d -> risk-on
    levels["VIX"] = flat_then(20.0, 16.0)         # -20% vs median -> risk-on
    levels["DXY"] = flat_then(100.0, 98.0)        # -2% -> risk-on
    levels["BCOMGC"] = flat_then(100.0, 100.0)    # gold flat vs a rising SPX
    read = MR.classify_risk()
    assert read.label == "Risk-On"
    assert read.score > 0.25
    assert len(read.components) == 4
    assert read.missing == []


def test_risk_label_bands_are_strict():
    """Score exactly ±0.25 is Neutral. One vote in four is 0.25 — Neutral."""
    assert MR.RISK_SLUGS["Neutral"] == "neutral"
    for score, expected in ((0.25, "Neutral"), (0.2501, "Risk-On"),
                            (-0.25, "Neutral"), (-0.2501, "Risk-Off")):
        label = "Neutral"
        if score > 0.25:
            label = "Risk-On"
        elif score < -0.25:
            label = "Risk-Off"
        assert label == expected


def test_risk_refuses_below_two_votes(fake_sources):
    """Aion will print a confident label off a single leg."""
    _, levels, _ = fake_sources
    levels["GSPC"] = flat_then(100.0, 105.0)
    read = MR.classify_risk()
    assert read.label == "unknown"
    assert read.score is None
    assert str(MR.MIN_VOTES) in read.reason
    assert "VIX vs 60d median" in read.missing


def test_risk_is_unknown_with_no_prices(fake_sources):
    read = MR.classify_risk()
    assert read.label == "unknown"
    assert len(read.missing) == 4


def test_vix_vote_needs_a_full_median_window(fake_sources):
    """A 59-session median is not computed on a short window."""
    _, levels, _ = fake_sources
    short = pd.Series(np.nan, index=INDEX)
    short.iloc[-(MR.VIX_WINDOW - 1):] = 20.0
    levels["VIX"] = short
    levels["GSPC"] = flat_then(100.0, 105.0)
    levels["DXY"] = flat_then(100.0, 100.0)
    assert "VIX vs 60d median" in MR.classify_risk().missing


# --------------------------------------------------------------------------
# Market lens and the extraction
# --------------------------------------------------------------------------
def test_market_lens_matches_the_shared_axes(fake_sources):
    _, levels, _ = fake_sources
    levels["US2Y"] = pd.Series(np.linspace(1.0, 5.0, len(INDEX)), index=INDEX)
    rng = np.random.default_rng(0)
    levels["VIX"] = pd.Series(20 + rng.normal(0, 2, len(INDEX)), index=INDEX)

    axes = MA.market_regime_axes(index=INDEX)
    states = MR.market_states(INDEX)
    known = axes.rates_axis.notna() & axes.vol_axis.notna()
    expected = axes.rates_axis[known] + "_" + axes.vol_axis[known]
    pd.testing.assert_series_equal(
        states.loc[known, "state"].astype(str), expected.astype(str),
        check_names=False,
    )


def test_market_lens_is_unknown_without_history(fake_sources, monkeypatch):
    monkeypatch.setattr(MR.macro, "reference_index", lambda *a, **k: pd.DatetimeIndex([]))
    read = MR.classify_market()
    assert read.state == "unknown"
    assert read.reason


def test_regimes_bucket_days_match_the_shared_axes(fake_sources):
    """The refactor's regression guard: one axis computation, two readers."""
    _, levels, _ = fake_sources
    levels["US2Y"] = pd.Series(np.linspace(1.0, 5.0, len(INDEX)), index=INDEX)
    rng = np.random.default_rng(1)
    levels["VIX"] = pd.Series(20 + rng.normal(0, 2, len(INDEX)), index=INDEX)

    returns = pd.Series(rng.normal(0, 0.01, len(INDEX)), index=INDEX)
    report = MA.regimes(returns)
    axes = MA.market_regime_axes(index=INDEX)
    for bucket in report.buckets:
        manual = int(((axes.rates_axis == bucket.rates)
                      & (axes.vol_axis == bucket.vol)).sum())
        assert bucket.days == manual, bucket.regime


# --------------------------------------------------------------------------
# The whole read
# --------------------------------------------------------------------------
def test_current_regime_as_of_is_the_last_classified_date_not_today(fake_sources):
    """On a Sunday, "as of today" over Friday's numbers is a lie."""
    releases, levels, _ = fake_sources
    set_quadrant(releases,
                 steady("2024-01-01", 20, 3.0, 0.2),
                 steady("2024-01-01", 20, 4.0, -0.2))
    read = MR.current_regime()
    assert read.as_of is not None
    assert read.as_of <= INDEX[-1].strftime("%Y-%m-%d")
    assert read.vintage == "latest"


def test_current_regime_reports_partial_availability(fake_sources):
    """One resolved lens is enough to be available; the rest say why."""
    _, levels, _ = fake_sources
    levels["US3M"] = pd.Series(np.linspace(0.5, 5.0, len(INDEX)), index=INDEX)
    read = MR.current_regime()
    assert read.available is True
    assert read.rate_cycle.stage != "unknown"
    assert read.quadrant.state == "unknown" and read.quadrant.reason
    assert read.risk.label == "unknown" and read.risk.reason


def test_current_regime_unavailable_with_nothing_at_all(fake_sources):
    read = MR.current_regime()
    assert read.available is False
    assert read.reason


def test_headline_readings_carry_a_unit(fake_sources):
    """The hero must not hardcode '%'."""
    releases, _, _ = fake_sources
    set_quadrant(releases,
                 steady("2024-01-01", 20, 3.0, 0.2),
                 steady("2024-01-01", 20, 4.0, -0.2))
    readings = MR.current_regime().headline_readings
    assert readings
    for r in readings:
        assert r["unit"] and r["label"] and r["date"]
        assert set(r) >= {"code", "label", "unit", "value", "prior", "date"}


# --------------------------------------------------------------------------
# History
# --------------------------------------------------------------------------
def test_history_is_oldest_first_and_month_formatted(fake_sources):
    releases, _, _ = fake_sources
    set_quadrant(releases,
                 steady("2023-01-01", 40, 3.0, 0.2),
                 steady("2023-01-01", 40, 4.0, -0.2))
    months = MR.regime_history(12)
    assert len(months) == 12
    assert [m["month"] for m in months] == sorted(m["month"] for m in months)
    for m in months:
        # YYYY-MM, not YYYY-MM-01: the UI's year label keys on a January
        # suffix, and the longer form makes that test true every month.
        assert len(m["month"]) == 7 and m["month"][4] == "-"


def test_history_clamps_the_month_count(fake_sources):
    releases, _, _ = fake_sources
    set_quadrant(releases,
                 steady("2023-01-01", 40, 3.0, 0.2),
                 steady("2023-01-01", 40, 4.0, -0.2))
    assert len(MR.regime_history(0)) == 1
    assert len(MR.regime_history(10_000)) <= 120


def test_history_is_empty_without_any_macro(fake_sources, monkeypatch):
    monkeypatch.setattr(MR.macro, "reference_index", lambda *a, **k: pd.DatetimeIndex([]))
    assert MR.regime_history(24) == []


# --------------------------------------------------------------------------
# Playbook
# --------------------------------------------------------------------------
def test_every_playbook_asset_prices_as_a_log_return():
    """A bps series compounded by expm1 gives thousands of percent."""
    for asset in MR.PLAYBOOK_ASSETS:
        entry = MR.registry.get(asset.key)
        assert entry is not None, asset.key
        assert entry.change_unit == "log", asset.key


def test_a_bps_asset_is_refused_at_construction():
    bad = (MR.PlaybookAsset("US2Y", "2-year"),)
    original = MR.PLAYBOOK_ASSETS
    MR.PLAYBOOK_ASSETS = bad
    try:
        with pytest.raises(ValueError, match="log return"):
            MR._check_playbook_assets()
    finally:
        MR.PLAYBOOK_ASSETS = original


def test_playbook_recovers_a_planted_return(fake_sources, monkeypatch):
    """+0.001 log per day in one state, -0.001 in the other."""
    _, levels, _ = fake_sources
    levels["US2Y"] = pd.Series(np.linspace(1.0, 5.0, len(INDEX)), index=INDEX)
    rng = np.random.default_rng(2)
    levels["VIX"] = pd.Series(20 + rng.normal(0, 2, len(INDEX)), index=INDEX)

    states = MR.market_states(INDEX)["state"]
    rising = states.astype(str).str.startswith("rising")
    planted = pd.Series(np.where(rising, 0.001, -0.001), index=INDEX)
    monkeypatch.setattr(MR.macro, "change", lambda key, index=None, **k: planted)

    out = MR.regime_asset_performance(
        lens="market", assets=[MR.PlaybookAsset("GSPC", "US equities")], min_episodes=1
    )
    for row in out["states"]:
        cell = row["assets"][0]
        if cell["ann_return"] is None:
            continue
        expected = np.expm1(0.001 * 252) if row["state"].startswith("rising") \
            else np.expm1(-0.001 * 252)
        assert cell["ann_return"] == pytest.approx(expected, rel=1e-9)
        assert cell["hit_rate"] == pytest.approx(1.0 if row["state"].startswith("rising") else 0.0)


def test_playbook_counts_episodes_not_just_days(fake_sources, monkeypatch):
    """400 days across 2 episodes is 2 observations."""
    _, levels, _ = fake_sources
    levels["US2Y"] = pd.Series(np.linspace(1.0, 5.0, len(INDEX)), index=INDEX)
    # A constant VIX has zero rolling standard deviation, so the z-score is NaN
    # and no day classifies at all.
    levels["VIX"] = pd.Series(
        20 + np.random.default_rng(7).normal(0, 2, len(INDEX)), index=INDEX
    )
    monkeypatch.setattr(
        MR.macro, "change", lambda key, index=None, **k: pd.Series(0.0005, index=INDEX)
    )
    out = MR.regime_asset_performance(lens="market", min_episodes=1)
    for row in out["states"]:
        assert row["episodes"] >= 1
        assert row["days"] >= row["episodes"]
        assert len(row["runs"]) == row["episodes"]


def test_thin_states_report_days_but_no_statistics(fake_sources, monkeypatch):
    _, levels, _ = fake_sources
    levels["US2Y"] = pd.Series(np.linspace(1.0, 5.0, len(INDEX)), index=INDEX)
    # A constant VIX has zero rolling standard deviation, so the z-score is NaN
    # and no day classifies at all.
    levels["VIX"] = pd.Series(
        20 + np.random.default_rng(7).normal(0, 2, len(INDEX)), index=INDEX
    )
    monkeypatch.setattr(
        MR.macro, "change", lambda key, index=None, **k: pd.Series(0.0005, index=INDEX)
    )
    out = MR.regime_asset_performance(lens="market", min_days=10_000)
    for row in out["states"]:
        for cell in row["assets"]:
            assert cell["ann_return"] is None
            assert "needed" in cell["reason"]
            assert cell["n"] == row["days"], "the day count is still reported"


def test_enough_days_but_too_few_episodes_is_flagged_thin(fake_sources, monkeypatch):
    _, levels, _ = fake_sources
    levels["US2Y"] = pd.Series(np.linspace(1.0, 5.0, len(INDEX)), index=INDEX)
    # A constant VIX has zero rolling standard deviation, so the z-score is NaN
    # and no day classifies at all.
    levels["VIX"] = pd.Series(
        20 + np.random.default_rng(7).normal(0, 2, len(INDEX)), index=INDEX
    )
    monkeypatch.setattr(
        MR.macro, "change", lambda key, index=None, **k: pd.Series(0.0005, index=INDEX)
    )
    out = MR.regime_asset_performance(lens="market", min_days=1, min_episodes=10_000)
    flagged = [c for row in out["states"] for c in row["assets"] if c["thin"]]
    assert flagged
    for cell in flagged:
        assert cell["ann_return"] is not None, "the number is shown, not withheld"
        assert "episodes" in cell["reason"]


def test_playbook_refuses_an_unknown_lens(fake_sources):
    with pytest.raises(MacroAnalyticsError, match="lens"):
        MR.regime_asset_performance(lens="banana")


def test_playbook_refuses_when_nothing_is_classifiable(fake_sources):
    with pytest.raises(MacroAnalyticsError, match="classified"):
        MR.regime_asset_performance(lens="quadrant")


def test_every_lens_declares_a_caveat_and_an_order():
    for key, spec in MR.LENSES.items():
        assert spec.caveat and len(spec.caveat) > 40, key
        assert spec.order, key
        assert len(set(spec.order)) == len(spec.order), key
        for state in spec.order:
            assert state in spec.labels, f"{key}/{state}"
