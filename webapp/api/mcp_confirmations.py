"""Pending MCP tool confirmations (Tier 1) and execution after UI approval."""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Callable

from .auth import Principal
from .mcp_allowlist import AION_MCP_CONFIRM_TOOLS

_TTL_SECONDS = 86400
_lock = threading.Lock()
_pending: dict[str, "PendingConfirmation"] = {}


@dataclass
class PendingConfirmation:
    id: str
    tool: str
    arguments: dict[str, Any]
    user_id: str
    org_id: str
    created_at: float
    summary: str
    source: str = "mcp"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _purge_expired(now: float | None = None) -> None:
    cutoff = (now or time.time()) - _TTL_SECONDS
    stale = [cid for cid, row in _pending.items() if row.created_at < cutoff]
    for cid in stale:
        _pending.pop(cid, None)


def summarize_tool_call(tool: str, arguments: dict[str, Any]) -> str:
    if tool == "run_backtest":
        name = arguments.get("name") or arguments.get("strategy") or "strategy"
        universe = arguments.get("universe", "?")
        return f"Run backtest «{name}» on universe {universe}"
    if tool == "start_scalability_analysis":
        venues = arguments.get("candidate_venues")
        venue_hint = f" ({len(venues)} venues)" if isinstance(venues, list) else ""
        return f"Start scalability analysis{venue_hint}"
    return f"Execute {tool}"


def create_confirmation(
    tool: str,
    arguments: dict[str, Any],
    principal: Principal,
    *,
    source: str = "mcp",
) -> PendingConfirmation:
    if tool not in AION_MCP_CONFIRM_TOOLS:
        raise ValueError(f"{tool!r} is not a Tier-1 confirm tool")

    row = PendingConfirmation(
        id=uuid.uuid4().hex[:16],
        tool=tool,
        arguments=dict(arguments),
        user_id=principal.user_id,
        org_id=principal.org_id,
        created_at=time.time(),
        summary=summarize_tool_call(tool, arguments),
        source=source,
    )
    with _lock:
        _purge_expired(row.created_at)
        _pending[row.id] = row
    return row


def list_pending(principal: Principal) -> list[PendingConfirmation]:
    with _lock:
        _purge_expired()
        return [
            row for row in _pending.values()
            if row.org_id == principal.org_id and row.user_id == principal.user_id
        ]


def get_confirmation(confirmation_id: str) -> PendingConfirmation | None:
    with _lock:
        _purge_expired()
        return _pending.get(confirmation_id)


def discard_confirmation(confirmation_id: str) -> PendingConfirmation | None:
    with _lock:
        return _pending.pop(confirmation_id, None)


def execute_confirmation(
    confirmation_id: str,
    principal: Principal,
    *,
    invoke: Callable[[str, dict[str, Any], Principal], dict[str, Any]],
) -> dict[str, Any]:
    row = get_confirmation(confirmation_id)
    if row is None:
        return {"error": "Confirmation not found or expired"}
    if row.user_id != principal.user_id or row.org_id != principal.org_id:
        return {"error": "Not authorized to approve this confirmation"}
    discard_confirmation(confirmation_id)
    return invoke(row.tool, row.arguments, principal)
