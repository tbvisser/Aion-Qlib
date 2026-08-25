"""REST API for Tier-1 MCP tool confirmations (approve in Aion UI)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..auth import Principal, get_principal
from ..mcp_confirmations import (
    discard_confirmation,
    execute_confirmation,
    get_confirmation,
    list_pending,
)
from aion_mcp.tools import invoke_tool

router = APIRouter()


@router.get("/mcp/confirmations")
def pending_confirmations(principal: Principal = Depends(get_principal)) -> dict:
    rows = list_pending(principal)
    return {"confirmations": [row.to_dict() for row in rows]}


@router.post("/mcp/confirmations/{confirmation_id}/approve")
def approve_confirmation(
    confirmation_id: str,
    principal: Principal = Depends(get_principal),
) -> dict:
    result = execute_confirmation(
        confirmation_id,
        principal,
        invoke=lambda tool, args, p: invoke_tool(tool, args, p),
    )
    if result.get("error") == "Confirmation not found or expired":
        raise HTTPException(status_code=404, detail=result["error"])
    if result.get("error") == "Not authorized to approve this confirmation":
        raise HTTPException(status_code=403, detail=result["error"])
    return result


@router.post("/mcp/confirmations/{confirmation_id}/reject")
def reject_confirmation(
    confirmation_id: str,
    principal: Principal = Depends(get_principal),
) -> dict:
    row = get_confirmation(confirmation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Confirmation not found or expired")
    if row.user_id != principal.user_id or row.org_id != principal.org_id:
        raise HTTPException(status_code=403, detail="Not authorized to reject this confirmation")
    discard_confirmation(confirmation_id)
    return {"status": "rejected", "confirmation_id": confirmation_id}
