"""The scalability agent: one background service, one roster row.

Unlike the chat profiles this agent is not a persona the user talks to -- it
is the data plane of the venue-scalability tool (top-level
``scalability_agent/`` package, compose service ``agent``). It polls
``aion.scalability_jobs`` with FOR UPDATE SKIP LOCKED, runs the ceiling
engine on uploaded trading data, and writes reports back. Work reaches it
through the jobs table, never over HTTP; its only inbound endpoint is
``/health``, which is what this provider probes.

The probe raising on unreachable is deliberate and matches the sidecar
providers: a roster that shows a dead agent as ready is worse than a roster
that says "degraded".
"""
from __future__ import annotations

from typing import Any, Iterable

import httpx

from ...catalog.schema import Entity
from ..aggregate import Provider

#: /health is a stdlib server on a worker process; anything past this means down.
_TIMEOUT = httpx.Timeout(3.0, connect=1.5)


def fetch(settings: Any) -> Iterable[Entity]:
    with httpx.Client(timeout=_TIMEOUT) as client:
        response = client.get(f"{settings.scalability_agent_url}/health")
    response.raise_for_status()
    health = response.json()

    return [
        Entity(
            kind="agent",
            source="aion",
            local_id="scalability-agent",
            name="scalability-agent",
            title="Scalability agent",
            summary=(
                "Background worker: turns an uploaded trade file into a "
                "scalability-ceiling report per venue."
            ),
            family="background service",
            tags=["scalability", "venue", "ceiling", "background"],
            payload={
                "description": (
                    "Claims jobs from aion.scalability_jobs (parse_upload, "
                    "analyze), runs the v1 ceiling engine -- strategy profile, "
                    "square-root impact, venue costs and eligibility -- and "
                    "writes aion.scalability_reports plus an HTML artifact. "
                    "Activated from the Scalability API, the chat assistant's "
                    "scalability tools, or a scalability_report scheduled "
                    "task. It never shares anything with a venue: the "
                    "report_shared_at consent gate lives in the platform's "
                    "booking path."
                ),
                "transport": "postgres queue (FOR UPDATE SKIP LOCKED)",
                "health": health,
                "entrypoint": "python -m scalability_agent.agent.main",
                "compose_service": "agent",
                "engine_version": "v1-heuristic",
                "tools": [
                    "start_scalability_analysis",
                    "get_scalability_report",
                    "book_venue_consultation",
                ],
            },
        )
    ]


PROVIDER = Provider(
    name="scalability_agent",
    kind="agent",
    source="aion",
    label="Scalability agent",
    fetch=fetch,
    remote=True,
)
