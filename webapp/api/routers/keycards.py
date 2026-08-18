"""Keycard workflow CRUD, compilation, and run launching."""
from __future__ import annotations

from typing import Any

import yaml
from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import ValidationError

from .. import marketdata
from ..auth import Principal, get_principal
from ..config import get_settings
from ..keycards.compiler import compile_keycard, render_keycard_yaml
from ..keycards.models import Defect, Keycard, KeycardSpec
from ..keycards.registry import list_node_types
from ..keycards.repo import KeycardRepo, get_keycard_repo
from ..keycards.validator import validate_keycard

router = APIRouter()

_settings = get_settings()
# Reuse the module singleton from runs.py so live run state, concurrency
# semaphores and the runs directory stay consistent across routers.
from .runs import _runs


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _store_from_keycard(keycard: KeycardSpec | Keycard) -> str:
    """The qlib store key named by the keycard's data_store node."""
    for node in keycard.nodes:
        if node.type == "data_store":
            return node.config.get("store", "us")
    return "us"


def _store_context(keycard: KeycardSpec | Keycard) -> tuple[str, str]:
    """Resolve provider_uri/region for a keycard, with HTTP status mapping."""
    key = _store_from_keycard(keycard)
    try:
        return marketdata.resolve_store(key)
    except marketdata.StoreError as exc:
        status = 400 if marketdata.store_for(key) is None else 503
        raise HTTPException(status_code=status, detail=str(exc)) from exc


def _run_extra(keycard: Keycard) -> dict[str, Any]:
    """The strategy-knob snapshot saved with a keycard-derived run."""
    by_type = {n.type: n.config for n in keycard.nodes}
    return {
        "keycard_id": keycard.id,
        "model": by_type.get("model", {}).get("model", "lightgbm"),
        "handler": by_type.get("handler", {}).get("handler", "Alpha158"),
        "universe": by_type.get("universe", {}).get("universe", "top500"),
        "benchmark": by_type.get("universe", {}).get("benchmark", "SPY"),
        "data_store": _store_from_keycard(keycard),
    }


def _blocking(defects: list[Defect]) -> list[Defect]:
    return [d for d in defects if d.severity == "blocking"]


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------
@router.get("/keycards")
def list_keycards(
    is_template: bool | None = None,
    family: str | None = None,
    tag: str | None = None,
    repo: KeycardRepo = Depends(get_keycard_repo),
) -> dict:
    return {"keycards": [k.model_dump() for k in repo.list_filtered(is_template, family, tag)]}


@router.post("/keycards")
def create_keycard(spec: KeycardSpec, repo: KeycardRepo = Depends(get_keycard_repo)) -> dict:
    defects = validate_keycard(spec)
    if _blocking(defects):
        raise HTTPException(
            status_code=400,
            detail=" ".join(d.message for d in _blocking(defects)),
        )
    return repo.create(spec).model_dump()


# Static sub-routes must be registered before the ``/{keycard_id}`` path so
# that ``node-types`` is not captured as an id.
@router.get("/keycards/node-types")
def node_types() -> dict:
    return {"node_types": list_node_types()}


@router.post("/keycards/compile")
def compile_keycard_endpoint(spec: KeycardSpec) -> dict:
    """The exact YAML qrun would get, plus every defect (blocking or advisory)."""
    defects = validate_keycard(spec)
    yaml_text: str | None = None
    if not _blocking(defects):
        provider_uri, region = _store_context(spec)
        yaml_text = render_keycard_yaml(spec, provider_uri, region)
    return {
        "yaml": yaml_text,
        "defects": [d.as_dict() for d in defects],
        "warnings": [d.message for d in defects if d.severity == "advisory"],
    }


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------
_IMPORT_STRIPPED = {"id", "created_at", "updated_at", "user_id", "visibility"}


def _coerce_keycard(values: dict) -> tuple[KeycardSpec, list[dict]]:
    """Build a KeycardSpec out of whatever holds, and report what did not."""
    values = {k: v for k, v in values.items() if k not in _IMPORT_STRIPPED}
    values.setdefault("name", "Imported keycard")
    rejected: list[dict] = []

    for _ in range(len(values) + 1):
        try:
            return KeycardSpec(**values), rejected
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


@router.post("/keycards/import")
def import_keycard(payload: dict | str = Body(...)) -> dict:
    """Parse a keycard file or raw payload, and say what is wrong with it."""
    if isinstance(payload, str):
        try:
            parsed = yaml.safe_load(payload)
        except yaml.YAMLError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"This is not valid YAML or JSON: {exc}",
            ) from None
    else:
        parsed = payload

    if not isinstance(parsed, dict):
        raise HTTPException(
            status_code=400,
            detail=f"A keycard file is a mapping of fields; this is "
                   f"{type(parsed).__name__}.")

    known = set(KeycardSpec.model_fields)
    unknown = sorted(k for k in parsed if k not in known and k not in _IMPORT_STRIPPED)

    try:
        spec, rejected = _coerce_keycard(parsed)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False)) from None

    provider_uri, _ = _store_context(spec)
    defects = validate_keycard(spec)
    return {
        "spec": spec.model_dump(),
        "unknown_fields": unknown,
        "rejected": rejected,
        "defects": [d.as_dict() for d in defects],
    }


@router.get("/keycards/{keycard_id}")
def get_keycard(keycard_id: str, repo: KeycardRepo = Depends(get_keycard_repo)) -> dict:
    stored = repo.get(keycard_id)
    if stored is None:
        raise HTTPException(status_code=404, detail="No such keycard")
    return stored.model_dump()


@router.put("/keycards/{keycard_id}")
def update_keycard(
    keycard_id: str,
    spec: KeycardSpec,
    repo: KeycardRepo = Depends(get_keycard_repo),
) -> dict:
    defects = validate_keycard(spec)
    if _blocking(defects):
        raise HTTPException(
            status_code=400,
            detail=" ".join(d.message for d in _blocking(defects)),
        )
    stored = repo.update(keycard_id, spec)
    if stored is None:
        if repo.get(keycard_id) is not None:
            raise HTTPException(
                status_code=403,
                detail="This keycard belongs to someone else in your organisation.",
            )
        raise HTTPException(status_code=404, detail="No such keycard")
    return stored.model_dump()


@router.delete("/keycards/{keycard_id}", status_code=204)
def delete_keycard(keycard_id: str, repo: KeycardRepo = Depends(get_keycard_repo)) -> None:
    if not repo.delete(keycard_id):
        if repo.get(keycard_id) is not None:
            raise HTTPException(
                status_code=403,
                detail="This keycard belongs to someone else in your organisation.",
            )
        raise HTTPException(status_code=404, detail="No such keycard")


@router.post("/keycards/{keycard_id}/fork")
def fork_keycard(keycard_id: str, repo: KeycardRepo = Depends(get_keycard_repo)) -> dict:
    source = repo.get(keycard_id)
    if source is None:
        raise HTTPException(status_code=404, detail="No such keycard")
    fork_spec = KeycardSpec(**source.model_dump(exclude={"id", "created_at", "updated_at", "user_id", "visibility"}))
    fork_spec.name = f"{fork_spec.name} (copy)"
    return repo.create(fork_spec).model_dump()


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------
@router.post("/keycards/{keycard_id}/runs")
def start_keycard_run(
    keycard_id: str,
    principal: Principal = Depends(get_principal),
    repo: KeycardRepo = Depends(get_keycard_repo),
) -> dict:
    stored = repo.get(keycard_id)
    if stored is None:
        raise HTTPException(status_code=404, detail="No such keycard")

    provider_uri, region = _store_context(stored)
    defects = validate_keycard(stored)
    blocking_defects = _blocking(defects)
    if blocking_defects:
        raise HTTPException(
            status_code=400,
            detail=" ".join(d.message for d in blocking_defects),
        )

    config = compile_keycard(stored, provider_uri, region)
    run = _runs.start(
        principal,
        name=stored.name,
        config=config,
        kind="backtest",
        strategy_id=None,
        extra=_run_extra(stored),
    )
    # Mirror runs.py: return meta without the metrics snapshot.
    meta = dict(run.meta)
    meta.pop("metrics", None)
    excess = ((run.meta.get("metrics") or {}).get("risk") or {}).get("excess_return_with_cost")
    if excess:
        meta["summary"] = excess
    return meta
