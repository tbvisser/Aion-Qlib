"""The harvester registry: every source the index knows how to rebuild from.

Order matters only for the progress display. Local sources run first so a
reindex shows most of its work done before it waits on the sidecar.

Adding a source is one module and one line here. The rules it has to keep:

- it owns exactly one ``(kind, source)`` pair, which is the delete scope
- ``local_id`` is the source's own identifier, so a uid survives a rebuild
- it raises rather than returning a short list; the orchestrator catches it and
  the collection keeps its previous rows
"""
from __future__ import annotations

from ..harvest import Harvester
from . import curated, indicators, operators, qlib_alphas, templates, vibe_zoo

HARVESTERS: tuple[Harvester, ...] = (
    qlib_alphas.HARVESTER,
    curated.HARVESTER,
    indicators.HARVESTER,
    operators.HARVESTER,
    templates.HARVESTER,
    # Last: the only one that crosses the network, so a reindex shows every
    # local collection rebuilt before it waits on the sidecar.
    vibe_zoo.HARVESTER,
)

BY_NAME: dict[str, Harvester] = {h.name: h for h in HARVESTERS}

__all__ = ["HARVESTERS", "BY_NAME"]
