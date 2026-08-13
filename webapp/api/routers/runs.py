"""Strategy CRUD, run launching, live progress, and results."""
from __future__ import annotations

import asyncio
import json

import yaml
from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError
from sse_starlette.sse import EventSourceResponse

from .. import marketdata, qlib_session, results, strategy_explain
from ..auth import Principal, get_principal
from ..config import get_settings
from ..repositories import StrategyRepo
from ..runner import RunBusy, RunManager
from ..strategies import (
    HANDLERS,
    StrategySpec,
    available_models,
    build_workflow_config,
    coverage_report,
    render_yaml,
)
from ..strategy_gen import compat
from ..strategy_gen.compat import check_spec, field_options
from ..strategy_gen.draft import DraftError, lower_draft
from ..strategy_gen import templates as strategy_templates

router = APIRouter()

_settings = get_settings()
# The RunManager stays a module singleton -- it owns live subprocess handles and
# the concurrency semaphores, which are process state rather than per-user data.
# Every method now takes the caller, and reads go through their own RLS context.
_runs = RunManager(_settings.runs_dir, _settings.repo_root)


def _repo(principal: Principal = Depends(get_principal)) -> StrategyRepo:
    return StrategyRepo(principal)


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
def list_strategies(repo: StrategyRepo = Depends(_repo)) -> dict:
    return {"strategies": [s.model_dump() for s in repo.list()]}


@router.post("/strategies")
def create_strategy(
    spec: StrategySpec, repo: StrategyRepo = Depends(_repo)
) -> dict:
    provider_uri, _ = _store_context(spec)
    problems = spec.validate_windows() + spec.validate_features(provider_uri)
    if problems:
        raise HTTPException(status_code=400, detail=" ".join(problems))
    return repo.create(spec).model_dump()


@router.get("/strategies/{strategy_id}")
def get_strategy(
    strategy_id: str, repo: StrategyRepo = Depends(_repo)
) -> dict:
    stored = repo.get(strategy_id)
    if stored is None:
        # Also the answer for a strategy owned by someone else: confirming the
        # id exists would leak that a colleague has one by that name.
        raise HTTPException(status_code=404, detail="No such strategy")
    return stored.model_dump()


@router.put("/strategies/{strategy_id}")
def update_strategy(
    strategy_id: str, spec: StrategySpec, repo: StrategyRepo = Depends(_repo)
) -> dict:
    provider_uri, _ = _store_context(spec)
    problems = spec.validate_windows() + spec.validate_features(provider_uri)
    if problems:
        raise HTTPException(status_code=400, detail=" ".join(problems))
    stored = repo.update(strategy_id, spec)
    if stored is None:
        if repo.get(strategy_id) is not None:
            # Visible but not writable: shared with the org by a colleague.
            raise HTTPException(
                status_code=403,
                detail="This strategy belongs to someone else in your organisation.",
            )
        raise HTTPException(status_code=404, detail="No such strategy")
    return stored.model_dump()


@router.put("/strategies/{strategy_id}/visibility")
def set_strategy_visibility(
    strategy_id: str,
    visibility: str = Body(..., embed=True),
    repo: StrategyRepo = Depends(_repo),
) -> dict:
    """Share a strategy with the organisation, or take it back.

    Separate from the PUT above because sharing is not editing -- the spec is
    untouched, and the two deserve different confirmation in the UI.
    """
    try:
        stored = repo.set_visibility(strategy_id, visibility)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if stored is None:
        if repo.get(strategy_id) is not None:
            raise HTTPException(
                status_code=403,
                detail="Only the owner can change who this strategy is shared with.",
            )
        raise HTTPException(status_code=404, detail="No such strategy")
    return stored.model_dump()


@router.delete("/strategies/{strategy_id}", status_code=204)
def delete_strategy(
    strategy_id: str, repo: StrategyRepo = Depends(_repo)
) -> None:
    if not repo.delete(strategy_id):
        if repo.get(strategy_id) is not None:
            raise HTTPException(
                status_code=403,
                detail="This strategy belongs to someone else in your organisation.",
            )
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

    # One pass for everything. `check_spec` runs the window, resolution, feature
    # and execution checks in that order, so dropping the resolution codes
    # rebuilds the legacy `warnings` list exactly -- window, feature, execution
    # -- without inspecting the features or censusing the store a second time.
    defects = check_spec(spec, provider_uri)

    return {
        "yaml": render_yaml(spec, provider_uri, region),
        # Untyped, flat, and severity-free: what the wire carried before there
        # was a `defects` field. Kept byte-identical because more than one
        # consumer still reads it; `test_preview_warnings_still_mean_what_they_meant`
        # is what stops it drifting.
        "warnings": [d.message for d in defects
                     if d.code not in compat.RESOLUTION_CODES],
        # The same news, typed: a code, the field it is about, and whether it
        # blocks. This is what lets the builder put a message on the stage that
        # owns the field instead of matching prefixes against its wording, and
        # it is the only one of the two that mentions an unknown benchmark.
        "defects": [d.as_dict() for d in defects],
        # What each field may be changed to, judged against the rest of the
        # spec, so a control can grey out a value it would be refused for.
        "options": field_options(spec),
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


class ImportRequest(BaseModel):
    """A strategy file, as text. YAML or JSON -- JSON is a subset of YAML."""

    #: Generous but finite. `StrategySpec` caps features at 32 columns of 2000
    #: characters, so anything past this is not a strategy.
    text: str = Field(..., min_length=1, max_length=262_144)


#: Written by `StrategyStore`, not chosen by anyone. An imported file keeps its
#: contents and loses its identity: it becomes an unsaved draft in the builder,
#: and letting a stale `id` through would make the next Save overwrite whatever
#: that id points at now.
_IMPORT_STRIPPED = ("id", "created_at", "updated_at")


def _coerce_spec(values: dict) -> tuple[StrategySpec, list[dict]]:
    """Build a spec out of whatever holds, and report what did not.

    An import loads or it doesn't, and refusing the whole file over one bad
    field is the behaviour that makes people edit YAML by hand instead. So a
    field pydantic rejects is dropped to its default and *named*; the rest
    survives. Nothing is silently corrected -- a dropped field comes back in
    `rejected` with the value that was refused and the reason.

    Bounded by the number of keys: each pass drops at least one, or re-raises.
    """
    values = {k: v for k, v in values.items() if k not in _IMPORT_STRIPPED}
    values.setdefault("name", "Imported strategy")
    rejected: list[dict] = []

    for _ in range(len(values) + 1):
        try:
            return StrategySpec(**values), rejected
        except ValidationError as exc:
            dropped = False
            for error in exc.errors():
                loc = error["loc"]
                key = loc[0] if loc else None
                if isinstance(key, str) and key in values:
                    rejected.append({
                        "path": ".".join(str(p) for p in loc),
                        "message": error["msg"],
                        "value": values.pop(key),
                    })
                    dropped = True
            if not dropped:
                raise

    raise AssertionError("unreachable: every pass drops a key or re-raises")


@router.post("/strategies/import")
def import_strategy(req: ImportRequest) -> dict:
    """Parse a strategy file into a spec, and say what is wrong with it.

    Parsed here rather than in the browser for two reasons: the UI ships no YAML
    parser, and `StrategySpec` is the authority on what a strategy *is* -- a
    second, looser reading of the format in TypeScript would accept files the
    engine then refuses.

    Nothing is saved and nothing is repaired. The caller gets the spec, the keys
    that were not part of a strategy, the fields that would not hold their
    value, and every defect -- which is what lets the builder open the file
    as-is and mark the conflicting fields rather than rewriting them.
    """
    try:
        parsed = yaml.safe_load(req.text)
    except yaml.YAMLError as exc:
        raise HTTPException(status_code=400,
                            detail=f"This is not valid YAML or JSON: {exc}") from None
    if not isinstance(parsed, dict):
        raise HTTPException(
            status_code=400,
            detail=f"A strategy file is a mapping of fields; this is "
                   f"{type(parsed).__name__}.")

    known = set(StrategySpec.model_fields)
    unknown = sorted(k for k in parsed if k not in known and k not in _IMPORT_STRIPPED)

    try:
        spec, rejected = _coerce_spec(parsed)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False)) from None

    # Leniently: a store that is not built is a thing to report on the field,
    # not a reason to refuse the file. `resolution_defects` says so itself.
    try:
        provider_uri, _ = marketdata.resolve_store(spec.data_store)
    except marketdata.StoreError:
        provider_uri = None

    defects = check_spec(spec, provider_uri)
    return {
        "spec": spec.model_dump(),
        "unknown_fields": unknown,
        "rejected": rejected,
        "defects": [d.as_dict() for d in defects],
        "options": field_options(spec),
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


def _without_snapshot(meta: dict) -> dict:
    """Run metadata as the wire carries it: everything except the metrics copy.

    The snapshot exists so a finished run stays readable when `examples/mlruns`
    is gone (see `runner._metrics_snapshot`), and the report route reads it off
    disk on the way past. Nothing that lists runs needs it, and shipping a risk
    table per row would put ~1.6KB x 100 on a payload the builder panel polls.

    What does travel is `summary`: the one `excess_return_with_cost` row out of
    that table, five numbers, so a card can print a run's headline figures
    without a `/report` round-trip each. It is the same slice `runMetrics.ts`
    already reads off a full report, under the same keys — a caller that knows
    one knows the other.
    """
    out = {k: v for k, v in meta.items() if k != "metrics"}
    excess = ((meta.get("metrics") or {}).get("risk") or {}).get("excess_return_with_cost")
    if excess:
        out["summary"] = excess
    return out


@router.post("/runs")
def start_run(req: StartRunRequest,
              principal: Principal = Depends(get_principal)) -> dict:
    provider_uri, region = _store_context(req.spec)

    # Every blocking check, not just the windows and the features.
    #
    # This used to run two of the four, and the two it skipped were the ones
    # that resolve a name against the store the run will actually open. Run
    # `e59f918b7ff5` is what that omission cost: `crypto_365` with benchmark
    # `SPY`, accepted here, trained for 4m51s, then died in qlib's `Account`
    # with "The benchmark ['SPY'] does not exist". The check existed the whole
    # time -- on the draft pipeline, which this endpoint did not call.
    #
    # Advisory defects are deliberately not a gate: they describe a run that
    # finishes and means nothing, which is a legitimate thing to ask for.
    problems = compat.blocking(compat.check_spec(req.spec, provider_uri))
    if problems:
        raise HTTPException(status_code=400,
                            detail=" ".join(p.message for p in problems))

    config = build_workflow_config(req.spec, provider_uri, region)
    run = _runs.start(
        principal,
        name=req.spec.name,
        config=config,
        kind="backtest",
        strategy_id=req.strategy_id,
        # What the run *was*, so a finished run can be compared against the
        # next attempt without re-reading a spec that has since been edited.
        # Widened over time: older runs lack the newer keys, and the UI renders
        # those as an em dash rather than as "unchanged".
        # `feature_mode` rides along with `handler` because on its own `handler`
        # misreports the run: under "replace" the handler's feature set is not
        # used at all, and a panel that reads `handler` alone will name Alpha158
        # for a run that never loaded it.
        extra={"model": req.spec.model, "handler": req.spec.handler,
               "feature_mode": req.spec.feature_mode,
               "feature_count": len(req.spec.features or []),
               "universe": req.spec.universe, "benchmark": req.spec.benchmark,
               "data_store": req.spec.data_store,
               "topk": req.spec.topk, "n_drop": req.spec.n_drop,
               "open_cost": req.spec.open_cost, "close_cost": req.spec.close_cost},
    )
    return _without_snapshot(run.meta)


@router.get("/runs")
def list_runs(limit: int = 100,
              principal: Principal = Depends(get_principal)) -> dict:
    return {"runs": [_without_snapshot(m) for m in _runs.list(principal, limit=limit)]}


@router.get("/runs/{run_id}")
def get_run(run_id: str, principal: Principal = Depends(get_principal)) -> dict:
    run = _runs.get(principal, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No such run")
    return _without_snapshot(run.meta)


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str,
               principal: Principal = Depends(get_principal)) -> dict:
    if not _runs.cancel(principal, run_id):
        raise HTTPException(status_code=409, detail="Run is not cancellable")
    return {"ok": True}


@router.delete("/runs/{run_id}", status_code=204)
def delete_run(run_id: str,
               principal: Principal = Depends(get_principal)) -> None:
    """Remove a finished run. Its MLflow artifacts stay on disk -- see RunManager.delete."""
    try:
        deleted = _runs.delete(principal, run_id)
    except RunBusy:
        raise HTTPException(status_code=409, detail="Cancel the run before deleting it") from None
    if not deleted:
        raise HTTPException(status_code=404, detail="No such run")


@router.get("/runs/{run_id}/log")
def run_log(run_id: str, offset: int = 0, limit: int = 400,
            principal: Principal = Depends(get_principal)) -> dict:
    run = _runs.get(principal, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No such run")
    lines, next_offset = _runs.tail(run, offset=offset, limit=limit)
    return {"lines": lines, "next_offset": next_offset, "status": run.meta.get("status")}


@router.get("/runs/{run_id}/events")
async def run_events(run_id: str, offset: int = 0,
                     principal: Principal = Depends(get_principal)):
    """SSE: status/phase changes and new log lines until the run ends.

    `offset` is how many log lines the client already holds. EventSource
    reconnects on its own after any network hiccup, and a stream that always
    restarted at line 0 re-sent the whole log into a client that appends --
    so a proxy timeout showed up as a duplicated backtest log.
    """
    run = _runs.get(principal, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No such run")

    async def stream():
        offset_ = max(0, offset)
        last_state: tuple | None = None
        while True:
            # Re-read under the caller's own context on every tick, so a run
            # that stops being visible mid-stream -- unshared, or deleted --
            # ends the stream rather than continuing to leak its log.
            current = _runs.get(principal, run_id)
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
def run_report(run_id: str,
               principal: Principal = Depends(get_principal)) -> dict:
    run = _runs.get(principal, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No such run")
    if run.meta.get("status") != "succeeded":
        raise HTTPException(status_code=409, detail=f"Run is {run.meta.get('status')}")

    qlib_session.require_qlib()
    experiment_name = results.resolve_experiment(run_id, run.meta.get("experiment_name"))
    report = results.build_report(experiment_name)

    # MLflow first, the run's own snapshot second. Live is authoritative because
    # it carries the curves and reflects anything re-logged since; the snapshot
    # exists so that clearing `examples/mlruns` costs a chart rather than every
    # number a finished run ever reported. See `runner._metrics_snapshot`.
    if report is None:
        snapshot = run.meta.get("metrics")
        if not snapshot:
            raise HTTPException(status_code=404, detail="No results recorded for this run")
        report = {
            "recorder_id": None,
            "experiment_name": experiment_name,
            "metrics": snapshot.get("metrics") or {},
            "curves": {},
            "risk": snapshot.get("risk") or {},
            "sanity": snapshot.get("sanity") or {},
            "indicators": snapshot.get("indicators") or {},
            "from_snapshot": True,
        }
        if snapshot.get("period"):
            report["period"] = snapshot["period"]

    report["run"] = _without_snapshot(run.meta)
    return report


@router.get("/runs/{run_id}/predictions")
def run_predictions(run_id: str, limit: int = 50,
                    principal: Principal = Depends(get_principal)) -> dict:
    run = _runs.get(principal, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="No such run")
    qlib_session.require_qlib()
    experiment_name = results.resolve_experiment(run_id, run.meta.get("experiment_name"))
    sample = results.prediction_sample(experiment_name, limit=limit)
    if sample is None:
        raise HTTPException(status_code=404, detail="No predictions recorded")
    return sample
