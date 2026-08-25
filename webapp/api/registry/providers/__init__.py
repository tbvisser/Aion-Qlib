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


def providers() -> tuple[Provider, ...]:
    """All roster providers, including optional ones gated by settings."""
    from ...config import get_settings

    out: list[Provider] = [
        chat_profiles.PROVIDER,
        chat_tools_provider.PROVIDER,
        repo_skills.PROVIDER,
        scalability_agent.PROVIDER,
    ]
    if get_settings().hermes_gateway_enabled:
        from . import hermes_gateway
        out.append(hermes_gateway.PROVIDER)
    out.extend([
        vibe_swarms.PROVIDER,
        vibe_skills.PROVIDER,
        vibe_tools.PROVIDER,
        vibe_playbooks.PROVIDER,
        rag_registry.AGENTS_PROVIDER,
        rag_registry.TOOLS_PROVIDER,
    ])
    return tuple(out)


__all__ = ["providers"]
