"""The tools this API's chat profiles are built from.

Listed as their own collection, not only as a field on the profiles, because
the question "what can this platform actually do" is answered by tools and the
Tools tab should not be 78 sidecar-and-RAG entries with a hole where our own
sit.

Each row records which profiles carry it -- that is the interesting fact.
`evaluate_factor` and `get_data_status` are in all three; `run_backtest` is in
`general` alone, and that absence is the builders' safety model rather than a
prompt instruction.
"""
from __future__ import annotations

from typing import Any, Iterable

from ...catalog.schema import Entity
from ..aggregate import Provider


def fetch(settings: Any) -> Iterable[Entity]:
    from ...chat_tools import PROFILES, tool_schemas

    # name -> (function schema, profiles carrying it). Built by walking every
    # profile so a tool added to one is picked up without editing this file.
    seen: dict[str, dict[str, Any]] = {}
    carried: dict[str, list[str]] = {}

    for profile_name in PROFILES:
        for schema in tool_schemas(profile_name):
            function = schema["function"]
            seen.setdefault(function["name"], function)
            carried.setdefault(function["name"], []).append(profile_name)

    out: list[Entity] = []
    for name, function in sorted(seen.items()):
        profiles = sorted(carried[name])
        parameters = function.get("parameters") or {}
        required = parameters.get("required") or []

        out.append(
            Entity(
                kind="tool",
                source="aion",
                local_id=name,
                name=name,
                title=name,
                summary=(function.get("description") or "").split("\n", 1)[0].strip(),
                family="chat tool",
                tags=sorted(profiles),
                payload={
                    "description": function.get("description"),
                    "input_schema": parameters,
                    "profiles": profiles,
                    "transport": "in-process",
                    # The claim worth surfacing: a tool in one profile and not
                    # the other is a capability boundary, not an oversight.
                    "in_every_profile": len(profiles) == len(PROFILES),
                    "required": list(required),
                },
            )
        )
    return out


PROVIDER = Provider(
    name="chat_tools",
    kind="tool",
    source="aion",
    label="Aion chat tools",
    fetch=fetch,
)
