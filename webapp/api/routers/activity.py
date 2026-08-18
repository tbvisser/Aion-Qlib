"""One feed over everything long-running.

Three job surfaces exist — backtest runs (rows in ``aion.runs``, scoped to the
caller), data-ingest jobs and macro-refresh jobs (each an in-memory ``_JOBS``
dict with get-by-id endpoints only). Nothing aggregated them, so the Agenda
would have needed three pollers speaking two status vocabularies. This router
normalises all three into one list.

The two job dicts are organisation-wide by nature — they rebuild shared stores —
while runs are personal. The feed mixes both deliberately: "someone is
refreshing the data store" is news to everyone, and only an admin could have
started it.

The sibling routers' registries are read as module attributes at call time,
under their own locks, exactly the way the router tests already do — never
cached at import, so tests (and reloads) that swap ``_JOBS`` or ``_runs`` are
seen. Nothing imports this module back: no cycle.

Job dicts are copied under the lock and never mutated — two writers to a job
record would be the corruption the locks exist to prevent.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query

from ..auth import Principal, get_principal
from . import ingest as ingest_router
from . import macro as macro_router
from . import runs as runs_router

router = APIRouter()

#: macro/ingest job status -> the runs vocabulary the UI already renders.
_JOB_STATUS = {"running": "running", "done": "succeeded", "error": "failed"}


def _progress(job: dict) -> dict | None:
    p = job.get("progress") or {}
    if not p:
        return None
    return {"stage": p.get("stage"), "message": p.get("message"),
            "done": p.get("done"), "total": p.get("total")}


def _from_job(job: dict, kind: str, title: str) -> dict:
    return {
        "id": f"{'ingest' if kind == 'ingest' else 'macro'}:{job['job_id']}",
        "source_id": job["job_id"],
        "kind": kind,
        "title": title,
        "status": _JOB_STATUS.get(job.get("status"), job.get("status")),
        # Jobs have no created_at; started_at is stamped at enqueue, so it is
        # the same instant and serves as the sort key.
        "created_at": None,
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "phase": (job.get("progress") or {}).get("stage"),
        "progress": _progress(job),
        "error": job.get("error"),
        "error_hint": None,
        "restart_required": job.get("restart_required"),
    }


def _ingest_title(job: dict) -> str:
    params = job.get("params") or {}
    size = params.get("universe_size")
    mode = params.get("mode")
    bits = [f"{size} symbols" if size else None, f"({mode})" if mode else None]
    detail = " ".join(b for b in bits if b)
    return f"Data refresh · {detail}" if detail else "Data refresh"


def _macro_title(job: dict) -> str:
    what = (job.get("params") or {}).get("what") or "all"
    return f"Macro refresh · {what}"


def _from_run(meta: dict) -> dict:
    return {
        "id": f"run:{meta['id']}",
        "source_id": meta["id"],
        "kind": "run",
        "title": meta.get("name") or meta["id"],
        "status": meta.get("status"),
        "created_at": meta.get("created_at"),
        "started_at": meta.get("started_at"),
        "finished_at": meta.get("finished_at"),
        "phase": meta.get("phase"),
        "progress": None,
        "error": meta.get("error"),
        "error_hint": meta.get("error_hint"),
        "restart_required": None,
    }


@router.get("/activity")
def activity(limit: int = Query(50, ge=1, le=200),
             principal: Principal = Depends(get_principal)) -> dict:
    items: list[dict] = []

    with ingest_router._jobs_lock:
        ingest_jobs = [dict(j) for j in ingest_router._JOBS.values()]
    with macro_router._jobs_lock:
        macro_jobs = [dict(j) for j in macro_router._JOBS.values()]

    items.extend(_from_job(j, "ingest", _ingest_title(j)) for j in ingest_jobs)
    items.extend(_from_job(j, "macro_refresh", _macro_title(j)) for j in macro_jobs)
    # Runs are per-user; the ingest and macro jobs above are not. That is the
    # right asymmetry: those two rebuild stores the whole organisation reads, so
    # everyone should see one is in flight, while a colleague's backtest is
    # their business. RLS decides which runs come back.
    items.extend(_from_run(m) for m in runs_router._runs.list(principal, limit))

    items.sort(key=lambda i: ((i["created_at"] or i["started_at"] or ""), i["id"]),
               reverse=True)
    return {
        "items": items[:limit],
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
