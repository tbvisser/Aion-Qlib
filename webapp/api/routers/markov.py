"""Markov Chain regime analyzer HTTP surface.

Three endpoints expose the engine in ``webapp.api.markov_chain``:
- analyze: full transition matrix, forecasts, stationary distribution, backtest.
- signal: lightweight latest signal for chat and quick checks.
- backtest: walk-forward position/return series.
"""
from __future__ import annotations

import math
from typing import Literal

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import marketdata, qlib_session
from ..markov_chain import compute_summary, walkforward_signals, backtest_from_signals

router = APIRouter()


def _clean(value) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _load_returns(symbol: str, store: str | None = None) -> pd.Series:
    """Load adjusted daily returns for one symbol from the mounted qlib store.

    Falls back to a split-adjusted Yahoo fetch only when no store is available.
    """
    symbol = symbol.upper()

    # If a specific store was requested, use its universe lookup. Otherwise use
    # whichever store the API process has mounted.
    if store:
        chosen = marketdata.store_for(store)
        if chosen is None:
            raise HTTPException(status_code=404, detail=f"Unknown store '{store}'")
        provider_uri = chosen["provider_uri"]
    else:
        state = qlib_session.status()
        if not state.get("ready"):
            # No store mounted; try Yahoo as a convenience for ad-hoc queries.
            return _yahoo_returns(symbol)
        provider_uri = state["provider_uri"]

    qlib_session.require_qlib()
    from qlib.data import D

    try:
        df = D.features([symbol], ["$close"], start_time=None, end_time=None)
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"Could not load prices for {symbol}: {exc}"
        ) from exc

    if df is None or df.empty:
        # Symbol may not be in the mounted store; degrade to Yahoo if possible.
        try:
            return _yahoo_returns(symbol)
        except Exception:
            raise HTTPException(
                status_code=404, detail=f"No price data for '{symbol}' in the store or Yahoo."
            ) from None

    close = df.droplevel("instrument")["$close"]
    returns = close.pct_change().dropna()
    returns.name = symbol
    return returns


def _yahoo_returns(symbol: str) -> pd.Series:
    """Fetch split-adjusted returns from Yahoo Finance via yfinance."""
    try:
        import yfinance as yf
    except ImportError as exc:
        raise HTTPException(
            status_code=409,
            detail="No qlib store is mounted and yfinance is not installed."
        ) from exc

    ticker = yf.Ticker(symbol)
    hist = ticker.history(period="10y", interval="1d")
    if hist.empty:
        raise HTTPException(status_code=404, detail=f"No Yahoo data for '{symbol}'")
    returns = hist["Close"].pct_change().dropna()
    returns.name = symbol
    return returns


@router.get("/markov/analyze")
def analyze(
    symbol: str,
    window: int = Query(20, ge=2, le=252),
    bull: float = Query(0.02, ge=0.0, le=1.0),
    bear: float = Query(-0.02, ge=-1.0, le=0.0),
    lookback: int = Query(252, ge=30, le=2520),
    steps: str = Query("1,5,12,24"),
    store: str | None = None,
) -> dict:
    """Full Markov Chain regime analysis for one symbol."""
    returns = _load_returns(symbol, store)
    if len(returns) < window + lookback + 10:
        raise HTTPException(
            status_code=400,
            detail=f"Need at least {window + lookback + 10} sessions; got {len(returns)}."
        )

    try:
        step_list = tuple(int(s.strip()) for s in steps.split(",") if s.strip())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid steps: {steps}") from exc

    try:
        result = compute_summary(
            returns,
            bull_threshold=bull,
            bear_threshold=bear,
            window=window,
            lookback=lookback,
            forecast_steps=step_list,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    result["source"] = "store" if qlib_session.status().get("ready") else "yahoo"
    return result


@router.get("/markov/signal")
def signal(
    symbol: str,
    window: int = Query(20, ge=2, le=252),
    bull: float = Query(0.02, ge=0.0, le=1.0),
    bear: float = Query(-0.02, ge=-1.0, le=0.0),
    lookback: int = Query(252, ge=30, le=2520),
    steps: str = Query("1,5,12,24"),
    store: str | None = None,
) -> dict:
    """Latest Markov signal plus a short forecast strip."""
    full = analyze(symbol, window, bull, bear, lookback, steps, store)
    latest = full["latest_signal"]
    return {
        "symbol": full.get("symbol"),
        "as_of": full["as_of"],
        "current_state": full["current_state"],
        "signal": latest["signal"],
        "position": latest["position"],
        "bull_prob": latest["bull_prob"],
        "bear_prob": latest["bear_prob"],
        "sideways_prob": latest["sideways_prob"],
        "forecasts": full["forecasts"],
        "transition_matrix": full["transition_matrix"],
        "stationary_distribution": full["stationary_distribution"],
        "backtest": full["backtest"],
    }


class BacktestRequest(BaseModel):
    symbol: str
    window: int = Field(20, ge=2, le=252)
    bull: float = Field(0.02, ge=0.0, le=1.0)
    bear: float = Field(-0.02, ge=-1.0, le=0.0)
    lookback: int = Field(252, ge=30, le=2520)


@router.post("/markov/backtest")
def backtest(req: BacktestRequest) -> dict:
    """Walk-forward backtest driven by the Markov signal."""
    returns = _load_returns(req.symbol)
    if len(returns) < req.window + req.lookback + 10:
        raise HTTPException(
            status_code=400,
            detail=f"Need at least {req.window + req.lookback + 10} sessions; got {len(returns)}."
        )

    signals = walkforward_signals(
        returns,
        lookback=req.lookback,
        bull_threshold=req.bull,
        bear_threshold=req.bear,
        window=req.window,
    )
    strat_returns = backtest_from_signals(returns, signals).dropna()

    equity = []
    if not strat_returns.empty:
        cumulative = (1 + strat_returns).cumprod()
        equity = [
            {"date": str(d.date()), "return": _clean(r), "equity": _clean(v)}
            for (d, r), v in zip(strat_returns.items(), cumulative)
        ]

    return {
        "symbol": req.symbol.upper(),
        "parameters": req.model_dump(),
        "n_days": len(strat_returns),
        "annualized_return": _clean(strat_returns.mean() * 252) if not strat_returns.empty else None,
        "annualized_sharpe": _sharpe(strat_returns),
        "max_drawdown": _max_drawdown((1 + strat_returns).cumprod()) if not strat_returns.empty else None,
        "equity": equity,
    }


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
