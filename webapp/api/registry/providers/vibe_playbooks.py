"""Vibe's scheduled playbooks: 5 standing research jobs the agent can run.

A pre-market brief, a portfolio check-up, an A-share money-flow review, an
earnings-season tracker and an institutional-holdings diff. Each names the
markets it covers, the data it needs, the variables it takes and a cron
expression it suggests.

They land under `agent` rather than a kind of their own because that is what
they are: a named job with a prompt, a schedule and a scope. A collection of
five is a facet, not a tab.

**Read-only, and this roster keeps it that way.** Scheduling one is a POST, and
the proxy is GET-only for REST -- listing them here does not make them runnable
from this app.
"""
from __future__ import annotations

from typing import Any, Iterable

from ...catalog.schema import Entity
from ..aggregate import Provider
from . import _vibe


def fetch(settings: Any) -> Iterable[Entity]:
    playbooks = _vibe.get_json(settings, "scheduled-runs/playbooks")
    if not isinstance(playbooks, list):
        raise RuntimeError(
            f"vibe /scheduled-runs/playbooks returned {type(playbooks).__name__}, expected a list")

    out: list[Entity] = []
    for playbook in playbooks:
        markets = list(playbook.get("markets") or [])
        capabilities = list(playbook.get("data_capabilities") or [])
        out.append(
            Entity(
                kind="agent",
                source="vibe",
                local_id=playbook["slug"],
                name=playbook["slug"],
                title=playbook.get("name") or playbook["slug"],
                summary=_summary(playbook, markets),
                family="playbook",
                tags=sorted(markets),
                payload={
                    "description": playbook.get("description"),
                    "markets": markets,
                    "data_capabilities": capabilities,
                    "suggested_schedule": playbook.get("suggested_schedule"),
                    "suggested_timezone": playbook.get("suggested_timezone"),
                    "variables": playbook.get("variables") or {},
                    "runs_on": "vibe",
                    # Listing is not scheduling: the proxy is GET-only for REST.
                    "runnable_here": False,
                },
            )
        )
    return out


def _summary(playbook: dict, markets: list[str]) -> str:
    parts = []
    if markets:
        parts.append(", ".join(markets))
    schedule = playbook.get("suggested_schedule")
    if schedule:
        tz = playbook.get("suggested_timezone")
        parts.append(f"{schedule}{f' {tz}' if tz else ''}")
    return " · ".join(parts) or "Scheduled playbook"


PROVIDER = Provider(
    name="vibe_playbooks",
    kind="agent",
    source="vibe",
    label="Vibe scheduled playbooks",
    fetch=fetch,
    remote=True,
)
