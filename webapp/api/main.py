"""FastAPI application backing the AION web UI.

Run it from the repo root with the project venv:

    .venv/bin/uvicorn webapp.api.main:app --host 127.0.0.1 --port 8770 --reload

Every route except /api/health requires a Supabase access token -- the same
session the browser already holds to reach the RAG half of the platform. What a
request can then see is decided by row level security in the `aion` schema, not
by this process, so a route that forgets to filter by user still cannot return
another user's rows.

Still bound to localhost: the EODHD and OpenRouter keys live in this process and
never reach the browser, and that stays true regardless of who is signed in.
"""
from __future__ import annotations

import logging

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db, qlib_session
from .auth import get_principal
from .config import get_settings
from .routers import (activity, agenda, catalog, chat, data, factors, health, ingest,
                      macro, outlook_reports, registry, scalability, scheduled,
                      vibe, portfolios, projects, runs, workspace)
from .scheduler import get_scheduler

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

app = FastAPI(
    title="AION API",
    description="HTTP surface over the quant research engine.",
    version="0.1.0",
)

# The Vite dev server runs on a different origin; in production the UI is served
# as static files from the same origin and this is a no-op.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5274",
        "http://127.0.0.1:5274",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# /api/health stays open. The UI reports a missing data store or an unreachable
# database from it, and it has to be able to do that on the login screen --
# before anyone has a token to present.
app.include_router(health.router, prefix="/api", tags=["health"])

# Everything else requires a verified Supabase token. Declared once here rather
# than per-route: a new endpoint added to any of these routers is authenticated
# by default, which is the failure mode worth designing against.
_authenticated = [Depends(get_principal)]

app.include_router(data.router, prefix="/api", tags=["data"], dependencies=_authenticated)
app.include_router(factors.router, prefix="/api", tags=["factors"], dependencies=_authenticated)
app.include_router(runs.router, prefix="/api", tags=["runs"], dependencies=_authenticated)
app.include_router(chat.router, prefix="/api", tags=["chat"], dependencies=_authenticated)
app.include_router(ingest.router, prefix="/api", tags=["ingest"], dependencies=_authenticated)
app.include_router(macro.router, prefix="/api", tags=["macro"], dependencies=_authenticated)
app.include_router(portfolios.router, prefix="/api", tags=["portfolios"], dependencies=_authenticated)
app.include_router(projects.router, prefix="/api", tags=["projects"], dependencies=_authenticated)
app.include_router(activity.router, prefix="/api", tags=["activity"], dependencies=_authenticated)
app.include_router(agenda.router, prefix="/api", tags=["agenda"], dependencies=_authenticated)
app.include_router(vibe.router, prefix="/api", tags=["vibe"], dependencies=_authenticated)
app.include_router(catalog.router, prefix="/api", tags=["catalog"], dependencies=_authenticated)
app.include_router(registry.router, prefix="/api", tags=["registry"], dependencies=_authenticated)
app.include_router(workspace.router, prefix="/api", tags=["workspace"], dependencies=_authenticated)
app.include_router(scheduled.router, prefix="/api", tags=["scheduled"], dependencies=_authenticated)
app.include_router(outlook_reports.router, prefix="/api", tags=["outlook"], dependencies=_authenticated)
app.include_router(scalability.router, prefix="/api", tags=["scalability"], dependencies=_authenticated)


@app.on_event("startup")
def _startup() -> None:
    get_settings()
    # Best-effort: a missing data store must not stop the API from serving
    # /api/health, which is exactly how the UI reports the problem.
    qlib_session.init_qlib()

    # Runs left 'running' by a previous process have untracked subprocesses that
    # will never report back. Settle them now rather than showing a spinner
    # forever. Best-effort for the same reason as above: an unreachable database
    # should be visible in /api/health, not fatal at boot.
    try:
        from .routers.runs import _runs
        orphans = _runs.reconcile_orphans()
        if orphans:
            logging.getLogger(__name__).info(
                "marked %d interrupted run(s) as failed", orphans)
    except Exception as exc:  # noqa: BLE001 - reported, not handled
        logging.getLogger(__name__).warning("could not reconcile runs: %s", exc)

    # Start the scheduled-task ticker. It is best-effort for the same reason as
    # run reconciliation: an unreachable database should surface in /api/health.
    try:
        get_scheduler().start()
    except Exception as exc:  # noqa: BLE001 - reported, not handled
        logging.getLogger(__name__).warning("could not start scheduled-task scheduler: %s", exc)


@app.on_event("shutdown")
def _shutdown() -> None:
    get_scheduler().stop()
    db.close_pool()
