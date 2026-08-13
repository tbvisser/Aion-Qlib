"""The catalog: one search surface over every collection the Database page browses.

Alphas, indicators, operators, strategies, templates and (as later harvesters
land) backtests, portfolios, instruments, universes and macro series. The index
behind it is derived -- see ``webapp/api/catalog/`` -- so every route here is a
read except ``/reindex``, which rebuilds it, and ``/links``, which holds the one
kind of row that exists nowhere else.

Two things this module is deliberately honest about:

* **A cold index is empty, not an error.** The first request after a fresh
  clone finds no rows and no ``harvest_run``. ``/summary`` says so with
  ``indexed: false`` rather than 500-ing, because "press reindex" is the answer
  and a stack trace is not.
* **A degraded source keeps its rows.** ``/summary.degraded`` names the
  harvesters whose last run failed. Their collections are showing the previous
  harvest's contents, which is better than empty and worse than fresh, and the
  UI has to be able to say which.

Connections are per-request rather than a module singleton: the reindex worker
runs on its own thread, and sqlite connections are not shareable across threads.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import sqlite3
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from ..auth import Principal, require_org_admin
from ..catalog import KIND_LABELS, SOURCES
# INDEXED_KINDS, not KINDS: the roster's kinds share the uid grammar and the
# shape guard but are federated live, never indexed. Validating against the
# wider set would let `?kind=swarm` through and answer it with an honest-looking
# zero -- which reads as "there are no swarms", not "wrong endpoint".
from ..catalog.schema import INDEXED_KINDS
from ..catalog import db as catalog_db
from ..catalog import harvest
from ..config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter()

#: `<kind>:<source>:<local_id>`. Bounded because it comes off the URL and is
#: used as a lookup key and a link endpoint.
_UID = re.compile(r"^[a-z_]{1,16}:[a-z]{1,16}:[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,127}$")

#: What a user may attach by hand. Everything in `DERIVED_RELS` is recomputed by
#: the harvest and would be wiped, so those are refused here rather than
#: accepted and silently lost on the next reindex.
USER_RELS: tuple[str, ...] = (
    "documented_by",   # this factor comes from that paper
    "supersedes",
    "related_to",
)

_JOBS: dict[str, dict] = {}
_jobs_lock = threading.Lock()
# Single worker for the same reason the ingest has one: two harvests writing the
# same tables would interleave their swaps.
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="catalog")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _conn() -> sqlite3.Connection:
    return harvest.open_and_init(get_settings().catalog_db_path)


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


@router.get("/catalog/summary")
def catalog_summary() -> dict:
    """What is indexed, how fresh each source is, and what is degraded."""
    conn = _conn()
    try:
        data = catalog_db.summary(conn)
    finally:
        conn.close()

    with _jobs_lock:
        running = next((dict(j) for j in _JOBS.values() if j["status"] == "running"), None)

    known = {h["harvester"] for h in data["harvests"]}
    from ..catalog.harvesters import HARVESTERS

    return {
        **data,
        # False on a fresh clone. The UI shows "press reindex", not an error.
        "indexed": data["total"] > 0,
        "kinds": [{"kind": k, "label": KIND_LABELS[k]} for k in INDEXED_KINDS],
        "sources": list(SOURCES),
        "harvesters": [
            {
                "name": h.name,
                "label": h.label,
                "kind": h.kind,
                "source": h.source,
                "remote": h.remote,
                "ever_run": h.name in known,
            }
            for h in HARVESTERS
        ],
        "running_job": running,
    }


@router.get("/catalog/search")
def catalog_search(
    q: str | None = Query(None, max_length=200),
    kind: str | None = Query(None, max_length=32),
    source: str | None = Query(None, max_length=32),
    family: str | None = Query(None, max_length=64),
    tag: str | None = Query(None, max_length=64),
    sort: str = Query("relevance", max_length=32),
    limit: int = Query(50, ge=1, le=catalog_db.MAX_LIMIT),
    offset: int = Query(0, ge=0),
) -> dict:
    """One page of the catalog. Every filter is optional and they compose."""
    if kind is not None and kind not in INDEXED_KINDS:
        raise HTTPException(400, f"unknown kind {kind!r}; expected one of {', '.join(INDEXED_KINDS)}")
    if source is not None and source not in SOURCES:
        raise HTTPException(400, f"unknown source {source!r}; expected one of {', '.join(SOURCES)}")
    if sort not in catalog_db.SORTS:
        raise HTTPException(
            400, f"unknown sort {sort!r}; expected one of {', '.join(catalog_db.SORTS)}")

    conn = _conn()
    try:
        return catalog_db.search(
            conn, q=q, kind=kind, source=source, family=family, tag=tag,
            sort=sort, limit=limit, offset=offset,
        )
    except sqlite3.OperationalError as exc:
        # `_match_query` quotes every token, so this should be unreachable --
        # but an FTS syntax error reaching the user as a 500 would be the one
        # failure that makes the search box feel broken rather than empty.
        logger.warning("catalog search failed for q=%r: %s", q, exc)
        raise HTTPException(400, f"could not parse that search: {exc}")
    finally:
        conn.close()


@router.get("/catalog/facets")
def catalog_facets(kind: str | None = Query(None, max_length=32)) -> dict:
    """Value counts for the filter rail, scoped to one collection."""
    if kind is not None and kind not in INDEXED_KINDS:
        raise HTTPException(400, f"unknown kind {kind!r}; expected one of {', '.join(INDEXED_KINDS)}")
    conn = _conn()
    try:
        return catalog_db.facets(conn, kind)
    finally:
        conn.close()


@router.get("/catalog/entity/{uid:path}")
def catalog_entity(uid: str) -> dict:
    """One entity, with everything linked to it resolved in both directions."""
    if not _UID.fullmatch(uid or ""):
        raise HTTPException(400, "invalid uid")
    conn = _conn()
    try:
        entity = catalog_db.get(conn, uid)
    finally:
        conn.close()
    if entity is None:
        raise HTTPException(404, f"No catalog entry '{uid}'")
    return entity


# ---------------------------------------------------------------------------
# Links
# ---------------------------------------------------------------------------


class LinkRequest(BaseModel):
    src_uid: str = Field(..., max_length=200)
    dst_uid: str = Field(..., max_length=200)
    rel: str = Field(..., max_length=32)
    note: str | None = Field(None, max_length=500)

    @field_validator("src_uid", "dst_uid")
    @classmethod
    def _valid_uid(cls, v: str) -> str:
        if not _UID.fullmatch(v):
            raise ValueError(f"invalid uid {v!r}")
        return v

    @field_validator("rel")
    @classmethod
    def _user_rel(cls, v: str) -> str:
        if v not in USER_RELS:
            raise ValueError(
                f"rel {v!r} is not one a user may set. The harvest recomputes every other "
                f"rel from scratch, so this link would be wiped on the next reindex. "
                f"Expected one of {', '.join(USER_RELS)}")
        return v


@router.post("/catalog/links")
def create_link(req: LinkRequest) -> dict:
    """Attach one entity to another by hand -- a paper to the factor it produced.

    ``dst_uid`` is not required to exist in the index. A document lives in
    Supabase and is never harvested here, so demanding a resolvable target would
    make the one link this endpoint exists for impossible.
    """
    conn = _conn()
    try:
        if catalog_db.get(conn, req.src_uid) is None:
            raise HTTPException(404, f"No catalog entry '{req.src_uid}'")
        catalog_db.add_link(conn, req.src_uid, req.dst_uid, req.rel, req.note)
    finally:
        conn.close()
    return {"status": "ok", **req.model_dump()}


@router.delete("/catalog/links")
def delete_link(
    src_uid: str = Query(..., max_length=200),
    dst_uid: str = Query(..., max_length=200),
    rel: str = Query(..., max_length=32),
) -> dict:
    for value in (src_uid, dst_uid):
        if not _UID.fullmatch(value):
            raise HTTPException(400, f"invalid uid {value!r}")
    conn = _conn()
    try:
        removed = catalog_db.remove_link(conn, src_uid, dst_uid, rel)
    finally:
        conn.close()
    if not removed:
        raise HTTPException(404, "No such link")
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Reindex
# ---------------------------------------------------------------------------


class ReindexRequest(BaseModel):
    #: Harvesters to run. Empty means all of them; everything not named keeps
    #: the rows it already has, which is the same mechanism a failure uses.
    only: list[str] = Field(default_factory=list, max_length=32)
    #: False skips the sources that cross the network, for a fast local rebuild.
    include_remote: bool = True

    @field_validator("only")
    @classmethod
    def _known(cls, v: list[str]) -> list[str]:
        from ..catalog.harvesters import BY_NAME

        unknown = [n for n in v if n not in BY_NAME]
        if unknown:
            raise ValueError(
                f"unknown harvester(s) {', '.join(unknown)}; "
                f"expected from {', '.join(sorted(BY_NAME))}")
        return v


@router.post("/catalog/reindex")
def start_reindex(
    req: ReindexRequest | None = None,
    _admin: Principal = Depends(require_org_admin),
) -> dict:
    # Admin-gated: rebuilds the shared catalog.db search index.
    request = req or ReindexRequest()
    job_id = uuid.uuid4().hex[:12]
    job = {
        "job_id": job_id,
        "status": "running",
        "started_at": _now(),
        "finished_at": None,
        "params": request.model_dump(),
        "progress": {"harvester": None, "state": "queued", "done": 0, "total": 0},
        "report": None,
        "error": None,
    }

    with _jobs_lock:
        if any(j["status"] == "running" for j in _JOBS.values()):
            raise HTTPException(
                409,
                "A reindex is already running. Two harvests writing the same tables "
                "would interleave their swaps.",
            )
        _JOBS[job_id] = job

    _executor.submit(_run_reindex, job_id, request)
    return {"status": "started", "job_id": job_id}


def _run_reindex(job_id: str, req: ReindexRequest) -> None:
    """Worker-thread body. Never raises -- failures land in the job record."""
    from ..catalog.harvesters import HARVESTERS

    total = len([
        h for h in HARVESTERS
        if (not req.only or h.name in set(req.only))
        and (req.include_remote or not h.remote)
    ])
    done = 0

    def on_progress(name: str, state: str) -> None:
        nonlocal done
        with _jobs_lock:
            _JOBS[job_id]["progress"] = {
                "harvester": name, "state": state, "done": done, "total": total,
            }
        done += 1

    conn = None
    try:
        conn = harvest.open_and_init(get_settings().catalog_db_path)
        report = harvest.run(
            conn,
            get_settings(),
            only=req.only or None,
            include_remote=req.include_remote,
            on_progress=on_progress,
        )
    except Exception as exc:  # noqa: BLE001 - a crashed thread must still report
        logger.exception("catalog reindex %s failed", job_id)
        _finish(job_id, error=f"{type(exc).__name__}: {exc}")
        return
    finally:
        if conn is not None:
            conn.close()

    _finish(job_id, report=report)


def _finish(job_id: str, *, report: dict | None = None, error: str | None = None) -> None:
    with _jobs_lock:
        job = _JOBS[job_id]
        job["status"] = "error" if error else "done"
        job["finished_at"] = _now()
        job["report"] = report
        job["error"] = error
        job["progress"] = {
            **job["progress"],
            "state": "error" if error else "done",
            "done": job["progress"]["total"],
        }


def _get_job(job_id: str) -> dict:
    with _jobs_lock:
        job = _JOBS.get(job_id)
        if job is None:
            raise HTTPException(404, f"Unknown job '{job_id}'")
        return dict(job)


@router.get("/catalog/reindex/{job_id}")
def reindex_job(job_id: str) -> dict:
    return _get_job(job_id)


@router.get("/catalog/reindex/{job_id}/stream")
async def reindex_stream(job_id: str) -> StreamingResponse:
    _get_job(job_id)  # 404 before opening the stream, not inside it

    async def events() -> AsyncIterator[str]:
        last: str | None = None
        while True:
            job = _get_job(job_id)
            payload = json.dumps(job)
            if payload != last:
                last = payload
                yield f"data: {payload}\n\n"
            else:
                yield ": ping\n\n"
            if job["status"] != "running":
                return
            await asyncio.sleep(0.5)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
