"""Markov Chain regime model for a single price series.

Implements the observable Markov Chain framework from the article:
- Label each day Bull / Bear / Sideways from rolling returns.
- Estimate the transition matrix by maximum likelihood counting.
- Forecast n-step regime probabilities via matrix powers.
- Compute the stationary distribution.
- Generate walk-forward trading signals and backtest them.

The module has no dependency on an initialised qlib store; callers that have a
store pass a return Series, and callers without one can pass raw returns from
any source.
"""
from __future__ import annotations

import logging
import math
from typing import Literal

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

State = Literal[0, 1, 2]
STATE_NAMES = ["Bull", "Bear", "Sideways"]


def label_states(
    returns: pd.Series,
    bull_threshold: float = 0.02,
    bear_threshold: float = -0.02,
    window: int = 20,
) -> pd.Series:
    """Label each date as Bull (0), Bear (1) or Sideways (2) from rolling returns.

    Parameters
    ----------
    returns : pd.Series
        Daily returns, e.g. from ``close.pct_change().dropna()``.
    bull_threshold : float
        Rolling return above this value -> Bull.
    bear_threshold : float
        Rolling return below this value -> Bear.
    window : int
        Rolling window length in sessions.

    Returns
    -------
    pd.Series
        Integer state labels aligned to the original index.
    """
    if window < 1:
        raise ValueError("window must be at least 1")
    rolling = returns.rolling(window).sum()
    states = np.where(
        rolling > bull_threshold,
        0,
        np.where(rolling < bear_threshold, 1, 2),
    )
    return pd.Series(states, index=returns.index, name="state")


def estimate_transition_matrix(states: pd.Series, n_states: int = 3) -> np.ndarray:
    """Maximum-likelihood transition matrix from a state sequence.

    Rows sum to 1.0 where the source state was observed; unvisited states keep
    a uniform row so downstream math stays well-defined.
    """
    counts = np.zeros((n_states, n_states), dtype=float)
    vals = states.dropna().to_numpy(dtype=int)
    for i in range(len(vals) - 1):
        a, b = vals[i], vals[i + 1]
        if 0 <= a < n_states and 0 <= b < n_states:
            counts[a][b] += 1

    P = np.zeros((n_states, n_states), dtype=float)
    for i in range(n_states):
        row_sum = counts[i].sum()
        if row_sum > 0:
            P[i] = counts[i] / row_sum
        else:
            P[i] = 1.0 / n_states
    return P


def multi_step_transition(P: np.ndarray, n_steps: int) -> np.ndarray:
    """n-step transition matrix via Chapman-Kolmogorov."""
    if n_steps < 1:
        raise ValueError("n_steps must be at least 1")
    return np.linalg.matrix_power(P, n_steps)


def stationary_distribution(P: np.ndarray) -> np.ndarray:
    """Solve π = πP with the constraint that probabilities sum to 1."""
    n = P.shape[0]
    A = (P.T - np.eye(n)).astype(float)
    A[-1] = 1.0
    b = np.zeros(n)
    b[-1] = 1.0
    try:
        pi = np.linalg.solve(A, b)
    except np.linalg.LinAlgError:
        logger.warning("singular stationary-distribution matrix; returning uniform")
        pi = np.ones(n) / n
    return pi


def generate_signal(P: np.ndarray, current_state: int) -> float:
    """Bull probability minus bear probability for the next step."""
    return float(P[current_state][0] - P[current_state][1])


def position_from_signal(signal: float, deadband: float = 0.1, saturate: float = 0.3) -> float:
    """Map a signal to a position in [-1, 1].

    Matches the article's logic:
    - signal > saturate  -> +1 (long)
    - signal < -saturate -> -1 (short)
    - |signal| < deadband -> 0 (flat)
    - otherwise scale linearly between deadband and saturate.
    """
    if signal > saturate:
        return 1.0
    if signal < -saturate:
        return -1.0
    if abs(signal) < deadband:
        return 0.0
    # Linear interpolation from deadband to saturate.
    sign = 1.0 if signal > 0 else -1.0
    return sign * (abs(signal) - deadband) / (saturate - deadband)


def walkforward_signals(
    returns: pd.Series,
    lookback: int = 252,
    bull_threshold: float = 0.02,
    bear_threshold: float = -0.02,
    window: int = 20,
    deadband: float = 0.1,
    saturate: float = 0.3,
) -> pd.DataFrame:
    """Walk-forward signal series re-estimating P each day with only past data.

    Returns a DataFrame indexed by date with columns:
        state, signal, position, bull_prob, bear_prob, sideways_prob
    """
    states = label_states(returns, bull_threshold, bear_threshold, window)
    rows: list[dict] = []
    for i in range(lookback, len(states)):
        hist = states.iloc[i - lookback : i]
        P = estimate_transition_matrix(hist)
        current = int(states.iloc[i])
        probs = P[current]
        signal = generate_signal(P, current)
        rows.append(
            {
                "date": states.index[i],
                "state": current,
                "signal": signal,
                "position": position_from_signal(signal, deadband, saturate),
                "bull_prob": probs[0],
                "bear_prob": probs[1],
                "sideways_prob": probs[2],
            }
        )
    if not rows:
        return pd.DataFrame(
            columns=["date", "state", "signal", "position", "bull_prob", "bear_prob", "sideways_prob"]
        )
    df = pd.DataFrame(rows).set_index("date")
    df.index = pd.DatetimeIndex(df.index)
    return df


def backtest_from_signals(
    returns: pd.Series,
    signals: pd.DataFrame,
) -> pd.Series:
    """Strategy returns from the walk-forward position series.

    Position is shifted by one day so it is applied to the next day's return,
    avoiding lookahead.
    """
    positions = signals["position"].shift(1)
    aligned = positions.reindex(returns.index, method=None)
    return aligned * returns


def _sharpe(returns: pd.Series, ann_factor: int = 252) -> float | None:
    std = returns.std()
    if std is None or std == 0 or not math.isfinite(std):
        return None
    return float(returns.mean() / std * math.sqrt(ann_factor))


def _max_drawdown(cumulative: pd.Series) -> float | None:
    if cumulative.empty:
        return None
    running_max = cumulative.cummax()
    dd = (cumulative - running_max) / running_max
    return float(dd.min())


def _clean(value) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def compute_summary(
    returns: pd.Series,
    bull_threshold: float = 0.02,
    bear_threshold: float = -0.02,
    window: int = 20,
    lookback: int = 252,
    forecast_steps: tuple[int, ...] = (1, 5, 12, 24),
    deadband: float = 0.1,
    saturate: float = 0.3,
) -> dict:
    """Complete Markov Chain summary for a return series.

    Returns a JSON-safe dict with transition matrix, forecasts, stationary
    distribution, regime counts, latest signal, and walk-forward backtest
    metrics.
    """
    states = label_states(returns, bull_threshold, bear_threshold, window)
    P = estimate_transition_matrix(states)

    # Latest complete observation: the last non-NaN state.
    valid_states = states.dropna()
    if valid_states.empty:
        raise ValueError("not enough returns to estimate a transition matrix")

    current_state = int(valid_states.iloc[-1])

    forecasts = {}
    for step in forecast_steps:
        Pn = multi_step_transition(P, step)
        probs = Pn[current_state]
        forecasts[str(step)] = {
            "bull": _clean(probs[0]),
            "bear": _clean(probs[1]),
            "sideways": _clean(probs[2]),
        }

    pi = stationary_distribution(P)

    signal_df = walkforward_signals(
        returns, lookback, bull_threshold, bear_threshold, window, deadband, saturate
    )

    backtest_metrics = {}
    equity_series: list[dict] = []
    if not signal_df.empty:
        strat_returns = backtest_from_signals(returns, signal_df)
        strat_returns = strat_returns.dropna()
        if not strat_returns.empty:
            cumulative = (1 + strat_returns).cumprod()
            equity_series = [
                {"date": str(d.date()), "equity": _clean(v)}
                for d, v in cumulative.items()
            ]
            backtest_metrics = {
                "annualized_return": _clean(strat_returns.mean() * 252),
                "annualized_sharpe": _sharpe(strat_returns),
                "max_drawdown": _max_drawdown(cumulative),
                "n_days": int(len(strat_returns)),
            }

    regime_counts = valid_states.value_counts().sort_index().to_dict()

    return {
        "symbol": str(returns.name) if returns.name else None,
        "as_of": str(valid_states.index[-1].date()),
        "parameters": {
            "window": window,
            "bull_threshold": bull_threshold,
            "bear_threshold": bear_threshold,
            "lookback": lookback,
        },
        "current_state": STATE_NAMES[current_state],
        "transition_matrix": [
            {"from": STATE_NAMES[i], "to": {STATE_NAMES[j]: _clean(P[i][j]) for j in range(3)}}
            for i in range(3)
        ],
        "forecasts": forecasts,
        "stationary_distribution": {
            STATE_NAMES[i]: _clean(pi[i]) for i in range(3)
        },
        "regime_counts": {
            (STATE_NAMES[k] if isinstance(k, int) and 0 <= k < len(STATE_NAMES) else str(k)): int(v)
            for k, v in regime_counts.items()
        },
        "latest_signal": {
            "date": str(signal_df.index[-1].date()) if not signal_df.empty else None,
            "signal": _clean(signal_df["signal"].iloc[-1]) if not signal_df.empty else None,
            "position": _clean(signal_df["position"].iloc[-1]) if not signal_df.empty else None,
            "bull_prob": _clean(signal_df["bull_prob"].iloc[-1]) if not signal_df.empty else None,
            "bear_prob": _clean(signal_df["bear_prob"].iloc[-1]) if not signal_df.empty else None,
            "sideways_prob": _clean(signal_df["sideways_prob"].iloc[-1]) if not signal_df.empty else None,
        },
        "backtest": backtest_metrics,
        "equity_curve": equity_series,
        "signal_series": [
            {
                "date": str(d.date()),
                "state": STATE_NAMES[int(row["state"])],
                "signal": _clean(row["signal"]),
                "position": _clean(row["position"]),
            }
            for d, row in signal_df.iterrows()
        ],
    }
