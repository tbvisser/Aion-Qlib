"""Postgres access for the per-user records in the ``aion`` schema.

Two context managers, and the difference between them is the security model.

``user_tx`` is what every request path uses. It drops the connection from
``authenticator`` to ``authenticated`` and publishes the caller's user id as a
JWT claim, so ``auth.uid()`` resolves inside the database and the row level
security policies in the ``aion`` schema decide what the query can see. A
``WHERE user_id = ...`` clause someone forgets to write is therefore not a data
leak -- the rows were never visible to that transaction in the first place.

``service_tx`` bypasses RLS and exists for exactly one caller: the background
thread that runs a backtest. That thread outlives the HTTP request that started
it, so the user's access token may well have expired before it needs to record
the run's outcome. It scopes by run id instead, and must never be used to serve
a request.

Both set the role with ``SET LOCAL`` inside an explicit transaction, so the
role reverts on commit or rollback and a pooled connection can never be handed
to the next caller still wearing the previous one's identity.
"""
from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from functools import lru_cache
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import get_settings

log = logging.getLogger(__name__)


class DatabaseNotConfigured(RuntimeError):
    """Raised when DATABASE_URL is absent.

    Worth its own type: it is a deployment mistake, not a request error, and the
    API turns it into a 503 with a message that names the setting rather than a
    generic 500.
    """


@lru_cache
def get_pool() -> ConnectionPool:
    settings = get_settings()
    if not settings.database_url:
        raise DatabaseNotConfigured(
            "DATABASE_URL is not set. The API stores strategies, portfolios, "
            "projects and runs in Postgres; without it there is nowhere to read "
            "them from. See webapp/.env.example."
        )
    # open=False so importing this module never blocks on a database that is not
    # up yet -- the API must still be able to serve /api/health and say so.
    pool = ConnectionPool(
        settings.database_url,
        min_size=settings.db_pool_min,
        max_size=settings.db_pool_max,
        kwargs={"row_factory": dict_row, "autocommit": False},
        open=False,
        name="aion",
    )
    pool.open()
    return pool


@contextmanager
def user_tx(user_id: str) -> Iterator[psycopg.Cursor]:
    """Run a transaction as ``user_id``, with RLS enforced.

    ``auth.uid()`` reads ``request.jwt.claims``, so publishing the subject there
    is what connects a FastAPI request to a database policy.
    """
    claims = json.dumps({"sub": str(user_id), "role": "authenticated"})
    pool = get_pool()
    with pool.connection() as conn:
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute("SET LOCAL ROLE authenticated")
                # Parameterised, not interpolated: SET LOCAL takes a value here,
                # and set_config is the form that accepts a bound parameter.
                cur.execute("SELECT set_config('request.jwt.claims', %s, true)", (claims,))
                yield cur


@contextmanager
def service_tx() -> Iterator[psycopg.Cursor]:
    """Run a transaction as ``service_role``, bypassing RLS.

    Only for work with no request context -- the run thread recording an
    outcome, and startup reconciliation. Anything reachable from a route should
    use :func:`user_tx` instead.
    """
    pool = get_pool()
    with pool.connection() as conn:
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute("SET LOCAL ROLE service_role")
                yield cur


def health() -> dict[str, Any]:
    """Report database reachability for /api/health.

    Never raises: a database that is down should surface in the UI's status
    panel, not as a 500 from the one endpoint meant to diagnose it.
    """
    settings = get_settings()
    if not settings.database_url:
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
    """Release pooled connections on shutdown.

    Guarded on the cache so this never constructs a pool just to close it --
    calling it on an API that never touched the database should be a no-op, not
    a connection attempt.
    """
    if get_pool.cache_info().currsize:
        get_pool().close()
        get_pool.cache_clear()
