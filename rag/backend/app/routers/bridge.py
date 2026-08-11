"""HTTP bridge endpoint for sandbox tool access.

Security: Bridge endpoints authenticate via session tokens (tied to sandbox sessions),
NOT JWT auth. The sandbox container cannot provide JWTs — it only has a session token
passed via environment variable. Session tokens are ephemeral UUIDs that expire with
the sandbox session.
"""
import json
import logging

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from app.services.langsmith import traceable

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bridge", tags=["bridge"])


class BridgeCallRequest(BaseModel):
    tool_name: str
    arguments: dict
    session_token: str


@router.get("/health")
async def bridge_health():
    from app.config import get_settings
    settings = get_settings()
    if not settings.tool_registry_enabled:
        return {"status": "disabled"}
    from app.services.tool_registry import get_tool_registry
    registry = get_tool_registry()
    return {"status": "ok", "tool_count": registry.tool_count}


@router.post("/call")
@traceable(name="bridge.call_tool", run_type="tool")
async def bridge_call(request: BridgeCallRequest):
    from app.config import get_settings
    settings = get_settings()
    if not settings.tool_registry_enabled:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Tool registry not enabled")

    from app.services.sandbox_session_manager import get_session_manager
    manager = get_session_manager()
    managed = manager.validate_session_token(request.session_token)
    if not managed:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session token")

    # SECURITY (finding D-001): the sandbox runs attacker-influenceable code, so the
    # bridge is a confused deputy. Only allowlisted (read-only) tools may be dispatched
    # — never execute_code (recursive sandbox), save_skill/write_* (persistent writes),
    # or task (sub-agent spawn). Enforce BEFORE the registry lookup so a denied tool
    # leaks nothing about whether it exists.
    if request.tool_name not in set(settings.sandbox_bridge_tool_allowlist):
        logger.warning("Bridge call rejected: tool %r not in sandbox allowlist", request.tool_name)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tool not permitted from sandbox",
        )

    from app.services.tool_registry import get_tool_registry
    registry = get_tool_registry()
    tool_def = registry.get(request.tool_name)
    if not tool_def:
        return {"error": "tool_not_found", "message": f"Tool '{request.tool_name}' not registered"}

    if not tool_def.executor:
        return {"error": "no_executor", "message": f"Tool '{request.tool_name}' has no executor"}

    try:
        tool_call = {
            "name": request.tool_name,
            "arguments": json.dumps(request.arguments),
            "_thread_id": managed.thread_id,
        }
        result = await tool_def.executor(tool_call, managed.user_id)

        # Handle async generators (sub-agents, code execution) — collect result
        if hasattr(result, '__anext__'):
            collected = []
            async for event in result:
                collected.append(event)
            # Return the final result from the generator
            if collected:
                last = collected[-1]
                if isinstance(last, dict) and last.get("type", "").endswith("_complete"):
                    return {"result": last}
                return {"result": collected}
            return {"result": None}

        return {"result": result}
    except Exception as e:
        logger.error(f"Bridge call failed for {request.tool_name}: {e}")
        return {"error": "execution_error", "message": "Tool execution failed"}


@router.get("/catalog")
async def bridge_catalog(
    session_token: str = Query(..., description="Ephemeral sandbox session token"),
):
    # NOTE: GET, so the token comes as a query param (the sandbox bridge_client
    # sends ?session_token=...). /bridge/call takes it in the JSON body instead.
    from app.config import get_settings
    settings = get_settings()
    if not settings.tool_registry_enabled:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Tool registry not enabled")

    from app.services.sandbox_session_manager import get_session_manager
    manager = get_session_manager()
    managed = manager.validate_session_token(session_token)
    if not managed:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session token")

    from app.services.tool_registry import get_tool_registry
    registry = get_tool_registry()
    # SECURITY (D-001): advertise only the allowlisted tools so the sandbox is never
    # offered a tool that /bridge/call would reject (kept in sync with bridge_call).
    allowlist = set(settings.sandbox_bridge_tool_allowlist)
    tools = []
    for name in registry.tool_names:
        if name not in allowlist:
            continue
        tool = registry.get(name)
        if tool:
            tools.append({
                "name": tool.name,
                "description": tool.description,
                "source": tool.source.value,
                "parameters": tool.openai_schema.get("function", {}).get("parameters", {}),
            })
    return {"tools": tools}
