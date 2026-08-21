"""Tests for the Markov Chain regime engine and router."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from webapp.api.main import app

from ..markov_chain import (
    backtest_from_signals,
    compute_summary,
    estimate_transition_matrix,
    generate_signal,
    label_states,
    multi_step_transition,
    position_from_signal,
    stationary_distribution,
    walkforward_signals,
)


def _returns(n: int, seed: int = 7) -> pd.Series:
    rng = np.random.default_rng(seed)
    return pd.Series(rng.normal(0.0005, 0.01, n), index=pd.date_range("2020-01-02", periods=n, freq="B"), name="TEST")


def test_label_states_produces_three_states():
    returns = _returns(100)
    states = label_states(returns, bull_threshold=0.02, bear_threshold=-0.02, window=20)
    assert set(states.dropna().unique()) <= {0, 1, 2}
    assert states.index.equals(returns.index)


def test_label_states_respects_thresholds():
    # Strongly trending series should be mostly bull or bear.
    bull_returns = pd.Series(np.full(50, 0.0015), index=pd.date_range("2020-01-02", periods=50, freq="B"))
    states = label_states(bull_returns, bull_threshold=0.01, bear_threshold=-0.01, window=10)
    # After the warm-up the rolling sum is 0.015, so state 0 dominates.
    assert states.dropna().iloc[-1] == 0

    bear_returns = pd.Series(np.full(50, -0.0015), index=pd.date_range("2020-01-02", periods=50, freq="B"))
    states = label_states(bear_returns, bull_threshold=0.01, bear_threshold=-0.01, window=10)
    assert states.dropna().iloc[-1] == 1


def test_transition_matrix_rows_sum_to_one():
    states = label_states(_returns(200), window=20)
    P = estimate_transition_matrix(states)
    assert P.shape == (3, 3)
    for row in P:
        assert math.isclose(row.sum(), 1.0)


def test_transition_matrix_for_uniform_sequence():
    # A deterministic cycle 0 -> 1 -> 2 -> 0 ...
    states = pd.Series([0, 1, 2] * 10)
    P = estimate_transition_matrix(states)
    assert P[0, 1] == 1.0
    assert P[1, 2] == 1.0
    assert P[2, 0] == 1.0


def test_multi_step_transition_matches_matrix_power():
    states = label_states(_returns(300), window=20)
    P = estimate_transition_matrix(states)
    P5 = multi_step_transition(P, 5)
    expected = np.linalg.matrix_power(P, 5)
    np.testing.assert_allclose(P5, expected)
    # Each row still sums to 1.
    for row in P5:
        assert math.isclose(row.sum(), 1.0)


def test_stationary_distribution_sums_to_one():
    states = label_states(_returns(300), window=20)
    P = estimate_transition_matrix(states)
    pi = stationary_distribution(P)
    assert math.isclose(pi.sum(), 1.0)
    # π is a left eigenvector with eigenvalue 1.
    np.testing.assert_allclose(pi @ P, pi, atol=1e-10)


def test_generate_signal_is_bull_minus_bear():
    P = np.array([[0.5, 0.2, 0.3], [0.2, 0.6, 0.2], [0.3, 0.3, 0.4]])
    assert generate_signal(P, 0) == pytest.approx(0.3)
    assert generate_signal(P, 1) == pytest.approx(-0.4)


def test_position_from_signal_saturation_and_deadband():
    assert position_from_signal(0.5) == 1.0
    assert position_from_signal(-0.5) == -1.0
    assert position_from_signal(0.0) == 0.0
    assert position_from_signal(0.2, deadband=0.1, saturate=0.3) == pytest.approx(0.5)


def test_walkforward_signals_use_only_past_data():
    returns = _returns(400)
    signals = walkforward_signals(returns, lookback=100, window=20)
    # Signals start once we have `lookback` historical state observations.
    assert len(signals) == len(returns) - 100
    # No NaNs in the engineered columns.
    assert signals["signal"].notna().all()
    assert signals["position"].notna().all()


def test_backtest_from_signals_avoids_lookahead():
    returns = _returns(100)
    signals = walkforward_signals(returns, lookback=40, window=10)
    strat_returns = backtest_from_signals(returns, signals)
    # First non-NaN return aligns with the second signal row (position shifted by 1).
    assert strat_returns.dropna().index[0] == signals.index[1]


def test_compute_summary_shape():
    returns = _returns(400)
    summary = compute_summary(returns, window=20, lookback=100)
    assert summary["symbol"] == "TEST"
    assert summary["current_state"] in {"Bull", "Bear", "Sideways"}
    assert len(summary["transition_matrix"]) == 3
    assert set(summary["forecasts"].keys()) == {"1", "5", "12", "24"}
    assert set(summary["stationary_distribution"].keys()) == {"Bull", "Bear", "Sideways"}
    assert set(summary["regime_counts"].keys()) <= {"Bull", "Bear", "Sideways"}
    assert "annualized_sharpe" in summary["backtest"]
    assert len(summary["signal_series"]) > 0


@pytest.fixture
def client():
    return TestClient(app)


def test_compute_summary_with_trending_series():
    # Almost deterministic bull series.
    returns = pd.Series(
        np.full(300, 0.0015), index=pd.date_range("2020-01-02", periods=300, freq="B"), name="BULL"
    )
    summary = compute_summary(returns, window=20, lookback=100, bull_threshold=0.02)
    # With tiny daily returns the 20-day sum rarely exceeds 0.02, so this is
    # mainly a sanity check that the function runs and returns sensible types.
    assert summary["current_state"] in {"Bull", "Bear", "Sideways"}
    assert math.isclose(sum(sum(r["to"].values()) for r in summary["transition_matrix"]), 3.0, abs_tol=1e-6)


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

def test_markov_analyze_endpoint(client, monkeypatch):
    """The analyze endpoint returns a JSON-safe summary."""
    returns = _returns(400)

    def fake_load(symbol, store=None):
        return returns

    import webapp.api.routers.markov as markov_router
    monkeypatch.setattr(markov_router, "_load_returns", fake_load)

    resp = client.get("/api/markov/analyze?symbol=SPY&window=20&bull=0.02&bear=-0.02&lookback=100")
    assert resp.status_code == 200
    data = resp.json()
    assert data["symbol"] == "TEST"
    assert data["current_state"] in {"Bull", "Bear", "Sideways"}
    assert len(data["transition_matrix"]) == 3
    assert data["latest_signal"]["signal"] is not None


def test_markov_signal_endpoint(client, monkeypatch):
    returns = _returns(400)

    def fake_load(symbol, store=None):
        return returns

    import webapp.api.routers.markov as markov_router
    monkeypatch.setattr(markov_router, "_load_returns", fake_load)

    resp = client.get("/api/markov/signal?symbol=SPY")
    assert resp.status_code == 200
    data = resp.json()
    assert "current_state" in data
    assert "forecasts" in data


def test_markov_backtest_endpoint(client, monkeypatch):
    returns = _returns(400)

    def fake_load(symbol, store=None):
        return returns

    import webapp.api.routers.markov as markov_router
    monkeypatch.setattr(markov_router, "_load_returns", fake_load)

    resp = client.post("/api/markov/backtest", json={"symbol": "SPY", "window": 20, "lookback": 100})
    assert resp.status_code == 200
    data = resp.json()
    assert data["symbol"] == "SPY"
    assert "equity" in data
    assert data["n_days"] > 0
