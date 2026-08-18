"""Poll-loop workers that claim and execute scalability jobs.

Each worker thread loops on :func:`scalability_agent.agent.db.claim_job`;
when a claim lands it spawns a heartbeat thread for the lease, dispatches on
the job kind to the engine pipeline, and finalizes the job. The engine is
imported lazily inside the dispatch so this module -- and the reaper and
/health endpoints -- stay importable and testable without the engine half.

Failure policy: the pipeline raises, the worker catches, and the job is
requeued until its attempt budget (``AGENT_MAX_ATTEMPTS``) is spent, then
marked failed. The worker loop itself never dies on a job error -- a poison
job must not take the service down.
"""
from __future__ import annotations

import logging
import threading

from . import db, storage
from .config import get_settings

log = logging.getLogger(__name__)


def _dispatch(job: dict) -> str | None:
    """Run one claimed job. Returns the report id for analyze jobs, else None."""
    kind = job.get("kind")
    if kind == "parse_upload":
        from ..engine.pipeline import parse_upload

        parse_upload(job, db, storage)
        return None
    if kind == "analyze":
        from ..engine.pipeline import analyze

        return analyze(job, db, storage)
    raise ValueError(f"unknown job kind: {kind!r}")


def _heartbeat_loop(job_id: str, done: threading.Event, interval: float) -> None:
    """Refresh the job's lease until the worker signals it is finished."""
    while not done.wait(timeout=interval):
        try:
            db.heartbeat(job_id)
        except Exception:  # noqa: BLE001 - logged; the job's lease will expire
            log.exception("heartbeat failed for job %s", job_id)


class WorkerPool:
    """Owns the worker threads and their shared stop signal."""

    def __init__(self, workers: int | None = None, poll_seconds: float | None = None) -> None:
        settings = get_settings()
        self._n_workers = workers if workers is not None else settings.agent_workers
        self._poll_seconds = poll_seconds if poll_seconds is not None else settings.agent_poll_seconds
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        """Spawn the worker threads. Safe to call more than once."""
        if any(t.is_alive() for t in self._threads):
            return
        self._stop.clear()
        self._threads = [
            threading.Thread(
                target=self._loop,
                name=f"scalability-worker-{i + 1}",
                daemon=True,
            )
            for i in range(self._n_workers)
        ]
        for t in self._threads:
            t.start()
        log.info("scalability agent started with %d workers", self._n_workers)

    def stop(self) -> None:
        """Signal the loops to exit and wait briefly for idle workers."""
        self._stop.set()
        for t in self._threads:
            t.join(timeout=self._poll_seconds + 1)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                job = db.claim_job()
            except Exception:  # noqa: BLE001 - the worker must never die
                log.exception("claim failed; backing off")
                self._stop.wait(timeout=self._poll_seconds)
                continue
            if job is None:
                self._stop.wait(timeout=self._poll_seconds)
                continue
            self._run(job)

    def _run(self, job: dict) -> None:
        job_id = str(job["id"])
        log.info("claimed job %s (kind=%s, attempt=%d)", job_id, job.get("kind"), int(job.get("attempts") or 0) + 1)
        done = threading.Event()
        heartbeat = threading.Thread(
            target=_heartbeat_loop,
            args=(job_id, done, get_settings().agent_heartbeat_seconds),
            name=f"heartbeat-{job_id[:8]}",
            daemon=True,
        )
        heartbeat.start()
        try:
            report_id = _dispatch(job)
        except Exception as exc:  # noqa: BLE001 - any engine failure becomes a job failure
            log.exception("job %s failed", job_id)
            attempts = int(job.get("attempts") or 0)
            retry = attempts + 1 < get_settings().agent_max_attempts
            try:
                db.fail_job(job_id, f"{type(exc).__name__}: {exc}", retry)
            except Exception:  # noqa: BLE001 - logged; the lease will expire and the reaper requeues
                log.exception("could not record failure for job %s", job_id)
        else:
            try:
                db.complete_job(job_id, report_id)
                log.info("job %s succeeded%s", job_id, f" (report {report_id})" if report_id else "")
            except Exception:  # noqa: BLE001 - logged; the lease expiry path reconciles it
                log.exception("could not mark job %s succeeded", job_id)
        finally:
            done.set()
            heartbeat.join(timeout=2)
