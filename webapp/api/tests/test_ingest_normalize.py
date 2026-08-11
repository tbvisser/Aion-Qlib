"""The normalization contract, pinned with real numbers.

These use recorded EODHD rows rather than the network, so they run anywhere and
fail loudly if the qlib price/factor convention is ever broken.
"""
from __future__ import annotations

import numpy as np
import pytest

from webapp.ingest.eodhd import normalize_symbol

# NVDA around its 10:1 split on 2024-06-10. EODHD's `close` is the raw traded
# price (1208.88 -> 121.79); `adjusted_close` is continuous across the split.
NVDA_SPLIT_ROWS = [
    {"date": "2024-06-06", "open": 1205.0, "high": 1219.0, "low": 1150.0,
     "close": 1209.98, "adjusted_close": 120.789, "volume": 664696163},
    {"date": "2024-06-07", "open": 1164.0, "high": 1183.0, "low": 1147.0,
     "close": 1208.88, "adjusted_close": 120.6792, "volume": 412385776},
    {"date": "2024-06-10", "open": 120.37, "high": 123.10, "low": 117.01,
     "close": 121.79, "adjusted_close": 121.5796, "volume": 314162688},
    {"date": "2024-06-11", "open": 121.77, "high": 122.87, "low": 118.74,
     "close": 120.91, "adjusted_close": 120.711, "volume": 222551203},
]


@pytest.fixture
def nvda():
    return normalize_symbol(NVDA_SPLIT_ROWS, "NVDA")


def test_close_over_factor_recovers_the_raw_traded_price(nvda):
    """qlib's convention: $close / $factor is the real price.

    Verified against the bundled CN store, where SH600519 on 2020-01-02 yields
    1130.00 -- Moutai's actual close.
    """
    recovered = (nvda["close"] / nvda["factor"]).round(2).tolist()
    assert recovered == [1209.98, 1208.88, 121.79, 120.91]


def test_split_does_not_create_a_phantom_crash(nvda):
    """The adjusted close must be continuous through a 10:1 split."""
    ratio = nvda["close"].iloc[2] / nvda["close"].iloc[1]
    assert 0.99 < ratio < 1.02, f"adjusted close jumped {ratio:.3f}x across the split"


def test_change_is_the_true_return_not_the_raw_price_drop(nvda):
    """Regression: deriving `change` from EODHD's unadjusted close printed -0.899.

    EODHD's `close` is the raw traded price, unlike Yahoo's split-adjusted one,
    so `change` has to come from the adjusted series.
    """
    split_day_change = nvda["change"].iloc[2]
    assert split_day_change == pytest.approx(0.00746, abs=1e-4)
    assert nvda["change"].min() > -0.5


def test_series_is_rebased_on_the_first_valid_close(nvda):
    assert nvda["close"].iloc[0] == pytest.approx(1.0)


def test_zero_volume_bars_are_blanked_not_treated_as_flat_days():
    rows = [
        {"date": "2024-01-02", "open": 10.0, "high": 10.5, "low": 9.8,
         "close": 10.0, "adjusted_close": 10.0, "volume": 1000},
        {"date": "2024-01-03", "open": 0.0, "high": 0.0, "low": 0.0,
         "close": 0.0, "adjusted_close": 0.0, "volume": 0},
        {"date": "2024-01-04", "open": 10.2, "high": 10.6, "low": 10.0,
         "close": 10.4, "adjusted_close": 10.4, "volume": 1200},
    ]
    df = normalize_symbol(rows, "TEST")
    assert np.isnan(df["close"].iloc[1])
    # The gap must not fabricate a round-trip: the real move is 10.0 -> 10.4.
    assert df["change"].iloc[2] == pytest.approx(0.04, abs=1e-6)


def test_missing_adjusted_close_falls_back_to_factor_one():
    rows = [
        {"date": "2024-01-02", "open": 5.0, "high": 5.2, "low": 4.9, "close": 5.0, "volume": 100},
        {"date": "2024-01-03", "open": 5.1, "high": 5.3, "low": 5.0, "close": 5.5, "volume": 120},
    ]
    df = normalize_symbol(rows, "NOADJ")
    assert df["factor"].tolist() == pytest.approx([1 / 5.0, 1 / 5.0])
    assert (df["close"] / df["factor"]).round(2).tolist() == [5.0, 5.5]


def test_empty_and_malformed_input_yields_empty_frame():
    assert normalize_symbol([], "X").empty
    assert normalize_symbol([{"date": "2024-01-02", "close": 1.0}], "X").empty
