"""The typical-price proxy pass, against a store small enough to hand-check.

The dangerous property is not the arithmetic — it is the header. A qlib `.bin`
begins with one float32 holding the index into `calendars/day.txt` of the
instrument's first bar. Write the right values behind the wrong header and every
number stays plausible while the whole series sits on the wrong dates, which is
a corruption no census, no chart and no backtest can detect.

So the tests that matter here are the ones about headers, about refusing to
guess, and about `features/` mtime — the last because `census` caches on it, and
a fix invisible to a running API is a fix that did not land.
"""
from __future__ import annotations

import numpy as np
import pytest

from webapp.api.factorlab.stores import census
from webapp.ingest.vwap import typical_price, write_vwap_proxy

NAN = float("nan")


def write_bin(path, header: float, values: list[float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    np.hstack([np.array([header]), np.array(values)]).astype("<f4").tofile(path)


def read_bin(path) -> np.ndarray:
    return np.fromfile(path, dtype="<f4")


def make_store(tmp_path, instruments: dict[str, dict]):
    """`instruments` maps a name to `{field: (header, values)}`."""
    root = tmp_path / "store"
    (root / "calendars").mkdir(parents=True, exist_ok=True)
    for name, fields in instruments.items():
        for field, (header, values) in fields.items():
            write_bin(root / "features" / name / f"{field}.day.bin", header, values)
    return root


def ohlc(header: float, highs, lows, closes) -> dict:
    return {"high": (header, highs), "low": (header, lows), "close": (header, closes)}


@pytest.fixture
def store(tmp_path):
    return make_store(tmp_path, {
        "aaa": ohlc(0.0, [11.0, 12.0, 13.0], [9.0, 10.0, 11.0], [10.0, 11.0, 12.0]),
        # A non-zero header: the instrument's first bar is the fourth calendar
        # day. This is the ordinary case for anything listed after the store's
        # start date, and the case a reconstructed header would ruin.
        "bbb": ohlc(3.0, [21.0, 22.0], [19.0, 20.0], [20.0, 21.0]),
    })


# --------------------------------------------------------------------------
# The arithmetic
# --------------------------------------------------------------------------

def test_typical_price_is_the_mean_of_high_low_close():
    out = typical_price(
        np.array([0.0, 11.0, 12.0], dtype="<f4"),
        np.array([0.0, 9.0, 10.0], dtype="<f4"),
        np.array([0.0, 10.0, 11.0], dtype="<f4"),
    )
    assert out[1] == pytest.approx(10.0)
    assert out[2] == pytest.approx(11.0)


def test_a_missing_input_leaves_a_gap_rather_than_inventing_a_bar():
    """NaN propagates, matching what `close` already does on that day."""
    out = typical_price(
        np.array([0.0, 11.0, NAN], dtype="<f4"),
        np.array([0.0, 9.0, 10.0], dtype="<f4"),
        np.array([0.0, 10.0, 11.0], dtype="<f4"),
    )
    assert out[1] == pytest.approx(10.0)
    assert np.isnan(out[2])


# --------------------------------------------------------------------------
# The header — the one corruption nothing downstream can see
# --------------------------------------------------------------------------

def test_the_header_is_copied_not_recomputed(store):
    write_vwap_proxy(store)

    for name in ("aaa", "bbb"):
        vwap = read_bin(store / "features" / name / "vwap.day.bin")
        close = read_bin(store / "features" / name / "close.day.bin")
        assert vwap[0] == close[0]
        assert len(vwap) == len(close)

    assert read_bin(store / "features" / "bbb" / "vwap.day.bin")[0] == pytest.approx(3.0)


def test_an_instrument_whose_inputs_disagree_is_skipped_and_named(tmp_path):
    """A header mismatch means the frames were not dumped together.

    Averaging them would silently align two different date ranges. The only safe
    answer is no column at all — which everything downstream already handles.
    """
    root = make_store(tmp_path, {
        "good": ohlc(0.0, [11.0], [9.0], [10.0]),
        "bad": {"high": (5.0, [11.0]), "low": (0.0, [9.0]), "close": (0.0, [10.0])},
    })
    report = write_vwap_proxy(root)

    assert report["mismatched"] == ["bad"]
    assert not (root / "features" / "bad" / "vwap.day.bin").exists()
    assert (root / "features" / "good" / "vwap.day.bin").exists()


def test_an_instrument_missing_a_source_field_is_skipped_and_named(tmp_path):
    root = make_store(tmp_path, {
        "good": ohlc(0.0, [11.0], [9.0], [10.0]),
        "partial": {"high": (0.0, [11.0]), "close": (0.0, [10.0])},
    })
    report = write_vwap_proxy(root)

    assert report["missing_source"] == ["partial"]
    assert not (root / "features" / "partial" / "vwap.day.bin").exists()


def test_differing_lengths_are_refused(tmp_path):
    root = make_store(tmp_path, {
        "ragged": {"high": (0.0, [11.0, 12.0]), "low": (0.0, [9.0]), "close": (0.0, [10.0])},
    })
    report = write_vwap_proxy(root)
    assert report["mismatched"] == ["ragged"]


# --------------------------------------------------------------------------
# Re-running
# --------------------------------------------------------------------------

def test_a_second_pass_leaves_the_bytes_untouched(store):
    write_vwap_proxy(store)
    path = store / "features" / "aaa" / "vwap.day.bin"
    before = path.read_bytes()

    report = write_vwap_proxy(store)

    assert report["written"] == 0
    assert report["already_present"] == 2
    assert path.read_bytes() == before


def test_overwrite_recomputes_from_the_current_bars(store):
    write_vwap_proxy(store)
    path = store / "features" / "aaa" / "vwap.day.bin"

    # A re-dump moved the bars. Without --overwrite the stale proxy would sit
    # beside fresh prices forever.
    write_bin(store / "features" / "aaa" / "close.day.bin", 0.0, [100.0, 110.0, 120.0])
    write_bin(store / "features" / "aaa" / "high.day.bin", 0.0, [110.0, 120.0, 130.0])
    write_bin(store / "features" / "aaa" / "low.day.bin", 0.0, [90.0, 100.0, 110.0])

    report = write_vwap_proxy(store, overwrite=True)

    assert report["written"] == 2
    assert read_bin(path)[1] == pytest.approx(100.0)


def test_no_temporary_files_are_left_behind(store):
    write_vwap_proxy(store)
    assert not list(store.rglob("*.tmp"))


# --------------------------------------------------------------------------
# The census contract
# --------------------------------------------------------------------------

def test_the_features_directory_mtime_moves(store):
    """`census` caches on this mtime, and per-instrument writes do not move it.

    Without the explicit touch the new column is invisible to a running API
    until it restarts — the whole fix silently not landing.
    """
    features = store / "features"
    before = features.stat().st_mtime
    os_utime_marker = before - 100
    import os
    os.utime(features, (os_utime_marker, os_utime_marker))

    write_vwap_proxy(store)

    assert features.stat().st_mtime > os_utime_marker


def test_a_complete_pass_makes_vwap_a_field_not_a_partial(store):
    assert "vwap" not in census(store)["fields"]

    write_vwap_proxy(store)

    after = census(store)
    assert "vwap" in after["fields"]
    assert "vwap" not in after["partial"]


def test_a_half_finished_pass_reports_vwap_as_partial(tmp_path):
    """Which is what keeps `_dead_columns` conservative.

    `partial` means "some instruments have it". A strategy trained against that
    silently drops the names that lack the column, so it must not be mistaken
    for a column the whole store carries.
    """
    root = make_store(tmp_path, {
        "aaa": ohlc(0.0, [11.0], [9.0], [10.0]),
        "bbb": ohlc(0.0, [21.0], [19.0], [20.0]),
        "ccc": ohlc(0.0, [31.0], [29.0], [30.0]),
    })
    # One instrument covered, as an interrupted alphabetical walk would leave it.
    write_bin(root / "features" / "aaa" / "vwap.day.bin", 0.0, [10.0])

    reported = census(root)
    assert "vwap" in reported["partial"]
    assert "vwap" not in reported["fields"]


# --------------------------------------------------------------------------
# --verify
# --------------------------------------------------------------------------

def test_verify_writes_nothing_and_reports_what_is_missing(store):
    report = write_vwap_proxy(store, verify=True)

    assert report["written"] == 0
    assert sorted(report["mismatched"]) == ["aaa", "bbb"]
    assert not list(store.rglob("vwap.day.bin"))


def test_verify_passes_after_a_real_pass(store):
    write_vwap_proxy(store)
    report = write_vwap_proxy(store, verify=True)

    assert report["skipped"] == 0
    assert report["already_present"] == 2


def test_verify_catches_a_stale_column(store):
    """The case `census` cannot see: the column exists, and is wrong.

    `census` only asks whether the file is there. After a re-dump moved the
    bars, a proxy written against the old ones is present, plausible and stale.
    """
    write_vwap_proxy(store)
    write_bin(store / "features" / "aaa" / "close.day.bin", 0.0, [100.0, 110.0, 120.0])
    write_bin(store / "features" / "aaa" / "high.day.bin", 0.0, [110.0, 120.0, 130.0])
    write_bin(store / "features" / "aaa" / "low.day.bin", 0.0, [90.0, 100.0, 110.0])

    report = write_vwap_proxy(store, verify=True)
    assert report["mismatched"] == ["aaa"]


def test_a_store_with_no_features_directory_is_an_error(tmp_path):
    with pytest.raises(FileNotFoundError):
        write_vwap_proxy(tmp_path / "nothing-here")
