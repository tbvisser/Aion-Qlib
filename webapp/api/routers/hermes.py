"""Hermes gateway helpers: health proxy and user MCP tokens."""
from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException

from ..auth import Principal, get_principal
from ..config import get_settings
from ..hermes_gateway_probe import probe_hermes_gateway
from ..mcp_user_token import mint_user_token

router = APIRouter()


@router.get("/hermes/health")
async def hermes_health() -> dict:
    """Reachability of hermes-gateway for the Agents & Skills console card."""
    settings = get_settings()
    if not settings.hermes_gateway_enabled:
        return {
            "status": "disabled",
            "enabled": False,
            "mcp_servers": ["aion", "vibe"],
        }
    try:
        return probe_hermes_gateway(settings)
    except httpx.HTTPError as exc:
        return {
            "status": "unreachable",
            "enabled": True,
            "detail": str(exc),
            "mcp_servers": ["aion", "vibe"],
        }


@router.post("/hermes/mcp-token")
def issue_mcp_user_token(principal: Principal = Depends(get_principal)) -> dict:
    """Mint a short-lived Bearer token for user-scoped aion-mcp calls."""
    settings = get_settings()
    if not settings.aion_mcp_token:
        raise HTTPException(
            status_code=503,
            detail="AION_MCP_TOKEN is not configured on the API",
        )
    try:
        token, exp = mint_user_token(
            principal,
            service_token=settings.aion_mcp_token,
            dedicated_secret=settings.aion_mcp_user_token_secret,
        )
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        "token": token,
        "expires_at": exp,
        "user_id": principal.user_id,
        "org_id": principal.org_id,
        "usage": "Authorization: Bearer <token> on aion-mcp /mcp",
    }
