"""Postgres access for the scalability agent's queue, uploads, and reports.

The agent connects as ``service_role`` and bypasses RLS deliberately -- it is
the only writer of job and report state, and it outlives any user's access
token. Ownership is preserved because jobs carry their ``user_id``/``org_id``
from the platform's enqueue path; the agent never invents either.

The queue discipline mirrors the platform scheduler: jobs are claimed with
``FOR UPDATE SKIP LOCKED`` so multiple agent replicas can poll the same table
safely, and every running job holds a lease that a heartbeat keeps fresh. A
job whose lease expires without a heartbeat is assumed to belong to a dead
worker and is requeued by :func:`reap_expired_leases`.

The module-level functions are the fixed contract the engine's pipeline
(``scalability_agent.engine.pipeline``) is written against -- it receives
this module as its ``db`` argument.
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from functools import lru_cache
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .config import get_settings

log = logging.getLogger(__name__)


class DatabaseNotConfigured(RuntimeError):
    """Raised when DATABASE_URL is absent.

    Worth its own type: it is a deployment mistake, not a job error, and
    /health should be able to name the setting rather than report a bare 500.
    """


@lru_cache
def get_pool() -> ConnectionPool:
    settings = get_settings()
    if not settings.database_url:
        raise DatabaseNotConfigured(
            "DATABASE_URL is not set. The agent reads its work queue from and "
            "writes reports to Postgres; without it there is nothing to do."
        )
    # Sized for the workers plus their heartbeat threads and the reaper --
    # each worker can hold one connection for the job and one for a heartbeat.
    pool = ConnectionPool(
        settings.database_url,
        min_size=1,
        max_size=settings.agent_workers * 2 + 2,
        kwargs={"row_factory": dict_row, "autocommit": False},
        open=False,
        name="scalability-agent",
    )
    pool.open()
    return pool


@contextmanager
def service_tx() -> Iterator[psycopg.Cursor]:
    """Run a transaction as ``service_role``, bypassing RLS.

    ``SET LOCAL`` scopes the role change to this transaction, so a pooled
    connection can never be handed to the next caller still wearing it.
    """
    pool = get_pool()
    with pool.connection() as conn:
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute("SET LOCAL ROLE service_role")
                yield cur


# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------

def claim_job() -> dict | None:
    """Atomically claim the oldest queued job, or return None if the queue is empty.

    The subselect's ``FOR UPDATE SKIP LOCKED`` is what makes concurrent workers
    (threads here, replicas in compose) safe: each claimant locks a different
    row, and the UPDATE flips it to ``running`` with a fresh lease in the same
    transaction.
    """
    settings = get_settings()
    with service_tx() as cur:
        cur.execute(
            """
            UPDATE aion.scalability_jobs
            SET status = 'running',
                lease_expires_at = now() + make_interval(secs => %s),
                heartbeat_at = now(),
                updated_at = now()
            WHERE id = (
                SELECT id
                FROM aion.scalability_jobs
                WHERE status = 'queued'
                ORDER BY created_at
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING *
            """,
            (settings.agent_lease_seconds,),
        )
        return cur.fetchone()


def heartbeat(job_id: str) -> None:
    """Prove the worker running ``job_id`` is alive by refreshing heartbeat_at."""
    with service_tx() as cur:
        cur.execute(
            """
            UPDATE aion.scalability_jobs
            SET heartbeat_at = now()
            WHERE id = %s AND status = 'running'
            """,
            (job_id,),
        )


def complete_job(job_id: str, report_id: str | None = None) -> None:
    """Mark a job succeeded, recording the report it produced (analyze jobs only)."""
    with service_tx() as cur:
        cur.execute(
            """
            UPDATE aion.scalability_jobs
            SET status = 'succeeded',
                report_id = %s,
                lease_expires_at = NULL,
                error = NULL,
                updated_at = now()
            WHERE id = %s
            """,
            (report_id, job_id),
        )


def fail_job(job_id: str, error: str, retry: bool) -> None:
    """Record a job failure.

    ``retry`` requeues the job (the worker decides from the attempt budget);
    without it the job is permanently ``failed``. Either way the attempt is
    consumed and the lease released so the reaper ignores the row.
    """
    with service_tx() as cur:
        cur.execute(
            """
            UPDATE aion.scalability_jobs
            SET status = CASE WHEN %s THEN 'queued' ELSE 'failed' END,
                attempts = attempts + 1,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                error = %s,
                updated_at = now()
            WHERE id = %s
            """,
            (retry, error, job_id),
        )


def reap_expired_leases() -> int:
    """Requeue running jobs whose lease expired without a heartbeat.

    This is the agent-side equivalent of the platform's orphan reconciliation:
    a worker that crashed mid-job leaves a ``running`` row behind, and this is
    what returns it to the queue. A job that exhausts its attempt budget this
    way is failed permanently -- a crash loop should not retry forever.

    Returns the number of jobs requeued or failed.
    """
    settings = get_settings()
    with service_tx() as cur:
        cur.execute(
            """
            UPDATE aion.scalability_jobs
            SET status = CASE WHEN attempts + 1 >= %s THEN 'failed' ELSE 'queued' END,
                attempts = attempts + 1,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                error = CASE
                    WHEN attempts + 1 >= %s
                    THEN 'lease expired without heartbeat; attempt budget exhausted'
                    ELSE 'lease expired without heartbeat; requeued'
                END,
                updated_at = now()
            WHERE status = 'running' AND lease_expires_at < now()
            RETURNING id
            """,
            (settings.agent_max_attempts, settings.agent_max_attempts),
        )
        return len(cur.fetchall())


# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------

def get_upload(upload_id: str) -> dict:
    """Fetch one upload row; raises LookupError if it does not exist."""
    with service_tx() as cur:
        cur.execute(
            "SELECT * FROM aion.scalability_uploads WHERE id = %s",
            (upload_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise LookupError(f"upload {upload_id} not found")
    return row


def set_upload_parsed(upload_id: str, summary: dict) -> None:
    """Mark an upload parsed and store the derived trade summary the UI previews."""
    with service_tx() as cur:
        cur.execute(
            """
            UPDATE aion.scalability_uploads
            SET status = 'parsed', summary = %s, error = NULL, updated_at = now()
            WHERE id = %s
            """,
            (Jsonb(summary), upload_id),
        )


def set_upload_failed(upload_id: str, error: str) -> None:
    """Mark an upload failed so the UI can surface the parse error to the fund."""
    with service_tx() as cur:
        cur.execute(
            """
            UPDATE aion.scalability_uploads
            SET status = 'failed', error = %s, updated_at = now()
            WHERE id = %s
            """,
            (error, upload_id),
        )


def latest_parsed_upload(user_id: str) -> dict | None:
    """The user's most recent successfully parsed upload -- the default analyze input."""
    with service_tx() as cur:
        cur.execute(
            """
            SELECT * FROM aion.scalability_uploads
            WHERE user_id = %s AND status = 'parsed'
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (user_id,),
        )
        return cur.fetchone()


# ---------------------------------------------------------------------------
# Reports and venue catalog
# ---------------------------------------------------------------------------

def insert_report(
    user_id: str,
    org_id: str,
    job_id: str,
    upload_id: str,
    catalog_version: int,
    current_venue: str,
    result: dict,
    artifact_path: str,
) -> str:
    """Insert a finished report row and return its id.

    ``catalog_version`` is stored alongside the result so reports are
    reproducible: same inputs plus same catalog version must give same output.
    """
    with service_tx() as cur:
        cur.execute(
            """
            INSERT INTO aion.scalability_reports
                (user_id, org_id, job_id, upload_id, catalog_version,
                 current_venue, result, artifact_path)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                user_id, org_id, job_id, upload_id, catalog_version,
                current_venue, Jsonb(result), artifact_path,
            ),
        )
        row = cur.fetchone()
    return str(row["id"])


def get_venue_profiles(version: int | None = None) -> list[dict]:
    """Venue profiles for one catalog version -- the latest when ``version`` is None.

    Rows carry the full row (id, version, venue, profile jsonb); the profile
    dict holds display_name, min_aum, fee_bps_per_side, spread_bps,
    min_ticket_usd, liquidity_multiplier and booking_link.
    """
    with service_tx() as cur:
        if version is None:
            cur.execute(
                """
                SELECT * FROM aion.venue_catalog
                WHERE version = (SELECT max(version) FROM aion.venue_catalog)
                ORDER BY venue
                """
            )
        else:
            cur.execute(
                "SELECT * FROM aion.venue_catalog WHERE version = %s ORDER BY venue",
                (version,),
            )
        return cur.fetchall()


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

def health() -> dict[str, Any]:
    """Report database reachability for /health. Never raises."""
    if not get_settings().database_url:
        return {"ok": False, "detail": "DATABASE_URL is not set"}
    try:
        with service_tx() as cur:
            cur.execute("SELECT 1 AS ok")
            cur.fetchone()
        return {"ok": True, "detail": None}
    except Exception as exc:  # noqa: BLE001 - reported, not handled
        log.warning("database health check failed: %s", exc)
        return {"ok": False, "detail": str(exc)}


def close_pool() -> None:
    """Release pooled connections on shutdown; a no-op if the pool never opened."""
    if get_pool.cache_info().currsize:
        get_pool().close()
        get_pool.cache_clear()
