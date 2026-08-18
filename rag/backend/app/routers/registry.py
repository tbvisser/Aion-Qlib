"""What this backend can do, as a listing another service can read.

Two routes, both **unauthenticated**, and the reason is the same for each: they
carry capability listings and no user data. A tool's name and description, a
harness's phase count, a sub-agent's trigger — none of it is scoped to anyone.
The precedent is next door: `GET /bridge/health` already answers without a JWT
and already reports `tool_count`.

Everything that *is* per-user stays where it is. `/skills` returns a user's own
rows plus the global ones and keeps its `Depends(get_current_user)`; a service
asking "what skills exist" without an identity would get a semantically
different set, which is worse than not asking.

This exists because the AION platform's Agents & Skills page federates four
backends and cannot hold a user JWT while doing it. Nothing here is used by this
backend's own frontend.
"""
import logging

from fastapi import APIRouter

from app.services.harnesses import list_harnesses
from app.services.sub_agents import list_sub_agents

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/registry", tags=["registry"])


@router.get("/tools")
async def registry_tools() -> dict:
    """Every tool the runtime registry holds.

    `enabled: false` with an empty list is the honest answer when
    `TOOL_REGISTRY_ENABLED` is off — which is the default. A 503 would read as
    "this backend is broken" when the truth is "this backend was configured
    without the registry", and a caller aggregating four services should be able
    to tell those apart.
    """
    from app.config import get_settings

    settings = get_settings()
    if not settings.tool_registry_enabled:
        return {"enabled": False, "tools": [], "count": 0}

    from app.services.tool_registry import get_tool_registry

    registry = get_tool_registry()
    tools = [
        {
            "name": tool.name,
            "description": tool.description,
            "source": tool.source.value,
            "loading": tool.loading.value,
            # The catalogue line is what the model is shown when deciding
            # whether to load a deferred tool -- a better one-liner than the
            # full description for a list view.
            "catalog_entry": tool.catalog_entry,
            "parameters": (tool.openai_schema or {}).get("function", {}).get("parameters"),
        }
        for tool in registry.all_tools()
    ]
    return {"enabled": True, "tools": tools, "count": len(tools)}


@router.get("/agents")
async def registry_agents() -> dict:
    """The two kinds of agent this backend defines.

    Harnesses come from the registry that already exists; sub-agents come from
    the manifest in `services/sub_agents.py`, which is the only place they are
    written down as data rather than as dispatch branches.
    """
    return {
        "harnesses": list_harnesses(),
        "sub_agents": list_sub_agents(),
    }
