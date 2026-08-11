"""FastAPI application backing the AION web UI.

Run it from the repo root with the project venv:

    .venv/bin/uvicorn webapp.api.main:app --host 127.0.0.1 --port 8770 --reload

Bound to localhost by design -- there is no auth, and the EODHD / OpenRouter
keys live in this process, never in the browser.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import qlib_session
from .config import get_settings
from .routers import chat, data, factors, health, ingest, macro, portfolios, runs

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

app.include_router(health.router, prefix="/api", tags=["health"])
app.include_router(data.router, prefix="/api", tags=["data"])
app.include_router(factors.router, prefix="/api", tags=["factors"])
app.include_router(runs.router, prefix="/api", tags=["runs"])
app.include_router(chat.router, prefix="/api", tags=["chat"])
app.include_router(ingest.router, prefix="/api", tags=["ingest"])
app.include_router(macro.router, prefix="/api", tags=["macro"])
app.include_router(portfolios.router, prefix="/api", tags=["portfolios"])


@app.on_event("startup")
def _startup() -> None:
    get_settings()
    # Best-effort: a missing data store must not stop the API from serving
    # /api/health, which is exactly how the UI reports the problem.
    qlib_session.init_qlib()
