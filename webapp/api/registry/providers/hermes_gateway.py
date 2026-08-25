"""Hermes gateway sidecar: one roster row when HERMES_GATEWAY_ENABLED is true.

The gateway is optional compose overlay (`hermes-gateway` in
docker-compose.dev.yml). When disabled, this provider is not registered at
all — the roster must not pay a timeout tax for a service that was never
started.

When enabled, a failed probe raises like the scalability agent: a roster that
shows a dead gateway as ready is worse than one that says degraded.
"""
from __future__ import annotations

from typing import Any, Iterable

from ...catalog.schema import Entity
from ...hermes_gateway_probe import probe_hermes_gateway
from ..aggregate import Provider


def fetch(settings: Any) -> Iterable[Entity]:
    health = probe_hermes_gateway(settings)

    return [
        Entity(
            kind="agent",
            source="hermes",
            local_id="hermes-gateway",
            name="hermes-gateway",
            title="Hermes gateway",
            summary=(
                "Nous Hermes Agent: MCP orchestration over Aion + Vibe, with "
                "cross-session memory, cron, and optional messaging."
            ),
            family="orchestration sidecar",
            tags=["hermes", "orchestration", "messaging", "mcp", "optional"],
            payload={
                "description": (
                    "Optional sidecar running `hermes gateway run`. Connects to "
                    "aion-mcp (qlib read tools) and vibe-mcp (Alpha Zoo, market "
                    "data) on the compose network. Messaging and cron are configured "
                    "in hermes/.env and gateway-config.yaml. See hermes/README.md."
                ),
                "compose_service": "hermes-gateway",
                "health": health,
                "mcp_servers": health.get("mcp_servers", []),
                "docs": "hermes/README.md",
            },
        )
    ]


PROVIDER = Provider(
    name="hermes_gateway",
    kind="agent",
    source="hermes",
    label="Hermes gateway",
    fetch=fetch,
    remote=True,
)
