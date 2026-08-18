"""This API's own agents: 2 chat profiles and the tools behind them.

A profile is a system prompt plus a tool tuple, and the tuple is the whole
safety model -- `build_registry` returns only the named tools, so absence is
structural rather than an instruction the model might ignore. `general` gets
ten tools including `run_backtest` and the scalability trio; `builder` gets
four and cannot act.

That distinction is the one thing a roster of agents must show, so the tool list
rides in the payload and the summary says how many.

In-process, so this provider cannot be degraded -- which makes it the reason the
roster still renders something when every remote source is down.
"""
from __future__ import annotations

from typing import Any, Iterable

from ...catalog.schema import Entity
from ..aggregate import Provider

#: What each profile is for, in one line. The system prompts themselves are
#: multi-thousand-character f-strings that interpolate the whole operator
#: vocabulary -- useful in the detail rail, useless as a table summary.
_ABOUT = {
    "general": (
        "The assistant behind the dashboard chat. Reads data status, searches "
        "instruments, summarises prices, measures factors, can start and "
        "follow a backtest, and can kick off the scalability agent on an "
        "uploaded trade file and book the venue consultation it leads to."
    ),
    "builder": (
        "The Strategy Builder's assistant. Proposes a strategy spec and reads "
        "templates; deliberately has no tool that acts, so it can draft a "
        "backtest but never launch one."
    ),
}


def fetch(settings: Any) -> Iterable[Entity]:
    from ...chat_tools import PROFILES, tool_schemas

    out: list[Entity] = []

    for name, profile in PROFILES.items():
        tools = list(profile.tools)
        # Schemas are rebuilt per call -- `propose_strategy`'s parameters depend
        # on the stores that exist right now -- so ask for them rather than
        # reading the static table.
        schemas = {t["function"]["name"]: t["function"] for t in tool_schemas(name)}

        out.append(
            Entity(
                kind="agent",
                source="aion",
                local_id=name,
                name=name,
                title=f"{name.title()} assistant",
                summary=f"{len(tools)} tools · {'can run backtests' if 'run_backtest' in tools else 'read and draft only'}",
                family="chat profile",
                tags=sorted(tools),
                payload={
                    "description": _ABOUT.get(name, ""),
                    "tools": tools,
                    "model": settings.openrouter_model,
                    "configured": bool(settings.openrouter_api_key),
                    "system_prompt": profile.system_prompt,
                    "tool_descriptions": {
                        t: schemas.get(t, {}).get("description", "") for t in tools
                    },
                },
            )
        )

    return out


PROVIDER = Provider(
    name="chat_profiles",
    kind="agent",
    source="aion",
    label="Aion chat profiles",
    fetch=fetch,
)
