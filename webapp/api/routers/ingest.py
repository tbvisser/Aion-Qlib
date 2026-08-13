"""Data-store status and the EODHD ingest, driven from the UI.

The ingest rewrites the qlib binary store on disk, which takes minutes. It runs
on a worker thread and reports progress through an in-memory job registry; the
UI either polls the job or subscribes to its SSE stream.

Two things this module is deliberately honest about:

* **One at a time.** Two ingests writing the same store would interleave CSVs
  and produce a silently corrupt binary dump, so a second start is refused.
* **A first ingest needs a restart.** ``qlib.init()`` mutates process-global
  state and cannot be re-pointed (see ``qlib_session``). If the API booted on
  the CN fallback, the newly built US store is not visible until the process
  restarts -- the job says so rather than leaving the UI showing 2020 prices.
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth import Principal, require_org_admin

from .. import qlib_session
from ..config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter()

# Marker file written into the store after a successful build. It is the only
# durable record of when the data was last refreshed -- the job registry is
# in-memory and dies with the process.
LAST_INGEST_FILE = ".last_ingest"

_JOBS: dict[str, dict] = {}
_jobs_lock = threading.Lock()
# Single worker: the guardrail against two concurrent writers is the running
# check below, and this makes the queue depth obvious rather than implicit.
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ingest")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class RefreshRequest(BaseModel):
    universe_size: int = Field(500, ge=1, le=5000)
    start: str = "2010-01-01"
    end: str | None = None
    max_workers: int = Field(8, ge=1, le=32)
    mode: str = Field("all", pattern="^(all|update)$")


def _target_dir() -> Path:
    """The store the ingest writes -- always the configured one, never the fallback."""
    return Path(get_settings().provider_uri).expanduser()


def _read_last_ingest() -> dict | None:
    path = _target_dir() / LAST_INGEST_FILE
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        logger.warning("unreadable %s: %s", path, exc)
        return None


def _write_last_ingest(summary: dict) -> None:
    target = _target_dir()
    try:
        target.mkdir(parents=True, exist_ok=True)
        (target / LAST_INGEST_FILE).write_text(
            json.dumps({"finished_at": _now(), **summary}, indent=2)
        )
    except OSError as exc:  # a store that built fine must not fail on the marker
        logger.warning("could not write %s: %s", LAST_INGEST_FILE, exc)


@router.get("/data/status")
def data_status() -> dict:
    settings = get_settings()
    state = qlib_session.status()
    mounted = state.get("provider_uri")

    with _jobs_lock:
        running = next(
            (dict(j) for j in _JOBS.values() if j["status"] == "running"), None
        )

    return {
        "has_eodhd_key": bool(settings.eodhd_api_key),
        # The store currently mounted by this process, which is what every
        # chart in the UI is actually reading.
        "provider_uri": mounted,
        "region": state.get("region"),
        "is_fallback": bool(mounted) and mounted == settings.fallback_provider_uri,
        # Where a refresh would write, which is not the same thing on a
        # fallback boot.
        "target_provider_uri": settings.provider_uri,
        "target_exists": (_target_dir() / "calendars").is_dir(),
        "last_ingest": _read_last_ingest(),
        "running_job": running,
    }


def _new_job_id() -> str:
    return uuid.uuid4().hex[:12]


def _enqueue_job(job_id: str, req: RefreshRequest) -> None:
    """Create the in-memory job record if no ingest is already running.

    Split out so the scheduled-task scheduler can reuse the same worker path
    without going through the HTTP router.
    """
    job = {
        "job_id": job_id,
        "status": "running",
        "started_at": _now(),
        "finished_at": None,
        "params": req.model_dump(),
        "progress": {"stage": "queued", "message": "Waiting for a worker", "done": 0, "total": 0},
        "summary": None,
        "error": None,
        "restart_required": False,
    }

    with _jobs_lock:
        if any(j["status"] == "running" for j in _JOBS.values()):
            raise RuntimeError("An ingest is already running. Two writers would corrupt the store.")
        _JOBS[job_id] = job


@router.post("/data/refresh")
def start_refresh(
    req: RefreshRequest,
    _admin: Principal = Depends(require_org_admin),
) -> dict:
    # Admin-gated: this rewrites the qlib binary store, which every member of
    # the organisation reads. It is shared infrastructure, not personal data.
    settings = get_settings()
    if not settings.eodhd_api_key:
        raise HTTPException(
            status_code=400,
            detail="EODHD_API_KEY is not set — add it to webapp/.env and restart the API.",
        )

    job_id = _new_job_id()
    try:
        _enqueue_job(job_id, req)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None

    _executor.submit(_run_job, job_id, req)
    return {"status": "started", "job_id": job_id}


def _run_job(job_id: str, req: RefreshRequest) -> None:
    """Worker-thread body. Never raises -- failures land in the job record."""
    from webapp.ingest.eodhd import EodhdError, IngestProgress, run_ingest

    settings = get_settings()

    def on_progress(p: IngestProgress) -> None:
        with _jobs_lock:
            _JOBS[job_id]["progress"] = p.as_dict()

    try:
        summary = run_ingest(
            api_key=settings.eodhd_api_key,
            qlib_dir=_target_dir(),
            csv_dir=Path(settings.us_csv_dir).expanduser(),
            repo_root=settings.repo_root,
            universe_size=req.universe_size,
            start=req.start,
            end=req.end,
            max_workers=req.max_workers,
            mode=req.mode,
            on_progress=on_progress,
        )
    except EodhdError as exc:
        _finish(job_id, error=str(exc))
        return
    except Exception as exc:  # noqa: BLE001 - a crashed thread must still report
        logger.exception("ingest job %s failed", job_id)
        _finish(job_id, error=f"{type(exc).__name__}: {exc}")
        return

    _write_last_ingest(summary)

    # If this process mounted the fallback (or nothing), the store it just
    # built is not the one it is serving, and qlib cannot be re-pointed.
    mounted = qlib_session.status().get("provider_uri")
    restart_required = mounted != settings.provider_uri
    _finish(job_id, summary=summary, restart_required=restart_required)


def _finish(
    job_id: str,
    *,
    summary: dict | None = None,
    error: str | None = None,
    restart_required: bool = False,
) -> None:
    with _jobs_lock:
        job = _JOBS[job_id]
        job["status"] = "error" if error else "done"
        job["finished_at"] = _now()
        job["summary"] = summary
        job["error"] = error
        job["restart_required"] = restart_required
        if error:
            job["progress"] = {**job["progress"], "stage": "error", "message": error}


def _get_job(job_id: str) -> dict:
    with _jobs_lock:
        job = _JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Unknown job '{job_id}'")
        return dict(job)


@router.get("/data/refresh/{job_id}")
def refresh_job(job_id: str) -> dict:
    return _get_job(job_id)


@router.get("/data/refresh/{job_id}/stream")
async def refresh_stream(job_id: str) -> StreamingResponse:
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
                # Keeps proxies from closing an idle connection mid-ingest.
                yield ": ping\n\n"
            if job["status"] != "running":
                return
            await asyncio.sleep(1.0)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
