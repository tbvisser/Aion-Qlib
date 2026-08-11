"""The portfolio store and the NAV engine.

The NAV tests run against synthetic bars through a monkeypatched
``marketdata``, so they assert the arithmetic rather than this machine's data.
The anchor is ``test_single_holding_nav_equals_its_own_return``: if a
100%-one-asset book does not reproduce that asset's own cumulative return,
nothing else in the module can be trusted.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from webapp.api import portfolio_nav as PN
from webapp.api.portfolio_nav import NavError
from webapp.api.portfolios import Holding, PortfolioSpec, PortfolioStore

BDAYS = pd.bdate_range("2021-01-04", periods=500)
ALLDAYS = pd.date_range("2021-01-04", periods=700, freq="D")


def spec(holdings, **kwargs):
    kwargs.setdefault("name", "Test book")
    kwargs.setdefault("inception", "2021-01-04")
    kwargs.setdefault("rebalance", "none")
    kwargs.setdefault("cost_bps", 0.0)
    return PortfolioSpec(
        holdings=[Holding(symbol=s, asset_class=c, weight=w) for s, c, w in holdings],
        **kwargs,
    )


@pytest.fixture
def fake_prices(monkeypatch):
    """An in-memory price book, with each symbol tagged qlib or market."""
    series: dict[str, tuple[pd.Series, str, str]] = {}

    def add(symbol, values, index=BDAYS, store="qlib", asset_class="etf"):
        series[symbol] = (pd.Series(values, index=index, dtype=float), store, asset_class)

    def entry_for(symbol):
        hit = series.get(symbol.upper())
        if hit is None:
            return None
        return {"s": symbol.upper(), "n": symbol.upper(),
                "c": hit[2], "x": "US", "st": hit[1]}

    def price_series(symbol, start=None, end=None):
        hit = series.get(symbol.upper())
        if hit is None:
            return None
        out = hit[0]
        if start:
            out = out[out.index >= pd.Timestamp(start)]
        if end:
            out = out[out.index <= pd.Timestamp(end)]
        return (out, hit[1]) if not out.empty else None

    monkeypatch.setattr(PN.marketdata, "entry_for", entry_for)
    monkeypatch.setattr(PN, "price_series", price_series)
    # No qlib store in tests: fall back to the union of the symbols' own dates.
    monkeypatch.setattr(PN.marketdata, "store_for", lambda key: None)
    return add


# --------------------------------------------------------------------------
# Store
# --------------------------------------------------------------------------
def test_store_round_trip(tmp_path):
    store = PortfolioStore(tmp_path)
    created = store.create(spec([("SPY", "etf", 0.6), ("AGG", "etf", 0.4)]))
    assert store.get(created.id).name == "Test book"
    assert [p.id for p in store.list()] == [created.id]

    updated = store.update(created.id, spec([("SPY", "etf", 1.0)], name="Renamed"))
    assert updated.created_at == created.created_at, "created_at is preserved"
    assert updated.updated_at >= created.updated_at
    assert store.get(created.id).name == "Renamed"

    assert store.delete(created.id) is True
    assert store.get(created.id) is None
    assert store.delete(created.id) is False


def test_upsert_twice_writes_one_file(tmp_path):
    """The seeder's whole idempotency contract."""
    store = PortfolioStore(tmp_path)
    first = store.upsert("demo-pf-6040", spec([("SPY", "etf", 1.0)], name="First"))
    second = store.upsert("demo-pf-6040", spec([("SPY", "etf", 1.0)], name="Second"))
    assert len(list(tmp_path.glob("*.json"))) == 1
    assert first.created_at == second.created_at
    assert store.get("demo-pf-6040").name == "Second"


def test_path_guard_rejects_traversal(tmp_path):
    store = PortfolioStore(tmp_path)
    for bad in ("../escape", "a/b", "", "x" * 65):
        with pytest.raises(ValueError):
            store._path(bad)


def test_corrupt_file_is_skipped_not_fatal(tmp_path):
    store = PortfolioStore(tmp_path)
    good = store.create(spec([("SPY", "etf", 1.0)]))
    (tmp_path / "broken.json").write_text("{not json")
    assert [p.id for p in store.list()] == [good.id]


def test_list_is_newest_first(tmp_path):
    store = PortfolioStore(tmp_path)
    a = store.upsert("aaa", spec([("SPY", "etf", 1.0)], name="A"))
    b = store.upsert("bbb", spec([("SPY", "etf", 1.0)], name="B"))
    assert [p.id for p in store.list()][0] in {a.id, b.id}
    assert store.list()[0].updated_at >= store.list()[-1].updated_at


def test_duplicate_holdings_are_an_error():
    problems = spec([("SPY", "etf", 0.5), ("SPY", "etf", 0.5)]).validate_holdings()
    assert problems and "more than once" in problems[0]


def test_weights_are_never_silently_normalised():
    """0.87 is a meaningful 13%-cash book, not a mistake to be scaled away."""
    warnings = spec([("SPY", "etf", 0.6), ("AGG", "etf", 0.27)]).validate_weights()
    assert warnings and "cash" in warnings[0]
    assert not spec([("SPY", "etf", 0.6), ("AGG", "etf", 0.4)]).validate_weights()


def test_geared_book_warns_differently():
    warnings = spec([("SPY", "etf", 1.3)]).validate_weights()
    assert warnings and "geared" in warnings[0]


def test_symbol_and_benchmark_are_upcased():
    p = spec([("spy", "etf", 1.0)], benchmark="agg")
    assert p.holdings[0].symbol == "SPY"
    assert p.benchmark == "AGG"


def test_bad_inception_is_rejected():
    with pytest.raises(ValueError):
        spec([("SPY", "etf", 1.0)], inception="01-01-2021")


def test_absurd_weight_is_rejected():
    with pytest.raises(ValueError):
        PortfolioSpec(name="x", holdings=[Holding(symbol="SPY", weight=20.0)])


# --------------------------------------------------------------------------
# NAV
# --------------------------------------------------------------------------
def test_single_holding_nav_equals_its_own_return(fake_prices):
    """The anchor. If this is wrong, every other number here is too."""
    prices = 100 * 1.0005 ** np.arange(len(BDAYS))
    fake_prices("SPY", prices)
    report = PN.build_nav(spec([("SPY", "etf", 1.0)]), start="2021-01-04")
    own = prices[-1] / prices[0] - 1
    assert report["curves"]["nav"][-1]["value"] == pytest.approx(own, rel=1e-9)
    assert report["curves"]["nav"][0]["value"] == pytest.approx(0.0)


def test_nav_is_invariant_to_the_price_level(fake_prices):
    """The decision that makes a mixed book meaningful at all.

    qlib rebases ``$close`` to ~1.0 per symbol while the market store keeps raw
    prices, so the same asset can arrive at 1.0 or at $60,000. Two books whose
    holdings have identical *returns* but price levels 60,000x apart must
    produce the identical NAV -- which a price-times-shares construction would
    not.
    """
    rng = np.random.default_rng(3)
    steps = 1 + rng.normal(0, 0.01, len(BDAYS))
    fake_prices("CHEAP", 1.0 * np.cumprod(steps))
    fake_prices("DEAR", 60_000.0 * np.cumprod(steps))
    fake_prices("OTHER", 100 * 1.0005 ** np.arange(len(BDAYS)))

    cheap = PN.build_nav(
        spec([("CHEAP", "etf", 0.5), ("OTHER", "etf", 0.5)], rebalance="monthly"),
        start="2021-01-04",
    )
    dear = PN.build_nav(
        spec([("DEAR", "etf", 0.5), ("OTHER", "etf", 0.5)], rebalance="monthly"),
        start="2021-01-04",
    )
    assert cheap["curves"]["nav"][-1]["value"] == pytest.approx(
        dear["curves"]["nav"][-1]["value"], rel=1e-9
    )
    assert cheap["metrics"]["annualised_vol"] == pytest.approx(
        dear["metrics"]["annualised_vol"], rel=1e-9
    )


def test_weights_scale_the_volatility(fake_prices):
    rng = np.random.default_rng(4)
    fake_prices("SPY", 100 * np.cumprod(1 + rng.normal(0, 0.01, len(BDAYS))))
    full = PN.build_nav(spec([("SPY", "etf", 1.0)], rebalance="monthly"),
                        start="2021-01-04")
    half = PN.build_nav(spec([("SPY", "etf", 0.5)], rebalance="monthly"),
                        start="2021-01-04")
    assert half["metrics"]["annualised_vol"] == pytest.approx(
        full["metrics"]["annualised_vol"] / 2, rel=0.02
    )


def test_unrebalanced_partial_book_drifts_toward_the_risk_asset(fake_prices):
    """A 50%-stock / 50%-cash book left alone becomes a stock book.

    Cash earns nothing and does not drift, so the stock's share of NAV rises
    every day it gains. That is real behaviour, not a bug -- and it is why
    ``rebalance`` defaults to monthly.
    """
    fake_prices("SPY", 100 * 1.001 ** np.arange(len(BDAYS)))
    held = PN.build_nav(spec([("SPY", "etf", 0.5)], rebalance="none"),
                        start="2021-01-04")
    rebalanced = PN.build_nav(spec([("SPY", "etf", 0.5)], rebalance="monthly"),
                              start="2021-01-04")
    assert held["curves"]["nav"][-1]["value"] > rebalanced["curves"]["nav"][-1]["value"]
    # Rebalancing does not pin the weight — it only snaps it back at each
    # month end — so the rebalanced book still drifts a little in between. The
    # point is the order of magnitude.
    assert held["metrics"]["annualised_vol"] > 10 * rebalanced["metrics"]["annualised_vol"]


def test_rebalancing_changes_the_path_and_charges_turnover(fake_prices):
    fake_prices("UP", 100 * 1.002 ** np.arange(len(BDAYS)))
    fake_prices("DOWN", 100 * 0.999 ** np.arange(len(BDAYS)))
    holds = [("UP", "etf", 0.5), ("DOWN", "etf", 0.5)]

    held = PN.build_nav(spec(holds, rebalance="none"), start="2021-01-04")
    rebalanced = PN.build_nav(spec(holds, rebalance="monthly"), start="2021-01-04")

    assert held["metrics"]["annual_turnover"] == pytest.approx(0.0)
    assert rebalanced["metrics"]["annual_turnover"] > 0
    assert held["curves"]["nav"][-1]["value"] != rebalanced["curves"]["nav"][-1]["value"]


def test_costs_reduce_net_but_not_gross(fake_prices):
    fake_prices("UP", 100 * 1.002 ** np.arange(len(BDAYS)))
    fake_prices("DOWN", 100 * 0.999 ** np.arange(len(BDAYS)))
    holds = [("UP", "etf", 0.5), ("DOWN", "etf", 0.5)]

    free = PN.build_nav(spec(holds, rebalance="monthly", cost_bps=0), start="2021-01-04")
    dear = PN.build_nav(spec(holds, rebalance="monthly", cost_bps=100), start="2021-01-04")

    assert dear["curves"]["nav"][-1]["value"] < free["curves"]["nav"][-1]["value"]
    assert dear["metrics"]["cost_drag"] > free["metrics"]["cost_drag"]
    # Gross is the same series in both; only the net curve is charged.
    assert dear["curves"]["gross"][-1]["value"] == pytest.approx(
        free["curves"]["gross"][-1]["value"], rel=1e-9
    )


def test_coarsest_calendar_wins_for_a_mixed_book(fake_prices, monkeypatch):
    """A weekend crypto move lands in Monday, and no Saturday enters the index."""
    fake_prices("SPY", 100 * 1.0005 ** np.arange(len(BDAYS)), store="qlib")
    fake_prices("BTC-USD", 100 * 1.0005 ** np.arange(len(ALLDAYS)),
                index=ALLDAYS, store="market", asset_class="crypto")
    monkeypatch.setattr(PN, "_is_qlib", lambda s: s.upper() == "SPY")
    monkeypatch.setattr(
        PN, "reference_index",
        lambda symbols, start, end, priced: BDAYS if "SPY" in symbols else ALLDAYS,
    )
    report = PN.build_nav(
        spec([("SPY", "etf", 0.5), ("BTC-USD", "crypto", 0.5)]), start="2021-01-04"
    )
    dates = pd.DatetimeIndex([p["date"] for p in report["curves"]["nav"]])
    assert not any(d.weekday() >= 5 for d in dates), "no weekend sessions"
    assert any("Monday" in w for w in report["warnings"])


def test_all_market_book_keeps_its_365_day_calendar(fake_prices):
    fake_prices("BTC-USD", 100 * 1.0005 ** np.arange(len(ALLDAYS)),
                index=ALLDAYS, store="market", asset_class="crypto")
    report = PN.build_nav(
        spec([("BTC-USD", "crypto", 1.0)], benchmark="BTC-USD"), start="2021-01-04"
    )
    dates = pd.DatetimeIndex([p["date"] for p in report["curves"]["nav"]])
    assert any(d.weekday() >= 5 for d in dates), "crypto trades weekends"


def test_unpriceable_symbol_is_reported_not_fatal(fake_prices):
    fake_prices("SPY", 100 * 1.001 ** np.arange(len(BDAYS)))
    report = PN.build_nav(
        spec([("SPY", "etf", 0.5), ("NOPE", "etf", 0.5)]), start="2021-01-04"
    )
    assert [u["symbol"] for u in report["unpriced"]] == ["NOPE"]
    assert [c["symbol"] for c in report["contribution"]] == ["SPY"]
    assert report["curves"]["nav"][-1]["value"] > 0


def test_entirely_unpriceable_book_refuses(fake_prices):
    with pytest.raises(NavError, match="none of this portfolio"):
        PN.build_nav(spec([("NOPE", "etf", 1.0)]), start="2021-01-04")


def test_late_listing_is_warned_about(fake_prices):
    fake_prices("SPY", 100 * 1.001 ** np.arange(len(BDAYS)))
    fake_prices("NEW", 100 * 1.001 ** np.arange(200), index=BDAYS[300:])
    report = PN.build_nav(
        spec([("SPY", "etf", 0.5), ("NEW", "etf", 0.5)]), start="2021-01-04"
    )
    assert any("no bars before" in w for w in report["warnings"])


def test_drawdown_is_never_positive(fake_prices):
    rng = np.random.default_rng(0)
    walk = 100 * np.cumprod(1 + rng.normal(0, 0.01, len(BDAYS)))
    fake_prices("SPY", walk)
    report = PN.build_nav(spec([("SPY", "etf", 1.0)]), start="2021-01-04")
    assert max(p["value"] for p in report["curves"]["drawdown"]) <= 1e-12
    assert report["metrics"]["max_drawdown"] <= 0


def test_benchmark_and_excess_curves(fake_prices):
    fake_prices("SPY", 100 * 1.002 ** np.arange(len(BDAYS)))
    fake_prices("AGG", 100 * 1.0005 ** np.arange(len(BDAYS)))
    report = PN.build_nav(
        spec([("SPY", "etf", 1.0)], benchmark="AGG"), start="2021-01-04"
    )
    assert report["curves"]["benchmark"][-1]["value"] > 0
    assert report["curves"]["excess"][-1]["value"] == pytest.approx(
        report["curves"]["nav"][-1]["value"] - report["curves"]["benchmark"][-1]["value"]
    )


def test_missing_benchmark_warns_and_still_prices(fake_prices):
    fake_prices("SPY", 100 * 1.001 ** np.arange(len(BDAYS)))
    report = PN.build_nav(
        spec([("SPY", "etf", 1.0)], benchmark="NOPE"), start="2021-01-04"
    )
    assert report["benchmark"] is None
    assert report["curves"]["benchmark"] == []
    assert any("benchmark" in w for w in report["warnings"])


def test_nav_curve_unit_matches_build_report(fake_prices):
    """``curves.nav`` must be interchangeable with ``curves.strategy``.

    That is what lets one macro-analytics path serve runs and portfolios.
    """
    from webapp.api import macro_analytics as MA

    fake_prices("SPY", 100 * 1.001 ** np.arange(len(BDAYS)))
    report = PN.build_nav(spec([("SPY", "etf", 1.0)]), start="2021-01-04")
    returns = MA.strategy_returns(report, curve="nav")
    assert len(returns) == len(BDAYS)
    assert returns.iloc[-1] == pytest.approx(0.001, abs=1e-6)


# --------------------------------------------------------------------------
# Base currency
# --------------------------------------------------------------------------
def test_eur_book_carries_the_currency_move(fake_prices):
    fake_prices("SPY", 100 * 1.001 ** np.arange(len(BDAYS)))
    # Euro strengthening against the dollar: a USD book is worth less in EUR.
    fake_prices("EURUSD", 1.1 * 1.0002 ** np.arange(len(BDAYS)),
                store="market", asset_class="fx")
    usd = PN.build_nav(spec([("SPY", "etf", 1.0)]), start="2021-01-04")
    eur = PN.build_nav(
        spec([("SPY", "etf", 1.0)], base_ccy="EUR"), start="2021-01-04"
    )
    assert eur["curves"]["nav"][-1]["value"] < usd["curves"]["nav"][-1]["value"]
    assert any("EUR" in w for w in eur["warnings"])


def test_missing_fx_is_a_refusal_not_a_silent_usd_fallback(fake_prices):
    """Labelling a dollar return as euros is exactly the quiet lie to avoid."""
    fake_prices("SPY", 100 * 1.001 ** np.arange(len(BDAYS)))
    with pytest.raises(NavError, match="EUR"):
        PN.build_nav(spec([("SPY", "etf", 1.0)], base_ccy="EUR"), start="2021-01-04")


# --------------------------------------------------------------------------
# Allocation and validation
# --------------------------------------------------------------------------
def test_allocation_groups_by_class_and_folds_the_residual_into_cash(fake_prices):
    fake_prices("SPY", 100 * 1.001 ** np.arange(len(BDAYS)), asset_class="etf")
    fake_prices("BTC-USD", 100 * 1.001 ** np.arange(len(BDAYS)),
                store="market", asset_class="crypto")
    report = PN.build_nav(
        spec([("SPY", "etf", 0.5), ("BTC-USD", "crypto", 0.3)]), start="2021-01-04"
    )
    alloc = {a["asset_class"]: a["weight"] for a in report["allocation"]}
    assert alloc["etf"] == pytest.approx(0.5)
    assert alloc["crypto"] == pytest.approx(0.3)
    assert alloc["cash"] == pytest.approx(0.2)


def test_resolve_reports_sources_and_gaps(fake_prices):
    fake_prices("SPY", 100 * 1.001 ** np.arange(len(BDAYS)))
    out = PN.resolve(spec([("SPY", "etf", 0.5), ("NOPE", "etf", 0.5)]))
    assert out["resolved"][0]["symbol"] == "SPY"
    assert out["resolved"][0]["source"] == "qlib"
    assert out["unpriced"][0]["symbol"] == "NOPE"
    assert out["errors"] == []


def test_too_short_a_window_refuses(fake_prices):
    fake_prices("SPY", [100.0], index=BDAYS[:1])
    with pytest.raises(NavError, match="not enough"):
        PN.build_nav(spec([("SPY", "etf", 1.0)]), start="2021-01-04")


def test_report_is_json_serialisable(fake_prices):
    """NaN and inf are not JSON, and a flat series produces both."""
    fake_prices("FLAT", np.full(len(BDAYS), 100.0))
    report = PN.build_nav(spec([("FLAT", "etf", 1.0)]), start="2021-01-04")
    assert json.loads(json.dumps(report)) is not None
