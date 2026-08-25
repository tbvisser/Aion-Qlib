"""Streamable-HTTP MCP server for Aion qlib tools."""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from webapp.api.config import get_settings
from webapp.api.mcp_allowlist import assert_allowlist_consistency

from .auth import authorize_request
from .tools import call_tool, mcp_tool_catalog, resolve_principal, set_mcp_principal

logger = logging.getLogger(__name__)

MCP_PROTOCOL_VERSION = "2025-03-26"

_sessions: dict[str, dict[str, Any]] = {}


def create_app() -> FastAPI:
    assert_allowlist_consistency()

    app = FastAPI(title="Aion MCP", version="0.1.0")

    @app.get("/health")
    def health() -> dict[str, Any]:
        catalog = mcp_tool_catalog()
        return {"status": "ok", "tools": len(catalog), "protocol": MCP_PROTOCOL_VERSION}

    @app.post("/mcp")
    async def mcp_endpoint(request: Request) -> Response:
        settings = get_settings()
        auth = authorize_request(request, settings.aion_mcp_token)
        if auth.principal is not None:
            set_mcp_principal(auth.principal)
        elif auth.mode == "service":
            from .tools import resolve_principal as _resolve

            set_mcp_principal(_resolve())
        else:
            set_mcp_principal(None)

        try:
            body = await request.json()
        except json.JSONDecodeError as exc:
            return _jsonrpc_error(None, -32700, f"Parse error: {exc}")

        if not isinstance(body, dict):
            return _jsonrpc_error(None, -32600, "Invalid Request")

        method = body.get("method")
        if method is None:
            return _jsonrpc_error(body.get("id"), -32600, "Invalid Request")

        # Notifications have no id and need no JSON-RPC response body.
        if body.get("id") is None and method.startswith("notifications/"):
            if method == "notifications/initialized":
                return Response(status_code=202)
            return Response(status_code=202)

        session_id = request.headers.get("mcp-session-id")
        params = body.get("params") or {}

        if method == "initialize":
            return _handle_initialize(body.get("id"), params)

        if not session_id or session_id not in _sessions:
            return _jsonrpc_error(body.get("id"), -32000, "Session expired or missing")

        if method == "tools/list":
            return _jsonrpc_result(body.get("id"), {"tools": mcp_tool_catalog()})

        if method == "tools/call":
            name = params.get("name", "")
            arguments = params.get("arguments") or {}
            if not isinstance(arguments, dict):
                return _jsonrpc_error(body.get("id"), -32602, "arguments must be an object")
            payload = call_tool(name, arguments)
            is_error = isinstance(payload, dict) and "error" in payload
            return _jsonrpc_result(
                body.get("id"),
                _tool_result(payload, is_error=is_error),
            )

        return _jsonrpc_error(body.get("id"), -32601, f"Method not found: {method}")

    return app


def _handle_initialize(request_id: Any, params: dict[str, Any]) -> JSONResponse:
    protocol = params.get("protocolVersion", MCP_PROTOCOL_VERSION)
    session_id = str(uuid.uuid4())
    _sessions[session_id] = {"protocol": protocol}

    result = {
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {"tools": {"listChanged": False}},
        "serverInfo": {"name": "aion-mcp", "version": "0.1.0"},
    }
    response = JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": result})
    response.headers["mcp-session-id"] = session_id
    return response


def _tool_result(payload: Any, *, is_error: bool) -> dict[str, Any]:
    text = json.dumps(payload, default=str)
    return {
        "content": [{"type": "text", "text": text}],
        "structuredContent": payload,
        "isError": is_error,
    }


def _jsonrpc_result(request_id: Any, result: dict[str, Any]) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": result})


def _jsonrpc_error(request_id: Any, code: int, message: str) -> JSONResponse:
    return JSONResponse({
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    })
