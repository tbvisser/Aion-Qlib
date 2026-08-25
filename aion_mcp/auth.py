"""Bearer token and loopback checks for the Aion MCP server."""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException, Request

from webapp.api.auth import Principal
from webapp.api.config import get_settings
from webapp.api.mcp_user_token import claims_to_principal, verify_user_token

_LOOPBACK = frozenset({"127.0.0.1", "::1"})


@dataclass
class McpAuth:
    """Resolved MCP caller identity."""

    mode: str  # "user" | "service" | "loopback"
    principal: Principal | None = None


def authorize_request(request: Request, token: str) -> McpAuth:
    """Reject callers that lack a valid Bearer token.

    Accepts either the shared ``AION_MCP_TOKEN`` (service mode) or a short-lived
    user token minted via ``POST /api/hermes/mcp-token``.
    """
    settings = get_settings()
    auth_header = request.headers.get("Authorization", "")

    if auth_header.startswith("Bearer "):
        presented = auth_header[7:].strip()
        if token and presented == token:
            return McpAuth(mode="service")

        claims = verify_user_token(
            presented,
            service_token=token,
            dedicated_secret=settings.aion_mcp_user_token_secret,
        )
        if claims is not None:
            return McpAuth(mode="user", principal=claims_to_principal(claims))

        if token:
            raise HTTPException(status_code=401, detail="Invalid or missing Bearer token")

    if token:
        raise HTTPException(status_code=401, detail="Invalid or missing Bearer token")

    client = request.client
    host = client.host if client else ""
    if host not in _LOOPBACK:
        raise HTTPException(
            status_code=401,
            detail="AION_MCP_TOKEN is required for non-loopback callers",
        )
    return McpAuth(mode="loopback")
