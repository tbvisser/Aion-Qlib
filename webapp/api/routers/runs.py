"""Strategy CRUD, run launching, live progress, and results."""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from .. import marketdata, qlib_session, results, strategy_explain
from ..config import get_settings
from ..runner import RunBusy, RunManager
from ..strategies import (
    HANDLERS,
    StrategySpec,
    StrategyStore,
    available_models,
    build_workflow_config,
    coverage_report,
    render_yaml,
)
from ..strategy_gen.draft import DraftError, lower_draft
from ..strategy_gen import templates as strategy_templates

router = APIRouter()

_settings = get_settings()
_store = StrategyStore(_settings.strategies_dir)
_runs = RunManager(_settings.runs_dir, _settings.repo_root)


def _store_context(spec=None) -> tuple[str, str]:
    """The provider_uri/region the run's YAML should carry.

    The resolution itself lives in ``marketdata.resolve_store`` so the CLI
    seeder can use it without importing FastAPI; this only maps its refusal
    onto the two status codes the UI distinguishes -- 400 for a store that does
    not exist as a concept, 503 for one that exists but has not been built.
    """
    key = getattr(spec, "data_store", None) or "us"
    try:
        return marketdata.resolve_store(key)
    except marketdata.StoreError as exc:
        status = 400 if marketdata.store_for(key) is None else 503
        raise HTTPException(status_code=status, detail=str(exc)) from exc


# --------------------------------------------------------------------------
# Strategies
# --------------------------------------------------------------------------
@router.get("/models")
def models() -> dict:
    return {"models": available_models(), "handlers": list(HANDLERS)}


@router.get("/strategies")
def list_strategies() -> dict:
    return {"strategies": [s.model_dump() for s in _store.list()]}


@router.post("/strategies")
def create_strategy(spec: StrategySpec) -> dict:
    provider_uri, _ = _store_context(spec)
    problems = spec.validate_windows() + spec.validate_features(provider_uri)
    if problems:
        raise HTTPException(status_code=400, detail=" ".join(problems))
    return _store.create(spec).model_dump()


@router.get("/strategies/{strategy_id}")
def get_strategy(strategy_id: str) -> dict:
    stored = _store.get(strategy_id)
    if stored is None:
        raise HTTPException(status_code=404, detail="No such strategy")
    return stored.model_dump()


@router.put("/strategies/{strategy_id}")
def update_strategy(strategy_id: str, spec: StrategySpec) -> dict:
    provider_uri, _ = _store_context(spec)
    problems = spec.validate_windows() + spec.validate_features(provider_uri)
    if problems:
        raise HTTPException(status_code=400, detail=" ".join(problems))
    stored = _store.update(strategy_id, spec)
    if stored is None:
        raise HTTPException(status_code=404, detail="No such strategy")
    return stored.model_dump()


@router.delete("/strategies/{strategy_id}", status_code=204)
def delete_strategy(strategy_id: str) -> None:
    if not _store.delete(strategy_id):
        raise HTTPException(status_code=404, detail="No such strategy")


@router.post("/strategies/preview")
def preview_strategy(spec: StrategySpec) -> dict:
    """The exact YAML that would be handed to qrun, plus any window warnings."""
    provider_uri, region = _store_context(spec)
    store = marketdata.store_for(spec.data_store) or {}
    # The *same* call `build_workflow_config` makes, not the store dict's own
    # `calendar_end`. The two agree in production — the dict's value is this
    # function's — but deriving it twice means a fixture, a cache or a refactor
    # can split them, and the split shows up as a builder drawing an end date
    # the run does not honour.
    safe_end = marketdata.store_calendar_end(spec.data_store)
    return {
        "yaml": render_yaml(spec, provider_uri, region),
        "warnings": spec.validate_windows() + spec.validate_features(provider_uri),
        # Advisory, and kept out of `warnings` on purpose -- see `coverage_report`.
        "coverage": coverage_report(spec, provider_uri),
        "explain": {
            "label": strategy_explain.label_summary(spec.handler),
            "calendar_start": store.get("calendar_start"),
            "calendar_end": safe_end,
            # The date the run will *actually* stop on. Computed with the same
            # comparison `build_workflow_config` applies, rather than re-derived
            # -- two implementations of one clamp is one too many.
            "effective_test_end": (
                safe_end if safe_end and spec.test_end > safe_end else spec.test_end
            ),
        },
    }


@router.post("/strategies/from-draft")
def strategy_from_draft(draft: dict) -> dict:
    """Lower a partial description of a strategy into a complete, runnable one.

    Takes a `StrategyDraft` -- the same vocabulary as a spec, but with every
    field optional -- and returns the filled-in spec, the exact YAML qrun would
    get, and one `assumed` row per decision nobody actually made. It neither
    stores nor runs anything: lowering is not launching.

    The body is taken as a raw dict rather than a `StrategyDraft` so that a
    malformed draft comes back as one 422 listing every problem, in draft
    coordinates, instead of FastAPI's own field errors -- the caller filling
    this in may well be a model reading its mistakes back.
    """
    try:
        lowered = lower_draft(draft)
    except DraftError as exc:
        raise HTTPException(status_code=422, detail={
            "message": "this draft cannot be lowered into a runnable strategy",
            "errors": exc.errors,
        }) from None
    return {
        "spec": lowered.spec.model_dump(),
        "yaml": lowered.yaml,
        "assumed": [a.model_dump() for a in lowered.assumed],
        "warnings": lowered.warnings,
    }


@router.get("/templates")
def list_templates() -> dict:
    """Curated strategies to start from, each lowered against this machine.

    A template that cannot run here is returned with ``runnable: false`` and the
    reasons attached rather than omitted — the same rule as `/models`, which
    reports what is installed instead of quietly offering a shorter list. The
    payload carries the same `spec`/`assumed`/`warnings` keys as
    `/strategies/from-draft`, so one renderer serves both.
    """
    return {
        "templates": strategy_templates.catalog(),
        # Served rather than retyped in the gallery: the family list and its
        # order are decided here, and a second copy in TypeScript would drift.
        "families": [{"key": key, "label": strategy_templates.FAMILY_LABELS[key]}
                     for key in strategy_templates.FAMILIES],
    }


@router.get("/templates/{template_id}")
def get_template(template_id: str) -> dict:
    template = strategy_templates.get_template(template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="No such template")
    return strategy_templates.materialise(template)


# --------------------------------------------------------------------------
# Runs
# --------------------------------------------------------------------------
class StartRunRequest(BaseModel):
    spec: StrategySpec
    strategy_id: str | None = None


@router.post("/runs")
def start_run(req: StartRunRequest) -> dict:
    provider_uri, region = _store_context(req.spec)
    problems = req.spec.validate_windows() + req.spec.validate_features(provider_uri)
    if problems:
        raise HTTPException(status_code=400, detail=" ".join(problems))

    config = build_workflow_config(req.spec, provider_uri, region)
    run = _runs.start(
        name=req.spec.name,
        config=config,
        kind="backtest",
        strategy_id=req.strategy_id,
        # What the run *was*, so a finished run can be compared against the
        # next attempt without re-reading a spec that has since been edited.
        # Widened over time: older runs lack the newer keys, and the UI renders
        # those as an em dash rather than as "unchanged".
        extra={"model": req.spec.model, "handler": req.spec.handler,
               "universe": req.spec.universe, "benchmark": req.spec.benchmark,
               "data_store": req.spec.data_store,
               "topk": req.spec.topk, "n_drop": req.spec.n_drop,
               "open_cost": req.spec.open_cost, "close_cost": req.spec.close_cost},
    )
    return dict(run.meta)


@router.get("/runs")
def list_runs(limit: int = 100) -> dict:
    return {"runs": _runs.list(limit=limit)}


@router.get("/runs/{run_id}")
def get_run(run_id: str) -> dict:
    run = _runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No such run")
    return dict(run.meta)


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str) -> dict:
    if not _runs.cancel(run_id):
        raise HTTPException(status_code=409, detail="Run is not cancellable")
    return {"ok": True}


@router.delete("/runs/{run_id}", status_code=204)
def delete_run(run_id: str) -> None:
    """Remove a finished run. Its MLflow artifacts stay on disk -- see RunManager.delete."""
    try:
        deleted = _runs.delete(run_id)
    except RunBusy:
        raise HTTPException(status_code=409, detail="Cancel the run before deleting it") from None
    if not deleted:
        raise HTTPException(status_code=404, detail="No such run")


@router.get("/runs/{run_id}/log")
def run_log(run_id: str, offset: int = 0, limit: int = 400) -> dict:
    run = _runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No such run")
    lines, next_offset = _runs.tail(run, offset=offset, limit=limit)
    return {"lines": lines, "next_offset": next_offset, "status": run.meta.get("status")}


@router.get("/runs/{run_id}/events")
async def run_events(run_id: str, offset: int = 0):
    """SSE: status/phase changes and new log lines until the run ends.

    `offset` is how many log lines the client already holds. EventSource
    reconnects on its own after any network hiccup, and a stream that always
    restarted at line 0 re-sent the whole log into a client that appends --
    so a proxy timeout showed up as a duplicated backtest log.
    """
    run = _runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No such run")

    async def stream():
        offset_ = max(0, offset)
        last_state: tuple | None = None
        while True:
            current = _runs.get(run_id)
            if current is None:
                break

            lines, offset_ = _runs.tail(current, offset=offset_, limit=200)
            if lines:
                # `offset` rides along so a reconnecting client can resume from
                # where this stream left off rather than from the beginning.
                yield {"event": "log",
                       "data": json.dumps({"lines": lines, "offset": offset_})}

            state = (current.meta.get("status"), current.meta.get("phase"))
            if state != last_state:
                last_state = state
                yield {"event": "status", "data": json.dumps(dict(current.meta))}

            if current.meta.get("status") in ("succeeded", "failed", "cancelled"):
                yield {"event": "done", "data": json.dumps(dict(current.meta))}
                break

            await asyncio.sleep(1.0)

    return EventSourceResponse(stream())


@router.get("/runs/{run_id}/report")
def run_report(run_id: str) -> dict:
    run = _runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No such run")
    if run.meta.get("status") != "succeeded":
        raise HTTPException(status_code=409, detail=f"Run is {run.meta.get('status')}")

    qlib_session.require_qlib()
    experiment_name = results.resolve_experiment(run_id, run.meta.get("experiment_name"))
    report = results.build_report(experiment_name)
    if report is None:
        raise HTTPException(status_code=404, detail="No results recorded for this run")
    report["run"] = dict(run.meta)
    return report


@router.get("/runs/{run_id}/predictions")
def run_predictions(run_id: str, limit: int = 50) -> dict:
    run = _runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No such run")
    qlib_session.require_qlib()
    experiment_name = results.resolve_experiment(run_id, run.meta.get("experiment_name"))
    sample = results.prediction_sample(experiment_name, limit=limit)
    if sample is None:
        raise HTTPException(status_code=404, detail="No predictions recorded")
    return sample
