"""MCP tool catalog and dispatch."""
from __future__ import annotations

from unittest.mock import patch

from aion_mcp.tools import call_tool, mcp_tool_catalog
from webapp.api.auth import Principal
from webapp.api.mcp_allowlist import (
    AION_MCP_BLOCKED_TOOLS,
    AION_MCP_CONFIRM_TOOLS,
    AION_MCP_READ_TOOLS,
)


def test_catalog_includes_read_and_confirm_tools():
    names = {tool["name"] for tool in mcp_tool_catalog()}
    assert AION_MCP_READ_TOOLS <= names
    assert AION_MCP_CONFIRM_TOOLS <= names
    assert not names & AION_MCP_BLOCKED_TOOLS


def test_catalog_entries_have_mcp_shape():
    for tool in mcp_tool_catalog():
        assert "name" in tool
        assert "description" in tool
        assert tool["inputSchema"]["type"] == "object"


def test_blocked_tool_returns_error():
    result = call_tool("book_venue_consultation", {})
    assert "error" in result


def test_confirm_tool_returns_needs_confirmation():
    principal = Principal(
        user_id="11111111-1111-1111-1111-111111111111",
        email=None,
        org_id="22222222-2222-2222-2222-222222222222",
        org_role="owner",
    )
    with patch("aion_mcp.tools.effective_principal", return_value=principal):
        result = call_tool("run_backtest", {"name": "demo", "universe": "top500"})
    assert result.get("status") == "needs_confirmation"
    assert result.get("confirmation_id")
    assert result.get("tool") == "run_backtest"


def test_db_tool_without_service_user_returns_error():
    with patch("aion_mcp.tools.resolve_principal", return_value=None):
        with patch("aion_mcp.tools.get_mcp_principal", return_value=None):
            result = call_tool("list_runs", {})
    assert "AION_MCP_SERVICE_USER_ID" in result["error"]


def test_get_data_status_works_without_service_user(monkeypatch):
    monkeypatch.setattr("aion_mcp.tools.resolve_principal", lambda: None)
    monkeypatch.setattr("aion_mcp.tools.get_mcp_principal", lambda: None)

    def fake_health():
        return {"status": "ok", "region": "us"}

    monkeypatch.setattr("webapp.api.routers.health.health", fake_health)
    result = call_tool("get_data_status", {})
    assert result.get("status") == "ok"
