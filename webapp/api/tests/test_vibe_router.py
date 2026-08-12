"""The /api/vibe proxy: allowlists are the live-trading kill seam.

Everything is mocked at the httpx layer (monkeypatched AsyncClient) — these
tests must pass with no sidecar running and never make a network call. What is
pinned here:

* REST passthrough is GET-only and prefix-allowlisted; ``live/*`` and
  ``mandate/*`` are 404s *from our proxy*, regardless of what vibe would say.
* MCP calls are tool-name allowlisted; file/shell-shaped tools are 404s.
* The Bearer token from settings reaches the sidecar; the MCP client performs
  the initialize handshake and parses both JSON and SSE response bodies.
"""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from webapp.api.main import app
from webapp.api.routers import vibe as vibe_router


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def fresh_mcp_session():
    """Each test starts unhandshaken so initialize behavior stays observable."""
    vibe_router._mcp._session_id = None
    yield
    vibe_router._mcp._session_id = None


class _FakeResponse:
    def __init__(self, payload: Any, status_code: int = 200,
                 headers: dict[str, str] | None = None, text: str | None = None):
        self._payload = payload
        self.status_code = status_code
        self.headers = headers or {"content-type": "application/json"}
        self.text = text if text is not None else json.dumps(payload)
        self.content = self.text.encode()

    def json(self) -> Any:
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"{self.status_code}", request=httpx.Request("GET", "http://t"),
                response=httpx.Response(self.status_code),
            )


class _FakeAsyncClient:
    """Stands in for httpx.AsyncClient; routes to a per-test handler."""

    calls: list[dict[str, Any]] = []
    handler = None  # type: ignore[assignment]

    def __init__(self, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, headers=None, params=None, **kw):
        record = {"method": "GET", "url": url, "headers": headers or {},
                  "params": params}
        _FakeAsyncClient.calls.append(record)
        return _FakeAsyncClient.handler(record)

    async def post(self, url, json=None, headers=None, **kw):
        record = {"method": "POST", "url": url, "json": json,
                  "headers": headers or {}}
        _FakeAsyncClient.calls.append(record)
        return _FakeAsyncClient.handler(record)


@pytest.fixture(autouse=True)
def fake_httpx(monkeypatch):
    _FakeAsyncClient.calls = []
    _FakeAsyncClient.handler = lambda record: _FakeResponse({"ok": True})
    monkeypatch.setattr(vibe_router.httpx, "AsyncClient", _FakeAsyncClient)
    yield
    _FakeAsyncClient.handler = None


def _mcp_handler(tool_result: dict[str, Any]):
    """A vibe-mcp that handshakes and answers one tools/call."""

    def handle(record: dict[str, Any]) -> _FakeResponse:
        body = record.get("json") or {}
        method = body.get("method")
        if method == "initialize":
            return _FakeResponse(
                {"jsonrpc": "2.0", "id": body["id"],
                 "result": {"protocolVersion": "2025-03-26"}},
                headers={"content-type": "application/json",
                         "mcp-session-id": "sess-1"},
            )
        if method == "notifications/initialized":
            return _FakeResponse(None, status_code=202, text="")
        if method == "tools/call":
            return _FakeResponse(
                {"jsonrpc": "2.0", "id": body["id"], "result": tool_result})
        if method == "tools/list":
            return _FakeResponse(
                {"jsonrpc": "2.0", "id": body["id"], "result": {"tools": [
                    {"name": "alpha_zoo"}, {"name": "write_file"},
                    {"name": "trading_positions"},
                ]}})
        raise AssertionError(f"unexpected MCP method {method}")

    return handle


# ── REST allowlist ─────────────────────────────────────────────────────────

def test_health_maps_reachable(client):
    assert client.get("/api/vibe/health").json() == {"status": "ok"}


def test_rest_allowlisted_path_forwards(client):
    _FakeAsyncClient.handler = lambda r: _FakeResponse({"alphas": []})
    response = client.get("/api/vibe/alpha/list")
    assert response.status_code == 200
    assert response.json() == {"alphas": []}
    assert _FakeAsyncClient.calls[0]["url"].endswith("/alpha/list")


@pytest.mark.parametrize("path", [
    "live/status", "live/runner/start", "mandate/commit",
    "sessions", "system/shutdown", "upload", "channels/status",
])
def test_rest_non_allowlisted_is_404_without_forwarding(client, path):
    response = client.get(f"/api/vibe/{path}")
    assert response.status_code == 404
    assert _FakeAsyncClient.calls == []


def test_rest_post_never_forwards(client):
    # The catch-all route is GET-only; POST to an allowlisted path must not
    # reach the sidecar either.
    response = client.post("/api/vibe/alpha/list", json={})
    assert response.status_code == 405
    assert _FakeAsyncClient.calls == []


def test_bearer_token_reaches_sidecar(client, monkeypatch):
    settings = vibe_router.get_settings()
    monkeypatch.setattr(settings, "vibe_api_token", "sekrit")
    client.get("/api/vibe/health")
    assert _FakeAsyncClient.calls[0]["headers"]["Authorization"] == "Bearer sekrit"


def test_rest_error_status_passes_through(client):
    _FakeAsyncClient.handler = lambda r: _FakeResponse(
        {"detail": "nope"}, status_code=403)
    assert client.get("/api/vibe/runs").status_code == 403


def test_unreachable_sidecar_reports_status(client):
    def boom(record):
        raise httpx.ConnectError("down")
    _FakeAsyncClient.handler = boom
    body = client.get("/api/vibe/health").json()
    assert body["status"] == "unreachable"


def test_rest_html_report_passes_through_unwrapped(client):
    _FakeAsyncClient.handler = lambda r: _FakeResponse(
        None, headers={"content-type": "text/html; charset=utf-8"},
        text="<html><body>report</body></html>")
    response = client.get("/api/vibe/shadow-reports/sh_1?format=html")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "report" in response.text
    # The format query param must reach the sidecar.
    assert _FakeAsyncClient.calls[0].get("params") == {"format": "html"}


# ── Journal upload ─────────────────────────────────────────────────────────

def test_journal_upload_forwards_to_vibe(client):
    _FakeAsyncClient.handler = lambda r: _FakeResponse(
        {"status": "ok", "file_path": "uploads/journal.csv",
         "filename": "journal.csv"})
    response = client.post(
        "/api/vibe/journal?filename=journal.csv",
        content=b"symbol,side\nAAPL,buy\n")
    assert response.status_code == 200
    assert response.json()["file_path"] == "uploads/journal.csv"
    assert _FakeAsyncClient.calls[0]["url"].endswith("/upload")


def test_journal_upload_rejects_non_journal_extension(client):
    response = client.post(
        "/api/vibe/journal?filename=evil.exe", content=b"MZ")
    assert response.status_code == 400
    assert _FakeAsyncClient.calls == []


# ── MCP allowlist + client ─────────────────────────────────────────────────

def test_mcp_call_denied_tool_is_404_without_network(client):
    for tool in ("write_file", "read_file", "bash", "web_search", "run_swarm"):
        response = client.post("/api/vibe/mcp/call",
                               json={"tool": tool, "arguments": {}})
        assert response.status_code == 404, tool
    assert _FakeAsyncClient.calls == []


def test_mcp_call_handshakes_then_returns_structured_content(client):
    _FakeAsyncClient.handler = _mcp_handler(
        {"content": [{"type": "text", "text": "ignored"}],
         "structuredContent": {"factors": [1, 2]}})
    response = client.post("/api/vibe/mcp/call",
                           json={"tool": "alpha_zoo", "arguments": {"q": "mom"}})
    assert response.status_code == 200
    assert response.json() == {"tool": "alpha_zoo", "result": {"factors": [1, 2]}}
    methods = [c["json"]["method"] for c in _FakeAsyncClient.calls if c["json"]]
    assert methods == ["initialize", "notifications/initialized", "tools/call"]
    # Session id from the handshake is echoed on the tool call.
    assert _FakeAsyncClient.calls[-1]["headers"]["mcp-session-id"] == "sess-1"


def test_mcp_call_unwraps_fastmcp_string_result(client):
    # FastMCP shape for tools returning str: structuredContent {"result": "..."}
    _FakeAsyncClient.handler = _mcp_handler(
        {"structuredContent": {"result": '{"ok": true, "data": {"count": 1}}'}})
    response = client.post("/api/vibe/mcp/call",
                           json={"tool": "search_symbol",
                                 "arguments": {"query": "AAPL"}})
    assert response.json()["result"] == {"ok": True, "data": {"count": 1}}


def test_mcp_call_parses_text_json_fallback(client):
    _FakeAsyncClient.handler = _mcp_handler(
        {"content": [{"type": "text", "text": '{"price": 1.5}'}]})
    response = client.post("/api/vibe/mcp/call",
                           json={"tool": "trading_quote",
                                 "arguments": {"symbol": "AAPL"}})
    assert response.json()["result"] == {"price": 1.5}


def test_mcp_call_parses_sse_body(client):
    def handle(record):
        body = record.get("json") or {}
        method = body.get("method")
        if method == "initialize":
            return _FakeResponse(
                {"jsonrpc": "2.0", "id": body["id"], "result": {}},
                headers={"content-type": "application/json",
                         "mcp-session-id": "sess-2"})
        if method == "notifications/initialized":
            return _FakeResponse(None, status_code=202, text="")
        payload = {"jsonrpc": "2.0", "id": body["id"], "result": {
            "content": [{"type": "text", "text": '{"rows": 3}'}]}}
        return _FakeResponse(
            payload, headers={"content-type": "text/event-stream"},
            text=f"event: message\ndata: {json.dumps(payload)}\n\n")
    _FakeAsyncClient.handler = handle
    response = client.post("/api/vibe/mcp/call",
                           json={"tool": "screen_market", "arguments": {}})
    assert response.json()["result"] == {"rows": 3}


def test_mcp_tool_error_becomes_502(client):
    _FakeAsyncClient.handler = _mcp_handler(
        {"isError": True, "content": [{"type": "text", "text": "no data"}]})
    response = client.post("/api/vibe/mcp/call",
                           json={"tool": "get_market_data", "arguments": {}})
    assert response.status_code == 502
    assert "no data" in response.json()["detail"]


def test_mcp_tools_endpoint_filters_to_allowlist(client):
    _FakeAsyncClient.handler = _mcp_handler({})
    response = client.get("/api/vibe/mcp/tools")
    names = [t["name"] for t in response.json()["tools"]]
    assert names == ["alpha_zoo", "trading_positions"]  # write_file filtered


def test_expired_session_reinitializes_once(client):
    state = {"initialized": 0}

    def handle(record):
        body = record.get("json") or {}
        method = body.get("method")
        if method == "initialize":
            state["initialized"] += 1
            return _FakeResponse(
                {"jsonrpc": "2.0", "id": body["id"], "result": {}},
                headers={"content-type": "application/json",
                         "mcp-session-id": f"sess-{state['initialized']}"})
        if method == "notifications/initialized":
            return _FakeResponse(None, status_code=202, text="")
        # First tools/call on a stale session 404s; after re-init it works.
        if record["headers"].get("mcp-session-id") == "stale":
            return _FakeResponse({}, status_code=404)
        return _FakeResponse(
            {"jsonrpc": "2.0", "id": body["id"],
             "result": {"structuredContent": {"ok": True}}})

    vibe_router._mcp._session_id = "stale"
    _FakeAsyncClient.handler = handle
    response = client.post("/api/vibe/mcp/call",
                           json={"tool": "list_runs", "arguments": {}})
    assert response.status_code == 200
    assert state["initialized"] == 1
