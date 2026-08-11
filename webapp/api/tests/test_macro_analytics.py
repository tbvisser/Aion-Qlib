"""Analytics against synthetic data with known answers.

Nothing here reads the real macro store: ``macro.change`` / ``macro.level`` /
``macro.reference_index`` are monkeypatched with series a test constructed, so
the assertions are about the estimator rather than about this machine's data.

The test that earns its keep is ``test_hac_matches_statsmodels`` -- hand-rolled
Newey-West is only trustworthy if it is pinned against a reference
implementation, and statsmodels is a dev extra we cannot import at runtime.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from webapp.api import macro_analytics as MA
from webapp.api.macro_analytics import MacroAnalyticsError

BDAYS = pd.bdate_range("2020-01-01", periods=800)


@pytest.fixture
def fake_macro(monkeypatch):
    """Swap the macro reader for an in-memory dict of change series."""
    store: dict[str, pd.Series] = {}
    levels: dict[str, pd.Series] = {}

    def change(key, index=None, ffill_limit=None):
        series = store.get(key)
        if series is None:
            return pd.Series(np.nan, index=index if index is not None else BDAYS)
        return series.reindex(index) if index is not None else series

    def level(key, index=None, ffill_limit=None):
        series = levels.get(key)
        if series is None:
            return pd.Series(np.nan, index=index if index is not None else BDAYS)
        return series.reindex(index) if index is not None else series

    monkeypatch.setattr(MA.macro, "change", change)
    monkeypatch.setattr(MA.macro, "level", level)
    monkeypatch.setattr(MA.macro, "reference_index", lambda *a, **k: BDAYS)
    return store, levels


# --------------------------------------------------------------------------
# Curve inversion
# --------------------------------------------------------------------------
def test_strategy_returns_inverts_the_cumprod_exactly():
    rng = np.random.default_rng(0)
    truth = pd.Series(rng.normal(0, 0.01, 400), index=pd.bdate_range("2021-01-01", periods=400))
    cumulative = (1 + truth).cumprod() - 1
    report = {"curves": {"strategy": [
        {"date": d.strftime("%Y-%m-%d"), "value": float(v)} for d, v in cumulative.items()
    ]}}
    recovered = MA.strategy_returns(report)
    assert len(recovered) == len(truth)
    np.testing.assert_allclose(recovered.to_numpy(), truth.to_numpy(), atol=1e-12)


def test_strategy_returns_names_the_curves_it_does_have():
    report = {"curves": {"benchmark": [{"date": "2021-01-01", "value": 0.0}]}}
    with pytest.raises(MacroAnalyticsError, match="benchmark"):
        MA.strategy_returns(report, curve="strategy")


# --------------------------------------------------------------------------
# Drivers
# --------------------------------------------------------------------------
def test_drivers_recovers_a_planted_correlation(fake_macro):
    store, _ = fake_macro
    rng = np.random.default_rng(1)
    x = pd.Series(rng.normal(0, 1, len(BDAYS)), index=BDAYS)
    noise = pd.Series(rng.normal(0, 1, len(BDAYS)), index=BDAYS)
    returns = 0.001 * x + 0.0005 * noise
    store["VIX"] = x
    store["DXY"] = pd.Series(rng.normal(0, 1, len(BDAYS)), index=BDAYS)

    rows = {r.key: r for r in MA.drivers(returns, keys=["VIX", "DXY"])}
    assert rows["VIX"].pearson > 0.85
    assert abs(rows["DXY"].pearson) < 0.15
    assert rows["VIX"].n == len(BDAYS)
    # Sorted by |correlation|, strongest first.
    assert MA.drivers(returns, keys=["DXY", "VIX"])[0].key == "VIX"


def test_drivers_reports_a_thin_series_rather_than_dropping_it(fake_macro):
    store, _ = fake_macro
    rng = np.random.default_rng(2)
    returns = pd.Series(rng.normal(0, 0.01, len(BDAYS)), index=BDAYS)
    thin = pd.Series(rng.normal(0, 1, 30), index=BDAYS[:30])
    store["VIX"] = pd.Series(rng.normal(0, 1, len(BDAYS)), index=BDAYS)
    store["MOVE"] = thin

    rows = {r.key: r for r in MA.drivers(returns, keys=["VIX", "MOVE"])}
    assert rows["MOVE"].available is False
    assert "30" in rows["MOVE"].reason and "60" in rows["MOVE"].reason
    assert rows["VIX"].available is True
    # Unavailable rows sort last but are still present.
    assert MA.drivers(returns, keys=["MOVE", "VIX"])[-1].key == "MOVE"


def test_drivers_pairs_complete_case_per_series(fake_macro):
    """One thin series must not truncate every other correlation."""
    store, _ = fake_macro
    rng = np.random.default_rng(3)
    returns = pd.Series(rng.normal(0, 0.01, len(BDAYS)), index=BDAYS)
    store["VIX"] = pd.Series(rng.normal(0, 1, len(BDAYS)), index=BDAYS)
    store["MOVE"] = pd.Series(rng.normal(0, 1, 100), index=BDAYS[:100])

    rows = {r.key: r for r in MA.drivers(returns, keys=["VIX", "MOVE"])}
    assert rows["VIX"].n == len(BDAYS), "the full overlap, not MOVE's 100 days"
    assert rows["MOVE"].n == 100


def test_drivers_refuses_a_short_window(fake_macro):
    store, _ = fake_macro
    returns = pd.Series(np.zeros(30), index=BDAYS[:30])
    with pytest.raises(MacroAnalyticsError, match="30"):
        MA.drivers(returns, keys=["VIX"])


def test_lag_scan_adjusts_for_multiple_comparisons(fake_macro):
    store, _ = fake_macro
    rng = np.random.default_rng(4)
    x = pd.Series(rng.normal(0, 1, len(BDAYS)), index=BDAYS)
    store["VIX"] = x
    returns = 0.001 * x.shift(2).fillna(0.0)

    rows = {r.key: r for r in MA.drivers(returns, keys=["VIX"], max_lag=5)}
    assert rows["VIX"].lag == 2, "the planted lead is found"
    if rows["VIX"].p_value is not None:
        assert rows["VIX"].p_value_adj >= rows["VIX"].p_value


# --------------------------------------------------------------------------
# Betas
# --------------------------------------------------------------------------
def _planted(rng, n=600):
    x1 = rng.normal(0, 1, n)
    x2 = rng.normal(0, 1, n)
    noise = rng.normal(0, 1, n)
    y = 2.0 * x1 - 1.0 * x2 + noise
    index = pd.bdate_range("2020-01-01", periods=n)
    return (pd.Series(y, index=index),
            pd.Series(x1, index=index),
            pd.Series(x2, index=index),
            pd.Series(noise, index=index))


def test_factor_betas_recovers_planted_coefficients(fake_macro):
    store, _ = fake_macro
    rng = np.random.default_rng(5)
    y, x1, x2, noise = _planted(rng)
    store.update({"VIX": x1, "DXY": x2, "BCOM": pd.Series(rng.normal(0, 1, len(y)), index=y.index)})

    model = MA.factor_betas(y, keys=["VIX", "DXY", "BCOM"])
    rows = {r.key: r for r in model.rows}
    # Regressors are standardised; the planted x's are already unit variance.
    assert rows["VIX"].beta == pytest.approx(2.0, abs=0.15)
    assert rows["DXY"].beta == pytest.approx(-1.0, abs=0.15)
    assert abs(rows["BCOM"].t_stat) < 3.0, "a pure-noise regressor is insignificant"
    assert rows["VIX"].t_stat > 10
    assert 0.7 < model.r_squared < 0.9
    assert model.n == len(y)
    assert model.cov == "hac" and model.hac_lags >= 3


def test_hac_matches_statsmodels():
    """Pin the hand-rolled Newey-West against the reference implementation.

    statsmodels is a dev/analysis extra, not a runtime dependency, which is why
    the estimator is hand-rolled at all -- and exactly why it needs pinning
    wherever the reference is available.
    """
    sm = pytest.importorskip("statsmodels.api", reason="statsmodels is a dev extra")
    rng = np.random.default_rng(6)
    n = 500
    X = np.hstack([np.ones((n, 1)), rng.normal(0, 1, (n, 3))])
    # Autocorrelated errors, which is the whole point of HAC.
    raw = rng.normal(0, 1, n)
    u = np.array([raw[0]] + [0.0] * (n - 1))
    for i in range(1, n):
        u[i] = 0.5 * u[i - 1] + raw[i]
    y = X @ np.array([0.1, 2.0, -1.0, 0.5]) + u

    lags = MA._hac_lags(n)
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    ours = np.sqrt(np.diag(MA._sandwich(X, y - X @ coef, lags)))

    reference = sm.OLS(y, X).fit(
        cov_type="HAC", cov_kwds={"maxlags": lags, "use_correction": True}
    ).bse
    np.testing.assert_allclose(ours, reference, rtol=1e-8, atol=1e-10)


def test_hac_lag_rule_matches_the_standard_bandwidth():
    """floor(4 * (n/100)^(2/9)) — statsmodels' own default for cov_type='HAC'."""
    assert MA._hac_lags(100) == 4
    assert MA._hac_lags(250) == 4
    assert MA._hac_lags(500) == 5
    assert MA._hac_lags(1000) == 6


def test_hac_standard_errors_exceed_ols_when_both_sides_persist(fake_macro):
    """The reason HAC is the default: plain OLS overstates significance.

    Note what it takes. HAC inflates the standard error when ``x_t * u_t`` is
    serially correlated, which needs persistence on *both* sides -- an
    autocorrelated error against an iid regressor leaves HAC and OLS
    indistinguishable, because the product is then near-white. Macro changes do
    persist (volatility clusters, yield moves trend), which is the case
    reproduced here.
    """
    store, _ = fake_macro
    rng = np.random.default_rng(7)
    n = len(BDAYS)
    x = np.zeros(n)
    u = np.zeros(n)
    for i in range(1, n):
        x[i] = 0.8 * x[i - 1] + rng.normal(0, 1)
        u[i] = 0.8 * u[i - 1] + rng.normal(0, 1)
    returns = pd.Series(0.5 * x + u, index=BDAYS)
    store["VIX"] = pd.Series(x, index=BDAYS)

    hac = MA.factor_betas(returns, keys=["VIX"], cov="hac").rows[0]
    ols = MA.factor_betas(returns, keys=["VIX"], cov="ols").rows[0]
    assert hac.beta == pytest.approx(ols.beta, rel=1e-9), "same point estimate"
    assert hac.std_error > ols.std_error
    assert abs(hac.t_stat) < abs(ols.t_stat)


def test_collinear_regressors_are_flagged_by_vif(fake_macro):
    """The guard that catches someone putting TNX next to US10Y."""
    store, _ = fake_macro
    rng = np.random.default_rng(8)
    x = pd.Series(rng.normal(0, 1, len(BDAYS)), index=BDAYS)
    store["US10Y"] = x
    store["US5Y"] = x * 1.0001 + pd.Series(rng.normal(0, 0.001, len(BDAYS)), index=BDAYS)
    returns = 0.001 * x

    model = MA.factor_betas(returns, keys=["US10Y", "US5Y"])
    assert any(r.vif and r.vif > 5 for r in model.rows)
    assert model.warnings and "variance inflation" in model.warnings[0]


def test_low_coverage_regressor_is_dropped_with_a_reason(fake_macro):
    store, _ = fake_macro
    rng = np.random.default_rng(9)
    returns = pd.Series(rng.normal(0, 0.01, len(BDAYS)), index=BDAYS)
    store["VIX"] = pd.Series(rng.normal(0, 1, len(BDAYS)), index=BDAYS)
    store["MOVE"] = pd.Series(rng.normal(0, 1, 100), index=BDAYS[:100])

    model = MA.factor_betas(returns, keys=["VIX", "MOVE"])
    assert [r.key for r in model.rows] == ["VIX"]
    assert model.dropped and model.dropped[0]["key"] == "MOVE"
    assert "80%" in model.dropped[0]["reason"]


def test_constant_regressor_is_dropped(fake_macro):
    store, _ = fake_macro
    rng = np.random.default_rng(10)
    returns = pd.Series(rng.normal(0, 0.01, len(BDAYS)), index=BDAYS)
    store["VIX"] = pd.Series(rng.normal(0, 1, len(BDAYS)), index=BDAYS)
    store["DXY"] = pd.Series(np.zeros(len(BDAYS)), index=BDAYS)

    model = MA.factor_betas(returns, keys=["VIX", "DXY"])
    assert [d["key"] for d in model.dropped] == ["DXY"]
    assert "no variation" in model.dropped[0]["reason"]


def test_factor_betas_refuses_when_the_window_cannot_support_k(fake_macro):
    """The n >= 5k rule: enough regressors and 62 days is not enough."""
    store, _ = fake_macro
    rng = np.random.default_rng(11)
    index = pd.bdate_range("2021-01-01", periods=62)
    returns = pd.Series(rng.normal(0, 0.01, 62), index=index)
    keys = ["VIX", "VXN", "MOVE", "GVZ", "OVX", "DXY", "AXY",
            "CXY", "BCOM", "BCOMCL", "BCOMGC", "GSPC"]
    for key in keys:
        store[key] = pd.Series(rng.normal(0, 1, 62), index=index)
    with pytest.raises(MacroAnalyticsError, match="complete observations"):
        MA.factor_betas(returns, keys=keys)


def test_alpha_is_the_mean_return_at_average_conditions(fake_macro):
    """Regressors are centred, so the intercept is exactly the mean return.

    That is the property that makes the intercept readable at all: "the daily
    return with every driver at its window average", not an extrapolation to a
    zero-VIX world.
    """
    store, _ = fake_macro
    rng = np.random.default_rng(12)
    x = pd.Series(rng.normal(0, 1, len(BDAYS)), index=BDAYS)
    returns = 0.0004 + 0.001 * x
    store["VIX"] = x
    model = MA.factor_betas(returns, keys=["VIX"])
    assert model.alpha.beta == pytest.approx(float(returns.mean()), abs=1e-12)


# --------------------------------------------------------------------------
# Regimes
# --------------------------------------------------------------------------
def _regime_levels(rng):
    """A rates path with a clear up-leg then down-leg, and a vol path."""
    n = len(BDAYS)
    rates = np.concatenate([np.linspace(1.0, 4.0, n // 2), np.linspace(4.0, 1.5, n - n // 2)])
    vol = 15 + 10 * np.sin(np.linspace(0, 12, n)) + rng.normal(0, 0.5, n)
    return pd.Series(rates, index=BDAYS), pd.Series(np.abs(vol) + 5, index=BDAYS)


def test_regimes_classify_and_partition_the_window(fake_macro):
    _, levels = fake_macro
    rng = np.random.default_rng(13)
    rates, vol = _regime_levels(rng)
    levels.update({"US2Y": rates, "VIX": vol})
    returns = pd.Series(rng.normal(0, 0.01, len(BDAYS)), index=BDAYS)

    report = MA.regimes(returns, lookback=252, min_days=10)
    assert len(report.buckets) == 4
    classified = sum(b.days for b in report.buckets)
    assert classified + report.unclassified == len(BDAYS)
    shares = sum(b.share for b in report.buckets)
    assert shares == pytest.approx(1.0, abs=1e-9)
    assert report.runs and all({"start", "end", "label"} <= set(r) for r in report.runs)


def test_regimes_put_a_rising_rate_path_in_the_rising_buckets(fake_macro):
    _, levels = fake_macro
    rng = np.random.default_rng(14)
    # Monotonically rising rates for the whole window.
    levels.update({
        "US2Y": pd.Series(np.linspace(1.0, 5.0, len(BDAYS)), index=BDAYS),
        "VIX": pd.Series(20 + rng.normal(0, 2, len(BDAYS)), index=BDAYS),
    })
    returns = pd.Series(rng.normal(0, 0.01, len(BDAYS)), index=BDAYS)

    report = MA.regimes(returns, lookback=252, min_days=10)
    rising = sum(b.days for b in report.buckets if b.rates == "rising")
    falling = sum(b.days for b in report.buckets if b.rates == "falling")
    assert falling == 0 and rising > 0


def test_thin_regime_reports_days_but_no_statistics(fake_macro):
    _, levels = fake_macro
    rng = np.random.default_rng(15)
    rates = np.linspace(1.0, 5.0, len(BDAYS))
    rates[-5:] = rates[-6] - 0.5  # a five-day dip, below min_days
    levels.update({
        "US2Y": pd.Series(rates, index=BDAYS),
        "VIX": pd.Series(20 + rng.normal(0, 2, len(BDAYS)), index=BDAYS),
    })
    returns = pd.Series(rng.normal(0, 0.01, len(BDAYS)), index=BDAYS)

    report = MA.regimes(returns, lookback=252, min_days=20)
    thin = [b for b in report.buckets if 0 < b.days < 20]
    assert thin, "the dip should make at least one sparse bucket"
    for bucket in thin:
        assert bucket.ann_return is None and bucket.sharpe is None
        assert "needed" in bucket.reason


def test_regimes_never_report_a_drawdown():
    """A drawdown over a non-contiguous set of days is not a drawdown."""
    assert not hasattr(MA.RegimeBucket, "max_dd")
    assert "max_dd" not in MA.RegimeBucket.__dataclass_fields__


def test_regimes_refuse_when_macro_does_not_overlap(fake_macro):
    _, levels = fake_macro
    rng = np.random.default_rng(16)
    returns = pd.Series(rng.normal(0, 0.01, len(BDAYS)), index=BDAYS)
    with pytest.raises(MacroAnalyticsError, match="classified"):
        MA.regimes(returns, lookback=252)


# --------------------------------------------------------------------------
# Event study
# --------------------------------------------------------------------------
def test_event_study_recovers_a_planted_bump():
    rng = np.random.default_rng(17)
    returns = pd.Series(rng.normal(0, 0.002, len(BDAYS)), index=BDAYS)
    dates = [BDAYS[i] for i in range(40, 700, 20)]
    for stamp in dates:
        returns[stamp] += 0.02

    study = MA.event_study(returns, dates, event_type="CPI")
    assert study.n_events == len(dates)
    at_zero = next(p for p in study.path if p["offset"] == 0)
    prior = next(p for p in study.path if p["offset"] == -1)
    assert at_zero["car"] - prior["car"] == pytest.approx(0.02, abs=0.003)
    assert study.headline["car"] > 0.015
    assert study.headline["t"] > 5
    assert study.model == "constant_mean"


def test_event_study_finds_nothing_when_there_is_nothing():
    rng = np.random.default_rng(18)
    returns = pd.Series(rng.normal(0, 0.002, len(BDAYS)), index=BDAYS)
    dates = [BDAYS[i] for i in range(40, 700, 20)]
    study = MA.event_study(returns, dates, event_type="NFP")
    assert abs(study.headline["t"]) < 3


def test_event_study_refuses_too_few_events():
    rng = np.random.default_rng(19)
    returns = pd.Series(rng.normal(0, 0.002, len(BDAYS)), index=BDAYS)
    with pytest.raises(MacroAnalyticsError, match="4"):
        MA.event_study(returns, [BDAYS[i] for i in (50, 100, 150, 200)], event_type="FOMC")


def test_event_study_drops_events_without_a_full_window():
    rng = np.random.default_rng(20)
    returns = pd.Series(rng.normal(0, 0.002, len(BDAYS)), index=BDAYS)
    dates = [BDAYS[1]] + [BDAYS[i] for i in range(40, 700, 20)] + [BDAYS[-2]]
    study = MA.event_study(returns, dates, pre=5, post=5)
    assert study.dropped == 2


def test_event_study_warns_below_25_events():
    rng = np.random.default_rng(21)
    returns = pd.Series(rng.normal(0, 0.002, len(BDAYS)), index=BDAYS)
    dates = [BDAYS[i] for i in range(40, 400, 30)]
    study = MA.event_study(returns, dates)
    assert 10 <= study.n_events < 25
    assert any("25" in w for w in study.warnings)


def test_market_model_is_fitted_outside_the_event_windows():
    rng = np.random.default_rng(22)
    market = pd.Series(rng.normal(0, 0.01, len(BDAYS)), index=BDAYS)
    returns = 1.5 * market + pd.Series(rng.normal(0, 0.001, len(BDAYS)), index=BDAYS)
    dates = [BDAYS[i] for i in range(40, 700, 20)]
    study = MA.event_study(returns, dates, market=market)
    assert study.model == "market"
    # With no abnormal component planted, the market model should net out.
    assert abs(study.headline["car"]) < 0.002


def test_releases_on_a_non_trading_day_map_to_the_next_session():
    index = pd.bdate_range("2024-01-01", periods=300)
    rng = np.random.default_rng(23)
    returns = pd.Series(rng.normal(0, 0.002, 300), index=index)
    saturdays = [pd.Timestamp("2024-02-03") + pd.Timedelta(days=7 * i) for i in range(20)]
    study = MA.event_study(returns, saturdays, pre=2, post=2, min_events=10)
    assert study.n_events >= 15
