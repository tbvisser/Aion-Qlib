"""Shared Hermes gateway reachability probe for the roster and /api/hermes/health."""
from __future__ import annotations

import socket
from typing import Any
from urllib.parse import urlparse

import httpx

_MCP_SERVERS = ("aion", "vibe")
_TIMEOUT = httpx.Timeout(3.0, connect=1.5)


def probe_hermes_gateway(settings: Any) -> dict[str, Any]:
    """Return a normalized health dict; raise on unreachable when enabled."""
    if not settings.hermes_gateway_enabled:
        return {
            "status": "disabled",
            "enabled": False,
            "mcp_servers": list(_MCP_SERVERS),
        }

    base = settings.hermes_gateway_url.rstrip("/")
    detail: str | None = None
    gateway: dict[str, Any] | None = None

    for path in ("/health", "/v1/health", "/v1/models"):
        try:
            with httpx.Client(timeout=_TIMEOUT) as client:
                response = client.get(f"{base}{path}")
            if response.status_code < 500:
                try:
                    gateway = response.json()
                except ValueError:
                    gateway = {"http_status": response.status_code}
                return _ok(gateway)
        except httpx.HTTPError as exc:
            detail = str(exc)

    if _tcp_open(base):
        return _ok({"tcp": True, "note": "gateway port open; HTTP health not configured"})

    raise httpx.ConnectError(detail or f"hermes gateway unreachable at {base}")


def _ok(gateway: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "status": "ok",
        "enabled": True,
        "mcp_servers": list(_MCP_SERVERS),
        "gateway": gateway or {},
    }


def _tcp_open(base_url: str) -> bool:
    parsed = urlparse(base_url)
    host = parsed.hostname
    if not host:
        return False
    port = parsed.port or 8642
    try:
        with socket.create_connection((host, port), timeout=1.5):
            return True
    except OSError:
        return False
