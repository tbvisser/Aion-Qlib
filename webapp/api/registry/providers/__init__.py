"""Every source the roster federates.

Order is the order the Overview lists them and the order a cold fan-out runs, so
the in-process ones come first: with the sidecar down, the two that cannot fail
have already answered by the time the timeouts start.

Adding a source is one module and one line here. The rules it has to keep are
the harvesters' rules next door:

- it owns exactly one ``(kind, source)`` pair
- ``local_id`` is the source's own identifier, so a uid is stable
- it raises rather than returning a short list; the aggregator catches it and
  the collection keeps its previous rows
"""
from __future__ import annotations

from ..aggregate import Provider
from . import (
    chat_profiles, chat_tools_provider, rag_registry, repo_skills,
    scalability_agent, vibe_playbooks, vibe_skills, vibe_swarms, vibe_tools,
)

PROVIDERS: tuple[Provider, ...] = (
    # In-process: these answer even when every service is down.
    chat_profiles.PROVIDER,
    chat_tools_provider.PROVIDER,
    repo_skills.PROVIDER,
    # Background worker (one /health probe).
    scalability_agent.PROVIDER,
    # Sidecar.
    vibe_swarms.PROVIDER,
    vibe_skills.PROVIDER,
    vibe_tools.PROVIDER,
    vibe_playbooks.PROVIDER,
    # Vendored RAG backend.
    rag_registry.AGENTS_PROVIDER,
    rag_registry.TOOLS_PROVIDER,
)

BY_NAME: dict[str, Provider] = {p.name: p for p in PROVIDERS}

__all__ = ["PROVIDERS", "BY_NAME"]
