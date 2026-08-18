"""The macro and portfolio HTTP surfaces.

No network and no real data store: the macro reader and cache are
monkeypatched. The assertions are about the contract -- status codes, the
cold-cache convention, and the guarantee that every payload is JSON.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from webapp.api import macro, macro_cache
from webapp.api.main import app
from webapp.api.routers import macro as macro_router

BDAYS = pd.bdate_range("2022-01-03", periods=700)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def fake_macro(monkeypatch):
    """A macro reader over synthetic series, with VIX deliberately absent."""
    rng = np.random.default_rng(0)
    levels = {
        "US3M": pd.Series(np.linspace(3.0, 3.8, len(BDAYS)), index=BDAYS),
        "US2Y": pd.Series(np.linspace(3.5, 4.2, len(BDAYS)), index=BDAYS),
        "US5Y": pd.Series(np.linspace(3.6, 4.35, len(BDAYS)), index=BDAYS),
        "US10Y": pd.Series(np.linspace(3.8, 4.65, len(BDAYS)), index=BDAYS),
        "US30Y": pd.Series(np.linspace(4.0, 5.2, len(BDAYS)), index=BDAYS),
        "GSPC": pd.Series(4000 * np.cumprod(1 + rng.normal(0, 0.01, len(BDAYS))), index=BDAYS),
    }

    def level(key, index=None, ffill_limit=None):
        idx = BDAYS if index is None else index
        series = levels.get(key)
        if series is None:
            return pd.Series(np.nan, index=idx)
        return series.reindex(idx)

    def change(key, index=None, ffill_limit=None):
        return level(key, index).diff()

    def coverage(key):
        if key in levels:
            return {"available": True, "reason": None, "source": "market",
                    "first": "2022-01-03", "last": "2024-09-06",
                    "n": len(BDAYS), "substituted_from": None}
        return {"available": False, "reason": f"no data on disk for {key}",
                "source": "market"}

    monkeypatch.setattr(macro, "level", level)
    monkeypatch.setattr(macro, "change", change)
    monkeypatch.setattr(macro, "levels",
                        lambda keys, index=None, ffill=None: pd.DataFrame(
                            {k: level(k, index) for k in keys},
                            index=BDAYS if index is None else index))
    monkeypatch.setattr(macro, "coverage", coverage)
    monkeypatch.setattr(macro, "reference_index", lambda *a, **k: BDAYS)
    monkeypatch.setattr(macro, "substituted_from", lambda key: None)
    monkeypatch.setattr(
        macro, "catalog",
        lambda: [{"key": e.key, "label": e.label, "group": e.group,
                  "unit": e.unit, "change_unit": e.change_unit,
                  "source": e.source, "derived": e.derivation is not None,
                  "in_basket": e.in_basket, "daily_ok": e.daily_ok,
                  "note": e.note, **coverage(e.key)}
                 for e in __import__("webapp.api.macro_registry",
                                     fromlist=["x"]).offered()],
    )
    return levels


@pytest.fixture
def cold_cache(monkeypatch):
    monkeypatch.setattr(macro_cache, "calendar_status", lambda: {
        "available": False, "rows": 0, "fetched_at": None, "age_seconds": None,
        "stale": True, "countries": [], "from": None, "to": None,
        "reason": "no economic calendar cached yet — run POST /api/macro/refresh",
    })
    monkeypatch.setattr(macro_cache, "indicator_status", lambda: {
        "available": False, "series": 0, "fetched_at": None, "age_seconds": None,
        "stale": True, "countries": [],
        "reason": "no country indicators cached yet — run POST /api/macro/refresh",
    })


# --------------------------------------------------------------------------
# Series
# --------------------------------------------------------------------------
def test_series_lists_unavailable_with_a_reason(client, fake_macro):
    """The /models convention: say why, do not shorten the list."""
    body = client.get("/api/macro/series").json()
    rows = [s for g in body["groups"] for s in g["series"]]
    keys = {r["key"] for r in rows}
    assert "VIX" in keys, "an unavailable series is still listed"
    vix = next(r for r in rows if r["key"] == "VIX")
    assert vix["available"] is False and vix["reason"]
    assert next(r for r in rows if r["key"] == "US10Y")["available"] is True
    assert body["basket"] and body["count"] == len(rows)


def test_series_groups_are_ordered(client, fake_macro):
    body = client.get("/api/macro/series").json()
    assert [g["group"] for g in body["groups"]][:2] == ["rates", "inflation"]
    assert all(g["label"] for g in body["groups"])


def test_unknown_series_is_404(client, fake_macro):
    assert client.get("/api/macro/series/NOPE").status_code == 404


def test_series_data_carries_points_and_units(client, fake_macro):
    body = client.get("/api/macro/series/US10Y").json()
    assert body["unit"] == "percent" and body["change_unit"] == "bps"
    assert len(body["points"]) == len(BDAYS)
    assert body["points"][0]["date"] == "2022-01-03"


def test_series_resample_reduces_points(client, fake_macro):
    daily = client.get("/api/macro/series/US10Y").json()["points"]
    monthly = client.get("/api/macro/series/US10Y?resample=monthly").json()["points"]
    assert 0 < len(monthly) < len(daily)


def test_snapshot_shape(client, fake_macro):
    body = client.get("/api/macro/snapshot").json()
    assert body["as_of"] == "2024-09-06"
    rows = {r["key"]: r for r in body["rows"]}
    assert rows["US10Y"]["available"] is True
    assert rows["US10Y"]["level"] == pytest.approx(4.65, abs=0.01)
    assert rows["US10Y"]["change_1d"] is not None
    assert len(rows["US10Y"]["spark"]) == 90


def test_snapshot_zscore_is_null_not_zero_without_history(client, fake_macro):
    """A fabricated zero would tint the tile as "normal"."""
    rows = {r["key"]: r for r in client.get("/api/macro/snapshot").json()["rows"]}
    assert rows["VIX"]["available"] is False
    assert rows["VIX"]["zscore"] is None
    assert rows["VIX"]["level"] is None


def test_yield_changes_are_basis_points(client, fake_macro):
    rows = {r["key"]: r for r in client.get("/api/macro/snapshot").json()["rows"]}
    # ~0.85 percentage points over 700 sessions -> ~0.12bp a day.
    assert 0 < abs(rows["US10Y"]["change_1d"]) < 5
    assert rows["US10Y"]["change_unit"] == "bps"


def test_curve_returns_five_tenors_and_a_comparison(client, fake_macro):
    body = client.get("/api/macro/curve?compare=2023-01-03").json()
    assert [t["tenor"] for t in body["current"]["tenors"]] == \
        ["3M", "2Y", "5Y", "10Y", "30Y"]
    assert body["compare"]["resolved_date"] == "2023-01-03"


def test_curve_reports_the_day_it_actually_drew(client, fake_macro):
    """A weekend request must say which trading day it fell back to."""
    body = client.get("/api/macro/curve?date=2024-09-08").json()  # a Sunday
    assert body["current"]["date"] == "2024-09-08"
    assert body["current"]["resolved_date"] == "2024-09-06"


def test_curve_before_all_history_is_404(client, fake_macro):
    assert client.get("/api/macro/curve?date=1990-01-01").status_code == 404


# --------------------------------------------------------------------------
# Cold cache
# --------------------------------------------------------------------------
def test_cold_calendar_is_200_with_a_reason_not_404(client, cold_cache):
    """A 404 would say the feature does not exist. It exists; it is empty."""
    response = client.get("/api/macro/calendar")
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is False
    assert "refresh" in body["reason"]
    assert body["past"] == [] and body["upcoming"] == []


def test_cold_indicators_is_200_with_a_reason(client, cold_cache):
    body = client.get("/api/macro/indicators?country=USA").json()
    assert body["available"] is False and body["reason"]
    assert body["indicators"] == []


def test_cold_calendar_types_is_200_with_a_reason(client, cold_cache):
    body = client.get("/api/macro/calendar/types").json()
    assert body["available"] is False and body["types"] == []


def test_calendar_exposes_cache_coverage_beside_the_query_window(client, monkeypatch):
    """`from`/`to` echo the query; the cache's own span must survive too.

    The Inbox month grid needs the cache span to say "outside the cached
    window" for an empty month instead of implying no releases occurred.
    """
    monkeypatch.setattr(macro_cache, "calendar_status", lambda: {
        "available": True, "rows": 3, "fetched_at": "2026-08-11T00:00:00",
        "age_seconds": 60.0, "stale": False, "countries": ["US"],
        "from": "2015-01-01", "to": "2026-09-30",
    })
    monkeypatch.setattr(macro_cache, "releases",
                        lambda start, end, country, type_, limit: [])
    body = client.get("/api/macro/calendar",
                      params={"from": "2026-08-01", "to": "2026-08-31"}).json()
    assert body["cache_from"] == "2015-01-01"
    assert body["cache_to"] == "2026-09-30"
    assert body["from"] == "2026-08-01" and body["to"] == "2026-08-31"


# --------------------------------------------------------------------------
# Calendar history
# --------------------------------------------------------------------------
_WARM_CALENDAR_STATUS = {
    "available": True, "rows": 11, "fetched_at": "2026-08-11T00:00:00",
    "age_seconds": 60.0, "stale": False, "countries": ["US", "DE"],
    "from": "2015-01-01", "to": "2027-08-11",
}


def _calendar_history_frame() -> pd.DataFrame:
    """Six filed US CPI prints, one stale unfiled one, two pending, plus
    a DE row and a different event to prove the filters."""
    def row(date, actual, event_key="inflation_rate__yoy", country="US"):
        estimate = 2.5
        return {
            "date": pd.Timestamp(date), "time": "13:30:00", "country": country,
            "type": "Inflation Rate", "event_key": event_key, "period": None,
            "comparison": "yoy", "actual": actual, "previous": 2.6,
            "estimate": estimate, "change": -0.1, "change_percentage": -3.8,
            "surprise": actual - estimate, "is_forecast": pd.isna(actual),
        }
    return pd.DataFrame([
        row("2026-01-13", 3.0),
        row("2026-02-11", 2.9),
        row("2026-03-10", np.nan),   # unfiled past print — never a chart point
        row("2026-04-10", 2.8),
        row("2026-05-12", 2.7),
        row("2026-06-10", 2.6),
        row("2026-07-14", 2.4),
        row("2026-08-12", np.nan),   # next pending — kept as the estimate marker
        row("2026-09-10", np.nan),   # later pending — dropped
        row("2026-06-10", 2.2, country="DE"),
        row("2026-06-15", 51.0, event_key="ism_manufacturing_pmi"),
    ])


@pytest.fixture
def warm_history(monkeypatch):
    monkeypatch.setattr(macro_cache, "calendar_status",
                        lambda: dict(_WARM_CALENDAR_STATUS))
    monkeypatch.setattr(macro_cache, "calendar_frame", _calendar_history_frame)


def test_calendar_history_cold_cache_is_200_with_a_reason(client, cold_cache):
    body = client.get("/api/macro/calendar/history",
                      params={"event_key": "inflation_rate__yoy"}).json()
    assert body["available"] is False
    assert body["reason"]
    assert body["points"] == []


def test_calendar_history_is_release_dated_oldest_first(client, warm_history):
    body = client.get("/api/macro/calendar/history",
                      params={"event_key": "inflation_rate__yoy",
                              "country": "US"}).json()
    assert body["available"] is True
    dates = [p["date"] for p in body["points"]]
    assert dates == ["2026-01-13", "2026-02-11", "2026-04-10", "2026-05-12",
                     "2026-06-10", "2026-07-14", "2026-08-12"]
    # Null-actual rows never chart except the single next pending print.
    pending = [p["date"] for p in body["points"] if p["actual"] is None]
    assert pending == ["2026-08-12"]
    assert all(p["importance"] == "headline" for p in body["points"])
    assert all("change" in p and "change_percentage" in p
               for p in body["points"])


def test_calendar_history_respects_limit(client, warm_history):
    body = client.get("/api/macro/calendar/history",
                      params={"event_key": "inflation_rate__yoy",
                              "country": "US", "limit": 4}).json()
    dates = [p["date"] for p in body["points"]]
    # Trailing 4 filed prints plus the pending marker; older prints fall off.
    assert dates == ["2026-04-10", "2026-05-12", "2026-06-10", "2026-07-14",
                     "2026-08-12"]


def test_calendar_history_unknown_key_is_empty_but_available(client, warm_history):
    body = client.get("/api/macro/calendar/history",
                      params={"event_key": "no_such_event"}).json()
    assert body["available"] is True
    assert body["points"] == []


def test_calendar_annotates_importance(client, monkeypatch):
    monkeypatch.setattr(macro_cache, "calendar_status",
                        lambda: dict(_WARM_CALENDAR_STATUS))
    monkeypatch.setattr(
        macro_cache, "releases",
        lambda *a, **k: [
            {"date": "2026-08-01", "event_key": "inflation_rate__yoy"},
            {"date": "2026-08-20", "event_key": "baker_hughes_oil_rig_count"},
        ])
    body = client.get("/api/macro/calendar").json()
    rows = {r["event_key"]: r for r in body["past"] + body["upcoming"]}
    assert rows["inflation_rate__yoy"]["importance"] == "headline"
    assert rows["baker_hughes_oil_rig_count"]["importance"] == "standard"


def test_release_row_keeps_change_fields():
    row = pd.Series({
        "date": pd.Timestamp("2026-07-14"), "time": "13:30:00", "country": "US",
        "type": "Inflation Rate", "event_key": "inflation_rate__yoy",
        "period": None, "comparison": "yoy", "actual": 2.4, "previous": 2.6,
        "estimate": 2.5, "surprise": -0.1, "change": -0.2,
        "change_percentage": np.nan, "is_forecast": False,
    })
    out = macro_cache._release_row(row)
    assert out["change"] == -0.2
    assert out["change_percentage"] is None


# --------------------------------------------------------------------------
# Refresh job
# --------------------------------------------------------------------------
def test_refresh_without_a_key_is_400(client, monkeypatch):
    from webapp.api.config import get_settings

    monkeypatch.setattr(get_settings(), "eodhd_api_key", "", raising=False)
    response = client.post("/api/macro/refresh", json={"what": "all"})
    assert response.status_code == 400
    assert "EODHD_API_KEY" in response.json()["detail"]


def test_second_refresh_is_409(client, monkeypatch):
    from webapp.api.config import get_settings

    monkeypatch.setattr(get_settings(), "eodhd_api_key", "x", raising=False)
    monkeypatch.setattr(macro_router._executor, "submit", lambda *a, **k: None)
    macro_router._JOBS.clear()
    try:
        first = client.post("/api/macro/refresh", json={"what": "calendar"})
        assert first.status_code == 200
        second = client.post("/api/macro/refresh", json={"what": "calendar"})
        assert second.status_code == 409
    finally:
        macro_router._JOBS.clear()


def test_unknown_job_is_404(client):
    assert client.get("/api/macro/refresh/deadbeef").status_code == 404


# --------------------------------------------------------------------------
# Linkage
# --------------------------------------------------------------------------
def test_linkage_rejects_an_unknown_kind(client):
    assert client.get("/api/macro/linkage?kind=banana&id=x").status_code == 422


def test_linkage_unknown_subject_is_404(client, fake_macro):
    assert client.get(
        "/api/macro/linkage?kind=portfolio&id=nope").status_code == 404
    assert client.get(
        "/api/macro/linkage?kind=run&id=deadbeef1234").status_code == 404


def test_headline_events_are_preferred_over_bill_auctions(monkeypatch):
    """Ranking candidates by frequency alone fills the panel with noise."""
    monkeypatch.setattr(macro_cache, "event_types", lambda country, min_count=4: [
        {"country": "US", "type": "4-Week Bill Auction",
         "event_key": "4_week_bill_auction", "n": 400},
        {"country": "US", "type": "Baker Hughes Oil Rig Count",
         "event_key": "baker_hughes_oil_rig_count", "n": 399},
        {"country": "US", "type": "Inflation Rate",
         "event_key": "inflation_rate__yoy", "n": 90},
        {"country": "US", "type": "Non Farm Payrolls",
         "event_key": "non_farm_payrolls", "n": 93},
    ])
    keys = [c["event_key"] for c in macro_router._event_candidates("US")]
    assert keys[:2] == ["inflation_rate__yoy", "non_farm_payrolls"]
    # The frequent-but-dull ones are kept, just not first.
    assert "4_week_bill_auction" in keys


def test_event_candidates_backfill_when_no_headline_matches(monkeypatch):
    monkeypatch.setattr(macro_cache, "event_types", lambda country, min_count=4: [
        {"country": "US", "type": "Odd Series", "event_key": "odd_series", "n": 50},
    ])
    assert [c["event_key"] for c in macro_router._event_candidates("US")] == ["odd_series"]


# --------------------------------------------------------------------------
# Serialisation
# --------------------------------------------------------------------------
def test_payload_cleaner_strips_nan_and_inf():
    """A correlation on a flat series produces both, and neither is JSON."""
    cleaned = macro_router._payload(
        {"a": float("nan"), "b": float("inf"), "c": 1.5,
         "d": [float("-inf"), 2.0], "e": np.float64("nan")}
    )
    assert cleaned == {"a": None, "b": None, "c": 1.5, "d": [None, 2.0], "e": None}
    json.dumps(cleaned)


def test_every_read_endpoint_round_trips_through_json(client, fake_macro):
    for url in ("/api/macro/series", "/api/macro/snapshot", "/api/macro/curve",
                "/api/macro/series/US10Y", "/api/macro/calendar",
                "/api/macro/indicators?country=USA"):
        response = client.get(url)
        assert response.status_code == 200, url
        json.dumps(response.json())


# --------------------------------------------------------------------------
# Portfolio router
# --------------------------------------------------------------------------
@pytest.fixture
def temp_store(needs_db):
    """A clean slate for portfolio rows.

    It no longer patches anything. Portfolios moved from a directory of JSON
    files to rows in aion.portfolios, so there is no module-level store to swap
    for a tmp_path one -- the repository is built per request from the caller's
    identity. Isolation comes instead from conftest's `_authenticated` fixture,
    which signs every test in as a throwaway organisation and deletes that
    organisation's rows after each test.

    Kept as a fixture rather than deleted so the tests that ask for it keep
    declaring that they need storage, and skip cleanly when there is none.
    """
    return None


BODY = {
    "name": "Test book", "base_ccy": "USD", "benchmark": "SPY",
    "inception": "2021-01-04", "rebalance": "monthly", "cost_bps": 10,
    "holdings": [{"symbol": "SPY", "asset_class": "etf", "weight": 0.6},
                 {"symbol": "AGG", "asset_class": "etf", "weight": 0.4}],
}


def test_portfolio_crud_status_codes(client, temp_store):
    created = client.post("/api/portfolios", json=BODY)
    assert created.status_code == 200
    pid = created.json()["id"]

    assert client.get(f"/api/portfolios/{pid}").status_code == 200
    assert client.get("/api/portfolios").json()["summaries"][0]["n_holdings"] == 2

    updated = client.put(f"/api/portfolios/{pid}", json={**BODY, "name": "Renamed"})
    assert updated.status_code == 200 and updated.json()["name"] == "Renamed"

    assert client.delete(f"/api/portfolios/{pid}").status_code == 204
    assert client.get(f"/api/portfolios/{pid}").status_code == 404
    assert client.delete(f"/api/portfolios/{pid}").status_code == 404


def test_duplicate_holdings_are_400(client, temp_store):
    response = client.post("/api/portfolios", json={
        **BODY, "holdings": [{"symbol": "SPY", "weight": 0.5},
                             {"symbol": "SPY", "weight": 0.5}]})
    assert response.status_code == 400
    assert "more than once" in response.json()["detail"]


def test_empty_holdings_is_422(client, temp_store):
    assert client.post("/api/portfolios", json={**BODY, "holdings": []}).status_code == 422


def test_unknown_field_is_rejected(client, temp_store):
    assert client.post(
        "/api/portfolios", json={**BODY, "leverage": 3}).status_code == 422


def test_bad_id_is_400_not_500(client, temp_store):
    assert client.get("/api/portfolios/..%2Fescape").status_code in (400, 404)


def test_nav_on_an_unpriceable_book_is_409(client, temp_store, monkeypatch):
    from webapp.api import portfolio_nav

    monkeypatch.setattr(portfolio_nav, "price_series", lambda *a, **k: None)
    pid = client.post("/api/portfolios", json=BODY).json()["id"]
    response = client.get(f"/api/portfolios/{pid}/nav")
    assert response.status_code == 409
    assert "could be priced" in response.json()["detail"]


def test_linked_strategies_shows_a_dangling_link(client, temp_store):
    """A strategy_id pointing at nothing is worth showing, not hiding."""
    pid = client.post("/api/portfolios", json={
        **BODY, "strategy_ids": ["does-not-exist"]}).json()["id"]
    body = client.get(f"/api/portfolios/{pid}/strategies").json()
    assert body["strategies"][0]["missing"] is True
    assert body["strategies"][0]["latest_run"] is None


# --------------------------------------------------------------------------
# Regime endpoints
# --------------------------------------------------------------------------
def test_regime_is_always_200_even_with_nothing_cached(client, monkeypatch):
    """A desk tile that 404s on a cold cache reads as "no regimes here"."""
    from webapp.api import macro_regime

    monkeypatch.setattr(macro_regime.macro, "reference_index",
                        lambda *a, **k: pd.DatetimeIndex([]))
    monkeypatch.setattr(macro_regime.macro_cache, "release_series",
                        lambda *a, **k: pd.Series(dtype="float64"))
    monkeypatch.setattr(macro_regime.macro_cache, "calendar_status",
                        lambda: {"available": False, "stale": True})
    macro_regime.reset_cache()

    response = client.get("/api/macro/regime")
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is False
    assert body["reason"]
    assert body["quadrant"]["state"] == "unknown" and body["quadrant"]["reason"]
    assert body["rate_cycle"]["stage"] == "unknown"
    assert any("refresh" in w for w in body["warnings"])
    macro_regime.reset_cache()


def test_regime_history_clamps_and_reports_emptiness(client, monkeypatch):
    from webapp.api import macro_regime

    monkeypatch.setattr(macro_regime.macro, "reference_index",
                        lambda *a, **k: pd.DatetimeIndex([]))
    macro_regime.reset_cache()
    body = client.get("/api/macro/regime/history?months=24").json()
    assert body["months"] == [] and body["available"] is False and body["reason"]
    assert client.get("/api/macro/regime/history?months=0").status_code == 422
    assert client.get("/api/macro/regime/history?months=500").status_code == 422
    macro_regime.reset_cache()


def test_playbook_rejects_an_unknown_lens(client):
    assert client.get("/api/macro/regime/playbook?lens=banana").status_code == 422


def test_playbook_is_409_when_nothing_classifies(client, monkeypatch):
    """"Exists but not computable" — the same convention as a run report."""
    from webapp.api import macro_regime

    monkeypatch.setattr(macro_regime, "lens_state_series",
                        lambda lens, index=None: pd.Series(dtype="object"))
    response = client.get("/api/macro/regime/playbook?lens=quadrant")
    assert response.status_code == 409
    assert "classified" in response.json()["detail"]


def test_lenses_endpoint_lists_every_lens_with_a_caveat(client):
    body = client.get("/api/macro/regime/lenses").json()
    keys = {lens["key"] for lens in body["lenses"]}
    assert keys == {"quadrant", "rate_cycle", "risk", "market"}
    for lens in body["lenses"]:
        assert lens["caveat"] and lens["states"]


def test_a_macro_refresh_drops_the_regime_cache(monkeypatch):
    """Otherwise new CPI prints land and the desk serves the old quadrant."""
    from webapp.api import macro_regime
    from webapp.api.routers import macro as macro_router

    called: list[str] = []
    monkeypatch.setattr(macro_regime, "reset_cache", lambda: called.append("regime"))
    monkeypatch.setattr(macro_router.macro_cache, "reset_cache", lambda: called.append("cache"))
    monkeypatch.setattr(macro_router.macro, "reset_cache", lambda: called.append("macro"))
    monkeypatch.setattr(
        "webapp.ingest.eodhd.run_macro_refresh",
        lambda *a, **k: {"calendar_rows": 0, "indicator_rows": 0, "warnings": []},
    )
    macro_router._JOBS["t"] = {
        "job_id": "t", "status": "running", "started_at": "", "finished_at": None,
        "params": {}, "progress": {}, "summary": None, "error": None,
    }
    try:
        macro_router._run_refresh("t", macro_router.MacroRefreshRequest())
        assert set(called) == {"regime", "cache", "macro"}
    finally:
        macro_router._JOBS.pop("t", None)
