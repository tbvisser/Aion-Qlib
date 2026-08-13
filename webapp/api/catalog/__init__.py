"""The catalog: one searchable index over every *shared* asset the app knows about.

Alphas, indicators, operators, templates, instruments, universes and macro
series live in unrelated places -- repo YAML, gitignored JSON, a qlib generator,
an MLflow file store, a remote sidecar.
None of them can be searched together, and none of them is going to move: each
is the right shape for the thing that owns it.

So this is an **index, never a source of truth**. Every row is rebuilt from its
origin by a harvester, which means the index can be deleted at any moment
without losing anything, and a source that changes shape is one harvester to fix
rather than a migration. The one exception is ``entity_link``: user-set links
(the paper a factor came from) are the only rows here that exist nowhere else,
so the harvest preserves them and drops only the links it derived itself.

Documents are deliberately absent. They are per-user rows under Supabase RLS
with their own hybrid and vector search, and copying their metadata here would
mean reimplementing row-level security in SQLite to no benefit. The Documents
collection is federated in from the browser at query time instead.

**Saved strategies left for the same reason**, and it is worth being explicit
because they used to be here. While strategies were a shared pile of YAML the
harvester was correct; once they became per-user rows in ``aion.strategies`` it
became a leak -- this index is one SQLite file served to every authenticated
caller, so indexing them would have shown each colleague everyone else's work
through the Database page's search box, while ``/api/strategies`` correctly
showed only their own. Templates stay: they ship with the repo and belong to
nobody.

Layout::

    schema.py      DDL + the Entity record every harvester returns
    db.py          connection, search, facets, links
    harvest.py     the orchestrator: build into a temp table, swap, record
    harvesters/    one module per source, each a pure () -> list[Entity]
"""
from __future__ import annotations

from .schema import Entity, KIND_LABELS, KINDS, SOURCES

__all__ = ["Entity", "KINDS", "KIND_LABELS", "SOURCES"]
