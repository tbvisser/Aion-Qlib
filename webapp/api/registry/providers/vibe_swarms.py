"""Vibe's swarm teams: 30 presets, 119 agent slots between them.

A preset is a static DAG of tasks over a fixed roster of role-specialised
agents, each with its own tool and skill whitelist. `investment_committee` is
four: a bull-side researcher, a bear-side researcher, a chief risk officer and
the PM who makes the call.

**The member roles are not reachable, and that is a version fact, not an
oversight.** v0.1.8 of the sidecar had a `GET /swarm/presets/{name}` returning
each agent's id, role, tools and skills. **v0.1.13 -- the deployed wheel -- does
not**, and because the sidecar serves its SPA as a catch-all, requesting that
path answers 200 with `index.html` rather than 404. Anyone reading the upstream
source will find the route and conclude it works; `_vibe.get_json` refuses a
non-JSON body precisely so that mistake fails loudly.

So a team indexes as one row: title, description, the variables it takes, and
how many agents it fields. The detail rail says the rest out loud.
"""
from __future__ import annotations

from typing import Any, Iterable

from ...catalog.schema import Entity
from ..aggregate import Provider
from . import _vibe


def _summary(preset: dict) -> str:
    count = preset.get("agent_count") or 0
    required = [v["name"] for v in preset.get("variables") or [] if v.get("required")]
    parts = [f"{count} agent{'s' if count != 1 else ''}"]
    if required:
        parts.append("needs " + ", ".join(required))
    return " · ".join(parts)


def fetch(settings: Any) -> Iterable[Entity]:
    presets = _vibe.get_json(settings, "swarm/presets")
    if not isinstance(presets, list):
        raise RuntimeError(f"vibe /swarm/presets returned {type(presets).__name__}, expected a list")

    out: list[Entity] = []
    for preset in presets:
        variables = preset.get("variables") or []
        out.append(
            Entity(
                kind="swarm",
                source="vibe",
                local_id=preset["name"],
                name=preset["name"],
                title=preset.get("title") or preset["name"],
                # The team's own one-liner is the useful summary; the agent
                # count and required variables go in `summary` because that is
                # what the table column shows.
                summary=_summary(preset),
                # `source` on the preset is the sidecar's own notion -- bundled
                # vs user-authored -- which is exactly the axis worth faceting
                # a 30-row collection on.
                family=preset.get("source") or "bundled",
                tags=sorted({v["name"] for v in variables if v.get("name")}),
                payload={
                    "description": preset.get("description"),
                    "agent_count": preset.get("agent_count"),
                    "variables": variables,
                    "preset_source": preset.get("source"),
                    # Read by the detail rail. Stated as data rather than
                    # hardcoded in the component so the day the sidecar grows
                    # the route, one file changes.
                    "members_available": False,
                },
            )
        )
    return out


PROVIDER = Provider(
    name="vibe_swarms",
    kind="swarm",
    source="vibe",
    label="Vibe swarm teams",
    fetch=fetch,
    remote=True,
)
