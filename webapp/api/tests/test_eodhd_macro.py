"""The macro normalizers and pager, off recorded fixtures. No network, no key.

The fixtures in ``fixtures/`` are trimmed real responses. The interesting one
is ``economic_events.json``: it deliberately contains the same release under
two ``comparison`` bases, because collapsing those is the mistake most likely
to be made here and it destroys exactly the numbers a macro desk exists to
show.
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from webapp.ingest import eodhd

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def event_rows() -> list[dict]:
    return json.loads((FIXTURES / "economic_events.json").read_text())


@pytest.fixture
def indicator_rows() -> list[dict]:
    return json.loads((FIXTURES / "macro_indicator_usa.json").read_text())


# --------------------------------------------------------------------------
# Chunking and paging
# --------------------------------------------------------------------------
def test_months_covers_the_range_without_gaps_or_overlap():
    windows = eodhd._months("2024-01-15", "2024-04-10")
    assert windows[0][0] == "2024-01-15", "the first window starts at `start`"
    assert windows[-1][1] == "2024-04-10", "the last ends at `end`"
    for (_, end), (start, _) in zip(windows, windows[1:]):
        assert pd.Timestamp(start) == pd.Timestamp(end) + pd.Timedelta(days=1)


def test_months_handles_a_single_day():
    assert eodhd._months("2024-03-05", "2024-03-05") == [("2024-03-05", "2024-03-05")]


def test_chunk_is_monthly_because_a_quarter_saturates():
    """Verified against the live API: a quarter of US releases returns exactly
    1000 rows (the cap) while a month returns ~320-390."""
    assert eodhd.MACRO_CHUNK_MONTHS == 1
    assert eodhd.MACRO_EVENT_PAGE == 1000
    assert eodhd.MACRO_EVENT_MAX_OFFSET == 1000


class _FakeClient:
    """Serves synthetic pages and records the (window, offset) asked for."""

    def __init__(self, per_window: dict[tuple[str, str], list[dict]]):
        self.per_window = per_window
        self.calls: list[tuple[str, str, int]] = []

    def economic_events(self, *, start, end, country="", limit=1000, offset=0):
        self.calls.append((start, end, offset))
        rows = self.per_window.get((start, end), [])
        return rows[offset: offset + limit]


def _row(i: int, day: str) -> dict:
    return {"country": "US", "type": f"Event {i}", "date": f"{day} 13:30:00",
            "period": "Jan", "comparison": None, "actual": float(i),
            "previous": None, "estimate": None}


def test_pager_follows_offsets_until_a_short_page():
    window = ("2024-01-01", "2024-01-31")
    rows = [_row(i, "2024-01-10") for i in range(1500)]
    client = _FakeClient({window: rows})
    out = eodhd.iter_economic_events(client, start="2024-01-01", end="2024-01-31")
    assert len(out) == 1500, "the second page must not be dropped"
    assert [c[2] for c in client.calls] == [0, 1000]


def test_pager_stops_at_the_offset_ceiling_and_warns(caplog):
    """The only way rows can still go missing — so it must be loud."""
    window = ("2024-01-01", "2024-01-31")
    rows = [_row(i, "2024-01-10") for i in range(3000)]
    client = _FakeClient({window: rows})
    with caplog.at_level("WARNING"):
        eodhd.iter_economic_events(client, start="2024-01-01", end="2024-01-31")
    assert any("saturated" in r.message for r in caplog.records)


def test_pager_dedupes_rows_repeated_across_windows():
    shared = _row(1, "2024-01-31")
    client = _FakeClient({
        ("2024-01-01", "2024-01-31"): [shared, _row(2, "2024-01-15")],
        ("2024-02-01", "2024-02-29"): [shared, _row(3, "2024-02-15")],
    })
    out = eodhd.iter_economic_events(client, start="2024-01-01", end="2024-02-29")
    assert len(out) == 3, "the shared row is counted once"


def test_pager_visits_every_month():
    client = _FakeClient({})
    eodhd.iter_economic_events(client, start="2024-01-01", end="2024-03-31")
    assert [(c[0], c[1]) for c in client.calls] == [
        ("2024-01-01", "2024-01-31"),
        ("2024-02-01", "2024-02-29"),
        ("2024-03-01", "2024-03-31"),
    ]


# --------------------------------------------------------------------------
# Event normalizer
# --------------------------------------------------------------------------
def test_comparison_bases_are_kept_as_separate_rows(event_rows):
    """The load-bearing one.

    PCE Price Index prints a month-on-month and a year-on-year number at the
    same timestamp. Deduping on (country, type, date) would keep one and
    silently discard the other — and the discarded one is as likely to be the
    headline yoy inflation figure as not.
    """
    frame = eodhd.normalize_economic_events(event_rows)
    pce = frame[frame["type"] == "PCE Price Index"]
    assert len(pce) == 2
    assert set(pce["comparison"]) == {"mom", "yoy"}
    assert sorted(pce["actual"]) == [0.2, 2.6]
    assert pce["date"].nunique() == 1, "same release, same timestamp"


def test_event_key_distinguishes_the_bases(event_rows):
    frame = eodhd.normalize_economic_events(event_rows)
    keys = set(frame[frame["type"] == "PCE Price Index"]["event_key"])
    assert keys == {"pce_price_index__mom", "pce_price_index__yoy"}
    # A release with no comparison basis gets an unqualified key.
    claims = frame[frame["type"] == "Initial Jobless Claims"]
    assert list(claims["event_key"]) == ["initial_jobless_claims"]


def test_core_and_headline_are_different_events(event_rows):
    frame = eodhd.normalize_economic_events(event_rows)
    assert "core_pce_price_index__yoy" in set(frame["event_key"])
    assert "pce_price_index__yoy" in set(frame["event_key"])


def test_surprise_is_null_when_the_estimate_is(event_rows):
    """Never derived from `previous`, which is a different statistic."""
    rows = event_rows + [{
        "country": "US", "type": "Mystery Print", "date": "2024-01-30 13:30:00",
        "period": "Dec", "comparison": None,
        "actual": 5.0, "estimate": None, "previous": 4.0,
    }]
    frame = eodhd.normalize_economic_events(rows)
    row = frame[frame["type"] == "Mystery Print"].iloc[0]
    assert pd.isna(row["surprise"])
    assert row["previous"] == 4.0


def test_future_rows_are_kept_and_flagged():
    rows = [{
        "country": "US", "type": "Nonfarm Payrolls", "date": "2027-11-11 19:00:00",
        "period": "Oct", "comparison": None,
        "actual": None, "estimate": 170.0, "previous": 168.0,
    }]
    frame = eodhd.normalize_economic_events(rows)
    assert len(frame) == 1, "the desk needs the upcoming calendar"
    assert bool(frame.iloc[0]["is_forecast"]) is True
    assert pd.isna(frame.iloc[0]["actual"])
    assert frame.iloc[0]["estimate"] == 170.0


def test_uk_is_normalised_to_the_requested_code():
    """EODHD accepts country=GB and returns rows tagged UK.

    Storing UK means a UI filtering on GB finds nothing at all.
    """
    rows = [{"country": "UK", "type": "BoE Rate", "date": "2024-02-01 12:00:00",
             "period": "Feb", "comparison": None, "actual": 5.25,
             "estimate": 5.25, "previous": 5.25}]
    frame = eodhd.normalize_economic_events(rows)
    assert frame.iloc[0]["country"] == "GB"


def test_time_is_preserved_separately_from_the_date(event_rows):
    frame = eodhd.normalize_economic_events(event_rows)
    assert frame["date"].dt.time.unique().tolist() == [pd.Timestamp("2024-01-01").time()]
    assert all(len(t) == 8 for t in frame["time"])


def test_empty_input_still_has_the_full_schema():
    frame = eodhd.normalize_economic_events([])
    assert list(frame.columns) == list(eodhd.EVENT_COLUMNS)
    assert frame.empty


def test_unparseable_dates_are_dropped():
    rows = [
        {"country": "US", "type": "Good", "date": "2024-01-30 13:30:00",
         "period": None, "comparison": None, "actual": 1.0},
        {"country": "US", "type": "Bad", "date": "not a date",
         "period": None, "comparison": None, "actual": 1.0},
    ]
    frame = eodhd.normalize_economic_events(rows)
    assert list(frame["type"]) == ["Good"]


# --------------------------------------------------------------------------
# Indicator normalizer
# --------------------------------------------------------------------------
def test_indicator_normalizer_types_and_sorts(indicator_rows):
    frame = eodhd.normalize_macro_indicator(indicator_rows)
    assert list(frame.columns) == list(eodhd.INDICATOR_COLUMNS)
    assert frame["country_code"].iloc[0] == "USA"
    assert str(frame["period"].iloc[0]) == "Annual"
    assert frame["date"].is_monotonic_increasing
    assert pd.api.types.is_float_dtype(frame["value"])


def test_indicator_normalizer_dedupes_on_country_indicator_date(indicator_rows):
    frame = eodhd.normalize_macro_indicator(indicator_rows + indicator_rows)
    assert len(frame) == len(eodhd.normalize_macro_indicator(indicator_rows))


def test_indicator_empty_input_has_the_schema():
    frame = eodhd.normalize_macro_indicator([])
    assert list(frame.columns) == list(eodhd.INDICATOR_COLUMNS)
    assert frame.empty


def test_every_registered_indicator_slug_is_lowercase_and_unique():
    slugs = list(eodhd.MACRO_INDICATORS)
    assert slugs == [s.lower() for s in slugs]
    assert len(slugs) == len(set(slugs))
    # EODHD 404s on unknown slugs and its vocabulary is narrower than the docs;
    # these three were verified 404 and must not creep back in.
    for dead in ("gross_savings_percent_gdp", "government_debt_to_gdp",
                 "current_account_to_gdp"):
        assert dead not in eodhd.MACRO_INDICATORS


# --------------------------------------------------------------------------
# Atomic writes
# --------------------------------------------------------------------------
def test_parquet_write_is_atomic(tmp_path, event_rows):
    """The API reads this file behind an mtime cache while the job rewrites it.

    A non-atomic write means a page load can hit a half-written parquet, and
    ``pd.read_parquet`` raises on one.
    """
    frame = eodhd.normalize_economic_events(event_rows)
    path = eodhd.macro_calendar_path(tmp_path)
    written = eodhd.write_macro_calendar(tmp_path, frame)
    assert written == len(frame)
    assert path.exists()
    assert not list(path.parent.glob("*.tmp")), "no temp file is left behind"
    assert len(pd.read_parquet(path)) == len(frame)


def test_indicator_path_is_namespaced_by_country(tmp_path):
    path = eodhd.macro_indicator_path(tmp_path, "usa", "gdp_growth_annual")
    assert path.parent.name == "USA"
    assert path.name == "gdp_growth_annual.parquet"
