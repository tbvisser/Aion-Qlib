"""Factor evaluation: catalog + information coefficient.

The IC computation deliberately mirrors what qlib's own ``SignalRecord`` /
``SigAnaRecord`` report after a backtest (``qlib/workflow/record_temp.py``), so
a factor's score here is comparable with the IC printed by a full run rather
than being a second, subtly different statistic.
"""
from __future__ import annotations

import math
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import marketdata, qlib_session
from ..factorlab import curated as curated_lib
from ..factorlab import indicators as indicator_lib
from ..factorlab import operators as operator_lib
from ..factorlab.expressions import (
    ExpressionError, compile_expression, explain, inspect_expression,
)
from ..factorlab.stores import census

router = APIRouter()

MAX_UNIVERSE = 600


def _mounted_store() -> dict | None:
    """The store the API process itself can query, if any."""
    return next((s for s in marketdata.data_stores() if s["mounted"]), None)


@router.get("/factors")
def catalog(store: str | None = None) -> dict:
    """The canvas's mount payload: the factor library, operators, real columns.

    `operators` and `fields` used to be two hand-written lists. Both were wrong:
    the operator list named 25 of 44 and rendered `Min(x, n)` for an operator the
    canvas calls `Min` with different slot names, and the field list claimed
    `$factor` and `$change` for whichever store happened to be mounted. Both are
    now read from the source that decides them.

    `factors` used to be a ten-entry list in this file. It is now the curated
    library, loaded from YAML and judged against a store the same way
    `/indicators` judges Alpha158 -- so a factor naming a column this store lacks
    says so rather than evaluating to NaN in silence.
    """
    if store is not None:
        chosen = marketdata.store_for(store)
        if chosen is None:
            raise HTTPException(status_code=404, detail=f"Unknown store '{store}'.")
    else:
        chosen = _mounted_store()

    provider_uri = chosen["provider_uri"] if chosen else None
    library = curated_lib.curated_payload(provider_uri)
    found = census(provider_uri) if provider_uri else {"fields": [], "exists": False}
    fields = found["fields"] if found["exists"] else []
    return {
        "factors": library["factors"],
        "families": library["families"],
        "store": library["store"],
        "operators": operator_lib.operator_signatures(),
        # Prefixed the way an expression writes them, and empty rather than
        # invented when nothing is mounted -- the canvas falls back to its
        # built-in list, which is honest about being a guess.
        "fields": [f"${name}" for name in fields],
    }


@router.get("/operators")
def operators() -> dict:
    """The operator vocabulary, introspected from ``qlib.data.ops.OpsList``.

    Served rather than hardcoded because the canvas's built-in copy had drifted:
    it was missing `And`/`Or`/`Not` entirely -- so the parser recommended `And(...)`
    and then refused it -- and it declared `Kurt`'s minimum window as 5, the number
    in qlib's error message, when the guard it raises from is `N < 4`.
    """
    return operator_lib.registry_payload()


@router.get("/indicators")
def indicators(store: str | None = None) -> dict:
    """The Alpha158 library, judged against one store.

    The store argument is a store *key* rather than a path, and defaults to the
    mounted one. `runnable: false` means the store lacks a column the expression
    names -- which qlib does not treat as an error, so nothing else in the stack
    would ever tell you.
    """
    if store is not None:
        chosen = marketdata.store_for(store)
        if chosen is None:
            raise HTTPException(status_code=404, detail=f"Unknown store '{store}'.")
    else:
        chosen = _mounted_store()
    return indicator_lib.library_payload(chosen["provider_uri"] if chosen else None)


class EvaluateRequest(BaseModel):
    expression: str = Field(..., description="A qlib expression, e.g. Ref($close,20)/$close - 1")
    universe: str = "top500"
    start: str | None = None
    end: str | None = None
    horizon: int = Field(5, ge=1, le=60, description="Forward-return horizon in trading days")


def _clean(x) -> float | None:
    if x is None:
        return None
    f = float(x)
    return f if math.isfinite(f) else None


def _cross_sectional_corr(a: pd.DataFrame, b: pd.DataFrame, min_names: int = 3) -> pd.Series:
    """Per-row Pearson correlation of two date x instrument frames.

    Only cells present in both are used, so a name missing on one side never
    silently pairs a factor value with someone else's return.
    """
    both = a.notna() & b.notna()
    a = a.where(both)
    b = b.where(both)

    a_centered = a.sub(a.mean(axis=1), axis=0)
    b_centered = b.sub(b.mean(axis=1), axis=0)

    covariance = (a_centered * b_centered).sum(axis=1)
    denominator = np.sqrt((a_centered**2).sum(axis=1) * (b_centered**2).sum(axis=1))

    corr = covariance / denominator.replace(0, np.nan)
    return corr.where(both.sum(axis=1) >= min_names).replace([np.inf, -np.inf], np.nan).dropna()


class ValidateRequest(BaseModel):
    expression: str
    role: Literal["feature", "label"] = "feature"
    #: Check the columns against a store as well. Optional: the rest of the
    #: check needs no data at all.
    store: str | None = None


@router.post("/factors/validate")
def validate(req: ValidateRequest) -> dict:
    """Is this expression safe to run, and what does it read?

    Its own endpoint because it costs about 160 µs and needs neither a store nor
    an initialised qlib -- so the canvas can refuse a lookahead factor while it
    is being drawn, rather than at the end of a three-minute backtest.
    """
    available = None
    if req.store:
        chosen = marketdata.store_for(req.store)
        if chosen is None:
            raise HTTPException(status_code=404, detail=f"Unknown store '{req.store}'.")
        found = census(chosen["provider_uri"])
        if found["exists"]:
            available = set(found["fields"])

    defects = inspect_expression(req.expression, role=req.role,
                                 available_fields=available)
    payload: dict = {
        "ok": not defects,
        "defects": [d.as_dict() for d in defects],
    }
    try:
        node = compile_expression(req.expression)
    except ExpressionError:
        return payload

    back = node.get_longest_back_rolling()
    payload["reads_ahead_days"] = int(node.get_extended_window_size()[1])
    payload["longest_back_rolling"] = None if math.isinf(back) else int(back)
    payload["rendered"] = str(node)
    return payload


@router.post("/factors/evaluate")
def evaluate(req: EvaluateRequest) -> dict:
    """Cross-sectional IC of one expression against forward returns."""
    # Refused, not scored with a caption. A lookahead factor's IC is
    # spectacular and meaningless, and a beautiful number with a warning under
    # it is a number that gets screenshotted without the warning.
    #
    # This also runs *before* `D.features`, which evals the raw string inside
    # qlib's module globals -- so the whitelist in `compile_expression` is what
    # stops that being an arbitrary-execution hole.
    defects = inspect_expression(req.expression, role="feature")
    if defects:
        raise HTTPException(status_code=422, detail={
            "message": "This expression cannot be measured.",
            "errors": [d.as_dict() for d in defects],
        })

    qlib_session.require_qlib()
    from qlib.data import D

    try:
        symbols = D.list_instruments(D.instruments(req.universe), as_list=True)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"Unknown universe '{req.universe}': {exc}") from exc

    if len(symbols) > MAX_UNIVERSE:
        raise HTTPException(status_code=400, detail=f"Universe too large ({len(symbols)}).")

    # The forward return is built from the same adjusted close the factor sees.
    # Ref(x, -n) looks forward in qlib, which is exactly the label convention
    # the Alpha158 workflow configs use.
    label = f"Ref($close,-{req.horizon})/Ref($close,-1) - 1"

    try:
        df = D.features(
            sorted(symbols), [req.expression, label],
            start_time=req.start, end_time=req.end,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=explain(exc, req.expression)) from exc

    if df is None or df.empty:
        raise HTTPException(status_code=400, detail="Expression produced no data over this range.")

    df.columns = ["factor", "label"]
    df = df.replace([np.inf, -np.inf], np.nan).dropna()
    if df.empty:
        raise HTTPException(status_code=400, detail="No overlapping factor/label observations.")

    # IC per day across the cross-section; a single-name correlation would be a
    # different (and far less meaningful) statistic.
    #
    # Computed as matrix algebra on date x instrument frames rather than a
    # groupby-apply: with 500 names over a decade that is ~4000 tiny pandas
    # calls, which took tens of seconds and made the UI look hung.
    factor_wide = df["factor"].unstack("instrument")
    label_wide = df["label"].unstack("instrument")
    ic = _cross_sectional_corr(factor_wide, label_wide)
    rank_ic = _cross_sectional_corr(
        factor_wide.rank(axis=1), label_wide.rank(axis=1)
    )

    if ic.empty:
        raise HTTPException(status_code=400, detail="Not enough cross-sectional breadth to compute IC.")

    def stats(series: pd.Series) -> dict:
        mean, std = series.mean(), series.std()
        return {
            "mean": _clean(mean),
            "std": _clean(std),
            # ICIR is the IC's own t-like ratio, matching qlib's SigAnaRecord.
            "ir": _clean(mean / std) if std and std > 0 else None,
            "positive_rate": _clean((series > 0).mean()),
        }

    # Monthly means keep the chart readable over a decade of daily values.
    monthly = ic.groupby(pd.Grouper(level="datetime", freq="ME")).mean().dropna()

    return {
        "expression": req.expression,
        "universe": req.universe,
        "horizon": req.horizon,
        "observations": int(len(df)),
        "days": int(len(ic)),
        "ic": stats(ic),
        "rank_ic": stats(rank_ic),
        "series": [
            {"date": str(pd.Timestamp(d).date()), "ic": _clean(v)}
            for d, v in monthly.items()
        ],
        "cumulative_ic": _clean(ic.sum()),
    }
