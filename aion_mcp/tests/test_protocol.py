"""Streamable-HTTP MCP protocol subset."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from aion_mcp.server import _sessions, create_app
from webapp.api.config import get_settings
from webapp.api.mcp_allowlist import AION_MCP_CONFIRM_TOOLS, AION_MCP_READ_TOOLS

_AUTH = {"Authorization": "Bearer test-token"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("AION_MCP_TOKEN", "test-token")
    get_settings.cache_clear()
    _sessions.clear()
    yield TestClient(create_app(), headers=_AUTH)
    get_settings.cache_clear()
    _sessions.clear()


def test_health_lists_tool_count(client):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["tools"] == len(AION_MCP_READ_TOOLS | AION_MCP_CONFIRM_TOOLS)


def test_initialize_returns_session(client):
    response = client.post("/mcp", json={
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1.0"},
        },
    })
    assert response.status_code == 200
    assert "mcp-session-id" in response.headers
    body = response.json()
    assert body["result"]["serverInfo"]["name"] == "aion-mcp"


def test_tools_list_requires_session(client):
    response = client.post("/mcp", json={
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {},
    })
    assert response.status_code == 200
    assert "error" in response.json()


def test_full_handshake_and_tools_list(client, monkeypatch):
    monkeypatch.setattr(
        "webapp.api.routers.health.health",
        lambda: {"status": "ok"},
    )

    init = client.post("/mcp", json={
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1.0"},
        },
    })
    session = init.headers["mcp-session-id"]

    client.post("/mcp", json={
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
    })

    listing = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        headers={"mcp-session-id": session},
    )
    tools = listing.json()["result"]["tools"]
    assert {t["name"] for t in tools} == AION_MCP_READ_TOOLS | AION_MCP_CONFIRM_TOOLS


def test_tools_call_get_data_status(client, monkeypatch):
    monkeypatch.setattr(
        "webapp.api.routers.health.health",
        lambda: {"status": "ok", "ready": True},
    )

    init = client.post("/mcp", json={
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1.0"},
        },
    })
    session = init.headers["mcp-session-id"]

    call = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "get_data_status", "arguments": {}},
        },
        headers={"mcp-session-id": session},
    )
    result = call.json()["result"]
    assert result["structuredContent"]["status"] == "ok"
    assert result["isError"] is False


def test_non_loopback_requires_token(monkeypatch):
    monkeypatch.setenv("AION_MCP_TOKEN", "")
    get_settings.cache_clear()
    _sessions.clear()
    bare = TestClient(create_app())

    response = bare.post("/mcp", json={
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {},
    })
    assert response.status_code == 401
    get_settings.cache_clear()
