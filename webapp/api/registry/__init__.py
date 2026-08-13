"""The roster: every agent, skill, swarm team and tool the platform can reach.

Four backends contribute, and none of them is this one:

* the **Vibe-Trading sidecar** -- 30 swarm teams, 89 skills, 34 allowlisted MCP
  tools, 5 scheduled playbooks
* the vendored **Aion-RAG backend** -- 44 live tools, 1 harness, 3 sub-agents
* this **API** -- 2 chat profiles and the 9 tools behind them
* the **repo** -- 3 file-based skills that never had a runtime reader

**Federated live, not indexed.** The catalog next door keeps a SQLite index
because alphas are stable, machine-global and expensive to recompute. A roster
is the opposite: it is four HTTP calls, it changes the moment a service
restarts, and a swarm list that is quietly a week old is worse than one that
takes 300 ms. So this package fans out on demand.

What federation must not do is hit the sidecar once per keystroke. A TTL cache
sits in front of the fan-out (see ``aggregate.py``); search, facets and paging
then run in-process over the cached rows, so the search box costs nothing after
the first request.

**A dead provider keeps its last-good rows.** Same posture the catalog's
``harvest_run`` takes, minus the database: each provider caches independently, a
failed refresh leaves the previous rows in place, and ``/summary`` names it. With
the sidecar stopped the roster still shows qlib and RAG rather than going blank.

The row shape and the ``<kind>:<source>:<local_id>`` uid grammar are the
catalog's, imported rather than redefined -- one taxonomy, so the same browser
component can render either page.
"""
from __future__ import annotations

from .aggregate import (
    MAX_LIMIT, PROVIDERS, SORTS, TTL_SECONDS, ProviderResult,
    entity, facets, refresh, rows, search, summary,
)

__all__ = [
    "MAX_LIMIT",
    "PROVIDERS",
    "SORTS",
    "TTL_SECONDS",
    "ProviderResult",
    "entity",
    "facets",
    "refresh",
    "rows",
    "search",
    "summary",
]
