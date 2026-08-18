"""The roster: one search surface over four backends' agents, skills and tools.

Deliberately the same route names and the same response envelopes as
``/api/catalog/*``, because the two pages share a browser component and a
component that has to branch on which endpoint it is reading is a component that
will drift. ``search`` returns ``{results, total, limit, offset, returned}``;
a row is ``{uid, kind, source, name, title, summary, family, tags, payload}``.

The differences are the honest ones:

* **No reindex.** The catalog has a job endpoint because a harvest writes a
  database and takes seconds. This federates live behind a TTL, so ``/refresh``
  drops the cache and returns the new summary in one call.
* **No links.** The catalog's edges are between things it indexed. Provenance
  here is the source badge.
* **Providers, not harvesters.** ``/summary.providers`` reports each one's row
  count, when it was last fetched, and its error if it has one -- with ``stale``
  set when the rows on screen predate a failed attempt.

Every handler runs the aggregation on a worker thread. The providers are
synchronous (one of them drives the MCP client through ``asyncio.run``), and
blocking the event loop on four HTTP calls would stall every other request.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from .. import registry as roster
from ..catalog import KIND_LABELS, SOURCES
from ..config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter()

#: The four collections this page owns. A subset of the catalog's KINDS -- they
#: share the uid grammar so one browser reads both, but asking this endpoint for
#: an alpha is a mistake worth a 400 rather than an empty page.
ROSTER_KINDS: tuple[str, ...] = ("swarm", "agent", "skill", "tool")

_UID = re.compile(r"^[a-z_]{1,16}:[a-z]{1,16}:[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,127}$")


def _check_kind(kind: str | None) -> None:
    if kind is not None and kind not in ROSTER_KINDS:
        raise HTTPException(
            400, f"unknown kind {kind!r}; expected one of {', '.join(ROSTER_KINDS)}")


@router.get("/registry/summary")
async def registry_summary() -> dict:
    """What is reachable, how fresh it is, and which providers are degraded."""
    data = await asyncio.to_thread(roster.summary, get_settings())
    return {
        **data,
        "kinds": [{"kind": k, "label": KIND_LABELS[k]} for k in ROSTER_KINDS],
        "sources": list(SOURCES),
    }


@router.get("/registry/search")
async def registry_search(
    q: str | None = Query(None, max_length=200),
    kind: str | None = Query(None, max_length=32),
    source: str | None = Query(None, max_length=32),
    family: str | None = Query(None, max_length=64),
    tag: str | None = Query(None, max_length=64),
    sort: str = Query("name", max_length=32),
    limit: int = Query(50, ge=1, le=roster.MAX_LIMIT),
    offset: int = Query(0, ge=0),
) -> dict:
    """One page of the roster. Every filter is optional and they compose."""
    _check_kind(kind)
    if source is not None and source not in SOURCES:
        raise HTTPException(
            400, f"unknown source {source!r}; expected one of {', '.join(SOURCES)}")
    if sort not in roster.SORTS:
        raise HTTPException(
            400, f"unknown sort {sort!r}; expected one of {', '.join(roster.SORTS)}")

    return await asyncio.to_thread(
        _search, kind=kind, q=q, source=source, family=family, tag=tag,
        sort=sort, limit=limit, offset=offset,
    )


def _search(**kwargs: Any) -> dict:
    return roster.search(get_settings(), **kwargs)


@router.get("/registry/facets")
async def registry_facets(kind: str | None = Query(None, max_length=32)) -> dict:
    """Value counts for the filter rail, scoped to one collection."""
    _check_kind(kind)
    return await asyncio.to_thread(roster.facets, get_settings(), kind)


@router.get("/registry/entity/{uid:path}")
async def registry_entity(uid: str) -> dict:
    """One agent, skill, swarm or tool, with its whole payload."""
    if not _UID.fullmatch(uid or ""):
        raise HTTPException(400, "invalid uid")
    found = await asyncio.to_thread(roster.entity, get_settings(), uid)
    if found is None:
        raise HTTPException(404, f"No roster entry '{uid}'")
    return found


@router.post("/registry/refresh")
async def registry_refresh() -> dict:
    """Drop the TTL cache and re-fan-out, returning the new summary.

    Synchronous, unlike the catalog's reindex: the whole fan-out is a handful of
    HTTP calls, and a job id plus an SSE stream for something that finishes
    before the response would have been written is machinery for its own sake.
    """
    await asyncio.to_thread(roster.refresh, get_settings())
    return await registry_summary()
