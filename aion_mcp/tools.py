"""Dispatch MCP tool calls through the same handlers as the chat assistant."""
from __future__ import annotations

import logging
from contextvars import ContextVar
from functools import lru_cache
from typing import Any, Callable

from webapp.api.auth import Principal
from webapp.api.config import get_settings
from webapp.api.mcp_allowlist import (
    AION_MCP_CONFIRM_TOOLS,
    AION_MCP_READ_TOOLS,
    is_allowed,
)
from webapp.api.mcp_confirmations import create_confirmation
from webapp.api.runner import RunManager

logger = logging.getLogger(__name__)

_SERVICE_USER_MISSING = (
    "AION_MCP_SERVICE_USER_ID is not configured — this tool requires a "
    "service user with database access."
)

_DB_TOOLS = frozenset({"get_run_status", "list_runs", "get_scalability_report"})
_CONFIRM_DB_TOOLS = frozenset({"start_scalability_analysis"})

_PLACEHOLDER = Principal(
    user_id="00000000-0000-0000-0000-0000000000a0",
    email=None,
    org_id="00000000-0000-0000-0000-0000000000a1",
    org_role="owner",
)

_mcp_principal: ContextVar[Principal | None] = ContextVar("mcp_principal", default=None)


def set_mcp_principal(principal: Principal | None) -> None:
    _mcp_principal.set(principal)


def get_mcp_principal() -> Principal | None:
    return _mcp_principal.get()


@lru_cache
def _run_manager() -> RunManager:
    settings = get_settings()
    return RunManager(settings.runs_dir, settings.repo_root)


def resolve_principal() -> Principal | None:
    """Build the service principal from settings, or None if unset."""
    settings = get_settings()
    user_id = (settings.aion_mcp_service_user_id or "").strip()
    if not user_id:
        return None

    org_id = (settings.aion_mcp_service_org_id or "").strip()
    if org_id:
        return Principal(
            user_id=user_id,
            email=None,
            org_id=org_id,
            org_role="owner",
        )

    try:
        from webapp.api.db import user_tx

        with user_tx(user_id) as cur:
            cur.execute(
                "SELECT m.org_id, m.role FROM public.org_members m "
                "JOIN public.user_profiles p ON p.user_id = m.user_id "
                "WHERE m.user_id = %s AND m.org_id = p.default_org_id",
                (user_id,),
            )
            row = cur.fetchone()
            if row is None:
                cur.execute(
                    "SELECT org_id, role FROM public.org_members "
                    "WHERE user_id = %s ORDER BY joined_at ASC LIMIT 1",
                    (user_id,),
                )
                row = cur.fetchone()
        if row is None:
            logger.warning("service user %s has no org membership", user_id)
            return None
        return Principal(
            user_id=user_id,
            email=None,
            org_id=str(row["org_id"]),
            org_role=row["role"],
        )
    except Exception as exc:
        logger.warning("could not resolve service principal: %s", exc)
        return None


def effective_principal() -> Principal:
    """User token principal, else service user, else placeholder."""
    return get_mcp_principal() or resolve_principal() or _PLACEHOLDER


def mcp_tool_catalog() -> list[dict[str, Any]]:
    """MCP ``tools/list`` entries derived from chat tool schemas."""
    from webapp.api.chat_tools import tool_schemas

    allowed = AION_MCP_READ_TOOLS | AION_MCP_CONFIRM_TOOLS
    out: list[dict[str, Any]] = []
    for schema in tool_schemas("general"):
        fn = schema["function"]
        name = fn["name"]
        if name not in allowed:
            continue
        description = fn.get("description", "")
        if name in AION_MCP_CONFIRM_TOOLS:
            description = f"{description} (Requires approval in Aion UI before execution.)"
        out.append({
            "name": name,
            "description": description,
            "inputSchema": fn.get("parameters", {"type": "object", "properties": {}}),
        })
    return out


def _handlers_for(principal: Principal) -> dict[str, Callable[..., dict]]:
    from webapp.api.chat_tools import build_registry

    registry = build_registry(_run_manager(), principal, profile="general")
    return {name: registry[name] for name in registry if is_allowed(name)}


def invoke_tool(name: str, arguments: dict[str, Any], principal: Principal) -> dict[str, Any]:
    """Run an allowlisted tool immediately (used after confirmation approval)."""
    handler = _handlers_for(principal).get(name)
    if handler is None:
        return {"error": f"Tool {name!r} is not available"}
    try:
        return handler(**arguments)
    except TypeError as exc:
        return {"error": f"Invalid arguments for {name}: {exc}"}
    except Exception as exc:
        logger.exception("tool %s failed", name)
        return {"error": str(exc)}


def call_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Invoke an allowlisted tool; return a plain dict for structuredContent."""
    if not is_allowed(name):
        return {"error": f"Tool {name!r} is not exposed via Aion MCP"}

    principal = effective_principal()
    db_tools = _DB_TOOLS | _CONFIRM_DB_TOOLS
    if name in db_tools and get_mcp_principal() is None and resolve_principal() is None:
        return {"error": _SERVICE_USER_MISSING}

    if name in AION_MCP_CONFIRM_TOOLS:
        row = create_confirmation(name, arguments, principal)
        return {
            "status": "needs_confirmation",
            "confirmation_id": row.id,
            "tool": row.tool,
            "arguments": row.arguments,
            "summary": row.summary,
            "message": (
                "This action requires approval in the Aion UI before it runs. "
                f"Open Agents & Skills → MCP approvals and confirm «{row.summary}»."
            ),
        }

    return invoke_tool(name, arguments, principal)
