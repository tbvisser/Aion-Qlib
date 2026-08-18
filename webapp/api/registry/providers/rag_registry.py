"""The vendored Aion-RAG backend's own agents and tools.

Two providers over one service: 4 agents (1 harness + 3 sub-agents) and 44 live
tools — the union of the RAG native set and whatever its MCP client has
connected, which today is the Vibe sidecar again through a different door.

**Why this needs new routes upstream and the sidecar did not.** Every rag-api
route that lists anything takes a Supabase JWT, verified against the JWKS
endpoint — there is no service token and no symmetric-secret path, deliberately.
A provider runs without a user, so it cannot reach them. The answer was two
unauthenticated read-only routes in the vendored backend
(`rag/backend/app/routers/registry.py`), which is defensible precisely because
capability listings carry no user data. RAG **skills** stayed behind the JWT,
because they genuinely are per-user, and those reach the page through the
browser the way documents do.

`enabled: false` from `/registry/tools` is a real state, not an error: the
registry is off by default upstream. It arrives as an empty collection with the
reason on every row, rather than as a failure.
"""
from __future__ import annotations

from typing import Any, Iterable

import httpx

from ...catalog.schema import Entity
from ..aggregate import Provider

_TIMEOUT = httpx.Timeout(20.0, connect=5.0)


def _get(settings: Any, path: str) -> Any:
    with httpx.Client(timeout=_TIMEOUT) as client:
        response = client.get(f"{settings.rag_api_url}/{path}")
    response.raise_for_status()
    return response.json()


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------


def fetch_agents(settings: Any) -> Iterable[Entity]:
    payload = _get(settings, "registry/agents")
    out: list[Entity] = []

    for harness in payload.get("harnesses") or []:
        phases = harness.get("phase_count")
        out.append(
            Entity(
                kind="agent",
                source="rag",
                local_id=harness["harness_type"],
                name=harness["harness_type"],
                title=harness.get("display_name") or harness["harness_type"],
                summary=f"{phases} phases" if phases else "Structured workflow",
                family="harness",
                tags=["deep mode"],
                payload={
                    "description": (
                        "A fixed multi-phase workflow rather than a free-running agent: "
                        "each phase has its own prompt, tool scope and output contract, "
                        "and the next one cannot start until the last validates."
                    ),
                    "phase_count": phases,
                    # Phase names and descriptions only leave the RAG backend
                    # attached to a concrete run, so a listing cannot carry them.
                    "phases_available": False,
                    "runs_on": "rag",
                },
            )
        )

    for agent in payload.get("sub_agents") or []:
        tools = list(agent.get("tools") or [])
        out.append(
            Entity(
                kind="agent",
                source="rag",
                local_id=agent["tool_name"],
                name=agent["tool_name"],
                title=agent.get("display_name") or agent["tool_name"],
                summary=(
                    f"{len(tools)} tools" if tools
                    else (agent.get("tool_scope") or "").split("—")[0].strip() or "Sub-agent"
                ),
                family="sub-agent",
                tags=sorted(tools),
                payload={
                    "description": agent.get("description"),
                    "tools": tools,
                    "tool_scope": agent.get("tool_scope"),
                    "availability": agent.get("availability"),
                    "max_rounds": agent.get("max_rounds"),
                    "runs_on": "rag",
                },
            )
        )

    return out


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


def fetch_tools(settings: Any) -> Iterable[Entity]:
    payload = _get(settings, "registry/tools")

    if not payload.get("enabled"):
        # Not a failure. The registry is off by default upstream, and reporting
        # that as a degraded provider would send someone hunting a broken
        # service instead of a config flag.
        return []

    out: list[Entity] = []
    for tool in payload.get("tools") or []:
        parameters = tool.get("parameters") or {}
        required = parameters.get("required") or []
        out.append(
            Entity(
                kind="tool",
                source="rag",
                local_id=tool["name"],
                name=tool["name"],
                title=tool["name"],
                summary=(tool.get("catalog_entry") or tool.get("description") or "")
                .split("\n", 1)[0].strip(),
                # native / skill / mcp -- the axis worth faceting on, because it
                # says whether a tool is this backend's own or borrowed.
                family=tool.get("source") or "native",
                tags=sorted(r for r in required if isinstance(r, str)),
                payload={
                    "description": tool.get("description"),
                    "input_schema": parameters,
                    "loading": tool.get("loading"),
                    "transport": tool.get("source"),
                    "runs_on": "rag",
                },
            )
        )
    return out


AGENTS_PROVIDER = Provider(
    name="rag_agents",
    kind="agent",
    source="rag",
    label="Aion-RAG harnesses and sub-agents",
    fetch=fetch_agents,
    remote=True,
)

TOOLS_PROVIDER = Provider(
    name="rag_tools",
    kind="tool",
    source="rag",
    label="Aion-RAG tool registry",
    fetch=fetch_tools,
    remote=True,
)
