"""Tier-1 MCP confirmations."""
from __future__ import annotations

from webapp.api.auth import Principal
from webapp.api.mcp_confirmations import (
    create_confirmation,
    discard_confirmation,
    execute_confirmation,
    list_pending,
)


def _principal(uid: str = "u1", org: str = "o1") -> Principal:
    return Principal(user_id=uid, email=None, org_id=org, org_role="owner")


def test_create_and_list_pending():
    p = _principal()
    row = create_confirmation("run_backtest", {"name": "demo", "universe": "top500"}, p)
    assert row.tool == "run_backtest"
    pending = list_pending(p)
    assert len(pending) == 1
    assert pending[0].id == row.id
    discard_confirmation(row.id)


def test_execute_invokes_handler():
    p = _principal()
    row = create_confirmation("run_backtest", {"name": "x"}, p)
    seen: dict = {}

    def _invoke(tool, args, principal):
        seen["tool"] = tool
        seen["principal"] = principal.user_id
        return {"ok": True}

    result = execute_confirmation(row.id, p, invoke=_invoke)
    assert result == {"ok": True}
    assert seen["tool"] == "run_backtest"
    assert list_pending(p) == []


def test_wrong_user_cannot_approve():
    p = _principal("u1", "o1")
    row = create_confirmation("run_backtest", {}, p)
    other = _principal("u2", "o1")
    result = execute_confirmation(row.id, other, invoke=lambda *_: {"ok": True})
    assert result["error"] == "Not authorized to approve this confirmation"
    discard_confirmation(row.id)
