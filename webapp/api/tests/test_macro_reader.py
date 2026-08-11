"""The alignment rules, on synthetic parquet with known gaps.

Each test here corresponds to one of the five rules in ``macro.py``'s
docstring. They are worth pinning individually because every one of them fails
*quietly*: the wrong answer is a number, not an exception.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from webapp.api import macro
from webapp.api.config import get_settings


@pytest.fixture
def macro_dir(tmp_path, monkeypatch):
    """A market_dir holding only what a test writes into it."""
    settings = get_settings()
    monkeypatch.setattr(settings, "market_dir", tmp_path, raising=False)
    (tmp_path / "index").mkdir(parents=True, exist_ok=True)
    (tmp_path / "etf").mkdir(parents=True, exist_ok=True)
    macro.reset_cache()
    yield tmp_path
    macro.reset_cache()


def write_series(root, symbol, dates, closes, asset_class="index"):
    """Write a parquet in the shape the ingest produces (date as a *string*)."""
    frame = pd.DataFrame({
        "symbol": symbol,
        "date": [str(d)[:10] for d in dates],
        "open": closes, "high": closes, "low": closes, "close": closes,
        "volume": [0] * len(closes), "factor": [1.0] * len(closes),
        "change": [0.0] * len(closes),
    })
    frame.to_parquet(root / asset_class / f"{symbol}.parquet")


BDAYS = pd.bdate_range("2024-01-01", "2024-03-29")


def test_yield_change_is_basis_points(macro_dir):
    write_series(macro_dir, "US10Y", BDAYS, np.linspace(4.00, 4.63, len(BDAYS)))
    change = macro.change("US10Y", BDAYS)
    level = macro.level("US10Y", BDAYS)
    step = level.iloc[1] - level.iloc[0]
    assert change.iloc[1] == pytest.approx(step * 100)
    assert change.iloc[1] == pytest.approx(1.0, abs=0.2), "a ~1bp daily step"


def test_index_change_is_a_log_return(macro_dir):
    write_series(macro_dir, "VIX", BDAYS, np.full(len(BDAYS), 20.0))
    write_series(macro_dir, "GSPC", BDAYS, 100 * 1.01 ** np.arange(len(BDAYS)))
    change = macro.change("GSPC", BDAYS)
    assert change.iloc[1] == pytest.approx(np.log(1.01))
    assert macro.change("VIX", BDAYS).iloc[1:].abs().max() == pytest.approx(0.0)


def test_weekend_rows_drop_out_and_are_never_invented(macro_dir):
    """Rule 2, first half.

    US2Y really does carry 154 weekend rows on disk. Reindexing onto the
    trading calendar has to drop them, and must not create a Saturday.
    """
    every_day = pd.date_range("2024-01-01", "2024-03-29", freq="D")
    write_series(macro_dir, "US2Y", every_day, np.linspace(4.0, 4.5, len(every_day)))
    level = macro.level("US2Y", BDAYS)
    assert len(level) == len(BDAYS)
    assert not any(d.weekday() >= 5 for d in level.index)
    assert level.notna().all()


def test_short_gap_fills_and_long_gap_does_not(macro_dir):
    """Rule 2, second half: ffill has a limit, and past it the day is null."""
    dates = list(BDAYS)
    closes = list(np.linspace(4.0, 4.5, len(dates)))
    # Punch a 3-session hole and a 9-session hole.
    keep = [i for i in range(len(dates)) if not (10 <= i < 13 or 30 <= i < 39)]
    write_series(macro_dir, "US10Y", [dates[i] for i in keep], [closes[i] for i in keep])

    level = macro.level("US10Y", BDAYS, ffill_limit=5)
    assert level.iloc[10:13].notna().all(), "a 3-session gap is within the limit"
    assert level.iloc[35:39].isna().all(), "a 9-session gap exceeds it"


def test_nothing_is_carried_past_the_last_observation(macro_dir):
    """Rule 3 — the one that would silently zero every correlation.

    Without the right-edge mask a stale cache flatlines each series, every
    change becomes 0.0, and every driver correlation reads 0.00 rather than
    reporting that there is no data.
    """
    short = BDAYS[:20]
    write_series(macro_dir, "US10Y", short, np.linspace(4.0, 4.2, len(short)))

    level = macro.level("US10Y", BDAYS)
    assert level.iloc[:20].notna().all()
    assert level.iloc[20:].isna().all()
    assert macro.change("US10Y", BDAYS).iloc[25:].isna().all()


def test_changes_come_off_the_aligned_level(macro_dir):
    """Rule 4.

    The series has a bar on a Saturday the calendar does not trade. Differenced
    before alignment, Monday's move would be measured against the Saturday and
    understated; after alignment it is Friday-to-Monday, which is the move that
    was actually tradeable.
    """
    dates = ["2024-01-05", "2024-01-06", "2024-01-08"]  # Fri, Sat, Mon
    write_series(macro_dir, "US10Y", dates, [4.00, 4.05, 4.10])
    index = pd.DatetimeIndex(pd.to_datetime(["2024-01-05", "2024-01-08"]))
    change = macro.change("US10Y", index)
    assert change.iloc[1] == pytest.approx(10.0), "Friday to Monday is 10bp, not 5"


def test_derived_spread_is_computed_after_alignment(macro_dir):
    """Rule 5: a leg missing on a date yields NaN, not a stale subtraction."""
    write_series(macro_dir, "US10Y", BDAYS, np.full(len(BDAYS), 4.50))
    write_series(macro_dir, "US2Y", BDAYS[:20], np.full(20, 4.00))

    slope = macro.level("SLOPE_2S10S", BDAYS)
    assert slope.iloc[0] == pytest.approx(0.50)
    assert slope.iloc[-1] != slope.iloc[-1], "no 2Y print, so no spread"


def test_log_ratio_guards_non_positive_legs(macro_dir):
    write_series(macro_dir, "BCOMHG", BDAYS, np.full(len(BDAYS), 500.0))
    gold = np.full(len(BDAYS), 400.0)
    gold[5] = 0.0
    write_series(macro_dir, "BCOMGC", BDAYS, gold)

    ratio = macro.level("COPPER_GOLD", BDAYS)
    assert ratio.iloc[0] == pytest.approx(np.log(500 / 400))
    assert np.isnan(ratio.iloc[5]), "log of a zero leg is masked, not -inf"
    assert np.isfinite(ratio.drop(ratio.index[5])).all()


def test_the_parquet_change_column_is_ignored(macro_dir):
    """It is a pct-change of the close, which is wrong for every yield.

    4.20 -> 4.25 is 5 basis points, not +1.19%.
    """
    dates = list(BDAYS[:3])
    frame = pd.DataFrame({
        "symbol": "US10Y", "date": [str(d)[:10] for d in dates],
        "open": [4.20, 4.25, 4.30], "high": [4.20, 4.25, 4.30],
        "low": [4.20, 4.25, 4.30], "close": [4.20, 4.25, 4.30],
        "volume": [0, 0, 0], "factor": [1.0, 1.0, 1.0],
        # A deliberately wrong pre-computed column.
        "change": [0.0, 0.0119, 0.0117],
    })
    frame.to_parquet(macro_dir / "index" / "US10Y.parquet")

    change = macro.change("US10Y", pd.DatetimeIndex(dates))
    assert change.iloc[1] == pytest.approx(5.0)


def test_fallback_alias_is_scaled_and_reported(macro_dir):
    """No US10Y.parquet, but TNX is there — and TNX quotes 10x the yield."""
    write_series(macro_dir, "TNX", BDAYS, np.full(len(BDAYS), 46.51))

    level = macro.level("US10Y", BDAYS)
    assert level.iloc[0] == pytest.approx(4.651), "TNX must be scaled by 0.1"
    assert macro.substituted_from("US10Y") == "TNX"
    assert macro.coverage("US10Y")["substituted_from"] == "TNX"


def test_irx_fallback_is_not_scaled(macro_dir):
    """The asymmetry that makes a uniform rule wrong."""
    write_series(macro_dir, "IRX", BDAYS, np.full(len(BDAYS), 3.71))
    assert macro.level("US3M", BDAYS).iloc[0] == pytest.approx(3.71)


def test_mtime_cache_reloads_after_a_rewrite(macro_dir):
    """The ingest rewrites these files while the API is up."""
    import os

    write_series(macro_dir, "US10Y", BDAYS, np.full(len(BDAYS), 4.00))
    assert macro.level("US10Y", BDAYS).iloc[0] == pytest.approx(4.00)

    write_series(macro_dir, "US10Y", BDAYS, np.full(len(BDAYS), 5.00))
    path = macro_dir / "index" / "US10Y.parquet"
    os.utime(path, (path.stat().st_atime + 10, path.stat().st_mtime + 10))
    assert macro.level("US10Y", BDAYS).iloc[0] == pytest.approx(5.00)


def test_missing_series_is_all_nan_not_an_exception(macro_dir):
    level = macro.level("N225", BDAYS)
    assert len(level) == len(BDAYS)
    assert level.isna().all()
    coverage = macro.coverage("N225")
    assert coverage["available"] is False
    assert "N225" in coverage["reason"]


def test_coverage_reports_the_intersection_for_a_derived_series(macro_dir):
    write_series(macro_dir, "US10Y", BDAYS, np.full(len(BDAYS), 4.5))
    write_series(macro_dir, "US2Y", BDAYS[5:15], np.full(10, 4.0))
    coverage = macro.coverage("SLOPE_2S10S")
    assert coverage["available"] is True
    assert coverage["first"] == str(BDAYS[5].date())
    assert coverage["last"] == str(BDAYS[14].date())


def test_catalog_lists_unavailable_series_with_a_reason(macro_dir):
    """The /models convention: say why, do not shorten the list."""
    write_series(macro_dir, "VIX", BDAYS, np.full(len(BDAYS), 20.0))
    rows = {r["key"]: r for r in macro.catalog()}
    assert rows["VIX"]["available"] is True
    assert rows["DXY"]["available"] is False
    assert rows["DXY"]["reason"]
    assert len(rows) == len(macro.catalog()), "no key appears twice"


def test_resample_takes_the_last_observation(macro_dir):
    series = pd.Series(range(len(BDAYS)), index=BDAYS, dtype=float)
    weekly = macro.resample(series, "weekly")
    assert len(weekly) < len(series)
    assert weekly.iloc[0] == pytest.approx(4.0), "Friday of the first week"
    assert macro.resample(series, "daily") is series
