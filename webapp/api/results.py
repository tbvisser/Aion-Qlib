"""Read a finished run's artifacts out of MLflow and shape them for charts.

Every object here is the one qlib itself wrote during the run
(``qlib/workflow/record_temp.py``): ``pred.pkl``, ``portfolio_analysis/*.pkl``,
and the logged metrics. Nothing is recomputed, so what the UI plots is exactly
what the engine produced -- the same objects
``examples/workflow_by_code.ipynb`` charts.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd


def _clean(x) -> float | None:
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


EXPERIMENT_PREFIX = "aion-"
# Runs started before the AION rename were written under this prefix. They are
# still on disk and still readable, so the read path probes it as a fallback.
_LEGACY_EXPERIMENT_PREFIX = "qlibstudio-"


def resolve_experiment(run_id: str, recorded: str | None = None) -> str:
    """The MLflow experiment holding ``run_id``'s results.

    Runs record their own experiment name at launch (see runner.py), so
    ``recorded`` is authoritative when present. Runs that predate that -- and
    those written under the old prefix -- are found by probing both names.
    """
    if recorded:
        return recorded
    current = f"{EXPERIMENT_PREFIX}{run_id}"
    legacy = f"{_LEGACY_EXPERIMENT_PREFIX}{run_id}"
    if find_recorder(current) is None and find_recorder(legacy) is not None:
        return legacy
    return current


def find_recorder(experiment_name: str):
    """The single recorder an AION run produced, or None."""
    from qlib.workflow import R

    try:
        exp = R.get_exp(experiment_name=experiment_name, create=False)
    except Exception:
        return None
    try:
        recorders = exp.list_recorders()
    except Exception:
        return None
    if not recorders:
        return None
    # Each run gets its own experiment, so there is normally exactly one.
    items = list(recorders.values()) if isinstance(recorders, dict) else list(recorders)
    items.sort(key=lambda r: getattr(r, "start_time", "") or "", reverse=True)
    return items[0]


def _load(recorder, name: str):
    try:
        return recorder.load_object(name)
    except Exception:
        return None


def _series_points(series: pd.Series, every: int = 1) -> list[dict]:
    out: list[dict] = []
    for i, (idx, value) in enumerate(series.items()):
        if i % every:
            continue
        try:
            date = str(pd.Timestamp(idx).date())
        except Exception:
            date = str(idx)
        out.append({"date": date, "value": _clean(value)})
    return out


def build_report(experiment_name: str) -> dict[str, Any] | None:
    """Metrics + curves for one run, or None when nothing was recorded."""
    recorder = find_recorder(experiment_name)
    if recorder is None:
        return None

    report: dict[str, Any] = {
        "recorder_id": getattr(recorder, "id", None),
        "experiment_name": experiment_name,
        "metrics": {},
        "curves": {},
        "risk": {},
    }

    # Signal-quality metrics (IC / ICIR / Rank IC), logged by SigAnaRecord.
    try:
        metrics = recorder.list_metrics() or {}
    except Exception:
        metrics = {}
    report["metrics"] = {k: _clean(v) for k, v in metrics.items()}

    # Portfolio analysis: the risk table and the daily return series.
    analysis = _load(recorder, "portfolio_analysis/port_analysis_1day.pkl")
    if isinstance(analysis, pd.DataFrame):
        risk: dict[str, dict[str, float | None]] = {}
        for row_key, row in analysis.iterrows():
            group = str(row_key[0]) if isinstance(row_key, tuple) else str(row_key)
            metric = str(row_key[1]) if isinstance(row_key, tuple) and len(row_key) > 1 else "value"
            risk.setdefault(group, {})[metric] = _clean(row.iloc[0])
        report["risk"] = risk

    normal = _load(recorder, "portfolio_analysis/report_normal_1day.pkl")
    if isinstance(normal, pd.DataFrame) and not normal.empty:
        # `return` is the strategy, `bench` the benchmark; cost is already
        # deducted in the columns qlib reports with the _wo_cost pair.
        frame = normal.copy()
        frame.index = pd.to_datetime(frame.index)

        curves: dict[str, list[dict]] = {}
        if "return" in frame:
            strat = frame["return"].fillna(0)
            curves["strategy"] = _series_points((1 + strat).cumprod() - 1)
        if "bench" in frame:
            bench = frame["bench"].fillna(0)
            curves["benchmark"] = _series_points((1 + bench).cumprod() - 1)
        if "return" in frame and "cost" in frame:
            net = (frame["return"] - frame["cost"]).fillna(0)
            curves["net_of_cost"] = _series_points((1 + net).cumprod() - 1)
        if "return" in frame and "bench" in frame:
            excess = (frame["return"] - frame["cost"].fillna(0) - frame["bench"]).fillna(0)
            cumulative = (1 + excess).cumprod() - 1
            curves["excess"] = _series_points(cumulative)
            peak = (1 + cumulative).cummax()
            curves["drawdown"] = _series_points((1 + cumulative) / peak - 1)

        report["curves"] = curves
        report["period"] = {
            "start": str(frame.index[0].date()),
            "end": str(frame.index[-1].date()),
            "days": int(len(frame)),
        }

    # Turnover / fill-rate indicators.
    indicators = _load(recorder, "portfolio_analysis/indicator_analysis_1day.pkl")
    if isinstance(indicators, pd.DataFrame):
        report["indicators"] = {
            str(k): _clean(v.iloc[0]) for k, v in indicators.iterrows()
        }

    report["sanity"] = _sanity(report["risk"].get("excess_return_with_cost") or {})

    return report


#: Where a number stops being a result and starts being a fault.
#:
#: Loose on purpose. These are not "good strategy" thresholds -- a real one can
#: be terrible -- they are the line past which the arithmetic says the input was
#: broken. 10 is 1,000%/yr compounding; a drawdown past -1 is more than the whole
#: account; daily excess volatility of 5 is 500% a day.
_MAX_ANNUALISED = 10.0
_MAX_DRAWDOWN = -1.0
_MAX_VOLATILITY = 5.0


def _sanity(excess: dict[str, float | None]) -> dict[str, Any]:
    """Whether the portfolio numbers can be read as a result at all.

    Decided here rather than in each of the three surfaces that print these
    metrics, so they cannot disagree about the same run.

    What this catches is not a bad strategy but a broken input: an unfiltered
    universe whose tail carries prints off by orders of magnitude, a book of one
    name, and nothing capping a daily move. qlib compounds that to exit 0 and a
    cheerful number, so nothing else in the pipeline objects.

    Reasons name what is wrong, not the threshold that tripped -- a reader needs
    to know the run is unusable and roughly why, not this module's constants.
    """
    reasons: list[str] = []

    annualised = excess.get("annualized_return")
    if annualised is not None and abs(annualised) > _MAX_ANNUALISED:
        reasons.append(
            f"An annualised excess return of {annualised * 100:,.0f}% is not a "
            f"result. A single bad print filled at full size compounds like this.")

    drawdown = excess.get("max_drawdown")
    if drawdown is not None and drawdown < _MAX_DRAWDOWN:
        reasons.append(
            f"A maximum drawdown of {drawdown * 100:,.0f}% is more than the whole "
            f"account, which a long-only book cannot lose.")

    volatility = excess.get("std")
    if volatility is not None and volatility > _MAX_VOLATILITY:
        reasons.append(
            f"Daily excess-return volatility of {volatility:,.1f} is not a market; "
            f"the return series is dominated by data errors.")

    return {"implausible": bool(reasons), "reasons": reasons}


def prediction_sample(experiment_name: str, limit: int = 50) -> dict[str, Any] | None:
    """Most recent day's top predictions — what the strategy would buy next."""
    recorder = find_recorder(experiment_name)
    if recorder is None:
        return None
    pred = _load(recorder, "pred.pkl")
    if not isinstance(pred, (pd.DataFrame, pd.Series)) or pred.empty:
        return None

    frame = pred.to_frame("score") if isinstance(pred, pd.Series) else pred.rename(
        columns={pred.columns[0]: "score"}
    )
    last_date = frame.index.get_level_values("datetime").max()
    today = frame.xs(last_date, level="datetime").sort_values("score", ascending=False)

    return {
        "date": str(pd.Timestamp(last_date).date()),
        "top": [
            {"instrument": str(inst), "score": _clean(row["score"])}
            for inst, row in today.head(limit).iterrows()
        ],
    }
