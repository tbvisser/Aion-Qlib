"""Structural invariants of the macro registry.

These exist because the three mistakes they catch are all silent. A yield
log-returned produces plausible-looking garbage; a 10x-quoted alias produces
plausible-looking garbage one decimal place out; a spread between two different
units produces a number that means nothing at all. None of them raise.
"""
from __future__ import annotations

import re

import pytest

from webapp.api import macro_registry as R


def test_keys_are_well_formed_and_self_consistent():
    for key, entry in R.SERIES.items():
        assert re.fullmatch(r"[A-Z][A-Z0-9_]*", key), f"{key} is not a stable API id"
        assert entry.key == key


def test_no_percent_series_is_log_returned():
    """US3M traded at 0.01-0.02 in 2020-21.

    ``log(0.01 / 0.02)`` is a -69% "return" on a one basis point move, and
    ``log(0)`` is -inf. Asserted in both directions so neither a new percent
    series nor a changed transform can slip through.
    """
    for entry in R.SERIES.values():
        if entry.unit == "percent":
            assert entry.transform == "diff", f"{entry.key}: percent must be differenced"
        if entry.transform == "log_return":
            assert entry.unit != "percent", f"{entry.key}: log return on a percent series"


def test_index_levels_are_log_returned():
    for entry in R.SERIES.values():
        if entry.unit == "index":
            assert entry.transform == "log_return", f"{entry.key}: an index should log-return"


def test_change_unit_is_bps_only_for_percent():
    """A log_ratio differenced is not basis points — it is a relative move.

    Labelling it "bps" would put an axis off by four orders of magnitude.
    """
    assert R.get("US10Y").change_unit == "bps"
    assert R.get("SLOPE_2S10S").change_unit == "bps"
    assert R.get("CREDIT_HY_IG").change_unit == "log"
    assert R.get("COPPER_GOLD").change_unit == "log"
    assert R.get("VIX").change_unit == "log"


def test_cboe_yield_aliases_are_pinned():
    """The feed quirk, pinned so a future "cleanup" cannot 10x the yields.

    Verified against the parquet on disk: TNX last printed 46.6 where US10Y
    printed 4.651, and TYX 52.11 where US30Y printed 5.203 — but IRX printed
    3.71 where US3M printed 3.801, so it is *not* scaled. Treating all four
    alike is the mistake this test exists to prevent.
    """
    assert R.FALLBACK_SYMBOLS["US10Y"] == ("TNX", 0.1)
    assert R.FALLBACK_SYMBOLS["US30Y"] == ("TYX", 0.1)
    assert R.FALLBACK_SYMBOLS["US5Y"] == ("FVX", 0.1)
    assert R.FALLBACK_SYMBOLS["US3M"] == ("IRX", 1.0)


def test_cboe_duplicates_are_aliases_not_registry_members():
    """They are ~1.0 correlated with the US*Y series.

    As separate regressors they would make the design matrix near-singular, so
    they must resolve to the canonical key rather than stand beside it.
    """
    for symbol in ("TNX", "TYX", "FVX", "IRX"):
        assert symbol not in R.SERIES
        assert R.get(symbol) is not None
        assert R.get(symbol).key != symbol


def test_aliases_resolve_and_never_shadow():
    for alias, target in R.ALIASES.items():
        assert target in R.SERIES
        assert alias not in R.SERIES


def test_derivations_resolve_and_spreads_share_a_unit():
    for entry in R.SERIES.values():
        if entry.derivation is None:
            assert entry.source != "derived"
            continue
        assert entry.source == "derived"
        for side in R.inputs_of(entry):
            assert side in R.SERIES, f"{entry.key}: unknown leg {side}"
        if entry.derivation.kind == "spread":
            units = {R.SERIES[s].unit for s in R.inputs_of(entry)} | {entry.unit}
            assert len(units) == 1, f"{entry.key}: spread legs disagree on unit ({units})"


def test_leaves_terminate():
    for key in R.SERIES:
        leaves = R.leaves_of(key)
        assert leaves, f"{key} resolves to no leaves"
        for leaf in leaves:
            assert R.SERIES[leaf].derivation is None


def test_default_basket_is_small_diverse_and_daily():
    basket = R.default_basket()
    assert 5 <= len(basket) <= 10
    assert all(e.daily_ok for e in basket)
    groups = [e.group for e in basket]
    assert len(groups) == len(set(groups)) or groups.count("rates") <= 2, (
        "at most one regressor per group, bar the two rates dimensions"
    )


def test_basket_excludes_the_collinear_pair():
    """d(10Y) and d(10Y-2Y) share a term by construction.

    The basket carries the 2Y and the slope instead, which are far closer to
    orthogonal — policy versus term premium.
    """
    keys = {e.key for e in R.default_basket()}
    assert "SLOPE_2S10S" in keys
    assert "US2Y" in keys
    assert "US10Y" not in keys


def test_annual_indicators_are_banned_from_daily_analytics():
    """An annual print stepping once a year is not a daily regressor."""
    for key in ("CPI_YOY_US",):
        entry = R.SERIES[key]
        assert entry.daily_ok is False
        assert entry.in_basket is False
    assert all(e.daily_ok for e in R.default_basket())


def test_internal_legs_are_not_offered():
    """HYG is a leg of a credit proxy, not a macro indicator in its own right."""
    offered = {e.key for e in R.offered()}
    assert "HYG_ETF" not in offered
    assert "CREDIT_HY_IG" in offered
    assert R.INTERNAL and R.INTERNAL.isdisjoint(offered)


def test_every_group_has_at_least_one_offered_series():
    grouped = R.by_group()
    assert set(grouped) <= set(R.GROUP_ORDER)
    for group, entries in grouped.items():
        assert entries, f"{group} is empty"


@pytest.mark.parametrize("key,expected", [("tnx", "US10Y"), ("SPX", "GSPC"), ("vix", "VIX")])
def test_get_is_case_insensitive(key, expected):
    assert R.get(key).key == expected


def test_get_returns_none_for_unknown():
    assert R.get("NOT_A_SERIES") is None
    assert R.get("") is None
