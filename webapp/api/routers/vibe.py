"""Whitelist proxy to the Vibe-Trading sidecar (compose: vibe-api / vibe-mcp).

The sidecar's feature surface lives in two places and this router bridges both:

* **REST** (``vibe-api``, :8000) — health, alpha runs, shadow reports. Forwarded
  GET-only, path-prefix allowlisted.
* **MCP** (``vibe-mcp``, :8900) — the real feature surface: Alpha Zoo, market
  data, read-only broker views, paper checks, shadow-account tools. Called via
  streamable-HTTP JSON-RPC, tool-name allowlisted.

Both allowlists are the live-trading kill seam: nothing under ``live/`` or
``mandate/`` is forwarded, and no order-placing MCP tool is callable, so live
execution stays impossible through this API until those lists are deliberately
widened. Vibe's own mandate gates are a second layer behind this one.

Auth: vibe rejects non-loopback callers unless API_AUTH_KEY is set, and this
process reaches it over the docker network — so ``vibe_api_token`` (webapp/.env
VIBE_API_TOKEN) must hold the same key, sent as a Bearer header. The token
never reaches the browser; the UI only ever talks to this proxy.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from ..config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter()

_TIMEOUT = httpx.Timeout(60.0, connect=5.0)

# REST paths forwarded verbatim (GET only). Deliberately absent: live/*,
# mandate/*, sessions/*, system/*, channels/* — the embedded Vibe UI talks to
# the sidecar directly for those; this proxy only serves AION's own pages.
_REST_GET_PREFIXES = (
    "health",
    "alpha/",
    "runs",
    "shadow-reports/",
    "skills",
    "swarm/presets",
    # The five bundled research playbooks, listed by Agents & Skills. GET-only
    # and read-only, so this stays inside the read + paper mandate above --
    # scheduling one is a POST and remains unreachable.
    "scheduled-runs/playbooks",
)

# MCP tools AION pages may call. Vibe's MCP server is read-only by design
# (shell tools off by default), but the allowlist keeps that guarantee local:
# file/url/shell tools and anything order-shaped stays uncallable even if the
# pinned upstream version ever changes its mind.
_MCP_ALLOWED_TOOLS = frozenset({
    # Alpha Zoo / research
    "alpha_zoo", "alpha_bench", "factor_analysis", "pattern_recognition",
    "backtest", "list_runs", "get_run_result",
    # Market / fundamental data
    "search_symbol", "get_market_data", "get_stock_profile",
    "get_financial_statements", "get_options_chain", "get_sec_filings",
    "get_stock_news", "get_research_reports", "screen_market",
    "get_macro_series", "get_sector_info", "get_fund_flow",
    "analyze_options", "analyze_options_payoff",
    # Broker read-only + pre-trade checks (no order placement exists here)
    "trading_connections", "trading_select_connection", "trading_account",
    "trading_positions", "trading_orders", "trading_history",
    "trading_quote", "trading_check",
    # Shadow accounts (journal-driven: analyze parses the uploaded export,
    # extract derives the rules — see the /vibe/journal endpoint below)
    "analyze_trade_journal", "extract_shadow_strategy", "run_shadow_backtest",
    "scan_shadow_signals", "render_shadow_report",
})

_MCP_PROTOCOL_VERSION = "2025-03-26"


def _auth_headers() -> dict[str, str]:
    token = get_settings().vibe_api_token
    return {"Authorization": f"Bearer {token}"} if token else {}


# ---------------------------------------------------------------------------
# MCP client (streamable HTTP, JSON-RPC)
# ---------------------------------------------------------------------------

class _McpError(RuntimeError):
    """The MCP server answered with a JSON-RPC error or a failed tool call."""


class _McpSessionExpired(RuntimeError):
    """The server no longer knows our session id; re-initialize and retry."""


class _McpClient:
    """Minimal streamable-HTTP MCP client: initialize once, then tools/call.

    Deliberately not the ``mcp`` SDK: the qlib image doesn't ship it, the
    protocol subset needed here is three request shapes, and httpx is already
    a pinned dependency (chat.py). The session id is cached process-wide; an
    expired session (server restart) is re-initialized transparently once.
    """

    def __init__(self) -> None:
        self._session_id: str | None = None
        self._request_id = 0
        self._lock = asyncio.Lock()

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        async with self._lock:
            for attempt in (1, 2):
                try:
                    if self._session_id is None:
                        await self._initialize()
                    result = await self._rpc(
                        "tools/call", {"name": name, "arguments": arguments}
                    )
                    break
                except _McpSessionExpired:
                    self._session_id = None
                    if attempt == 2:
                        raise
        if result.get("isError"):
            raise _McpError(_text_of(result) or f"tool {name} failed")
        return _payload_of(result)

    async def list_tools(self) -> list[dict[str, Any]]:
        async with self._lock:
            for attempt in (1, 2):
                try:
                    if self._session_id is None:
                        await self._initialize()
                    result = await self._rpc("tools/list", {})
                    return result.get("tools", [])
                except _McpSessionExpired:
                    self._session_id = None
                    if attempt == 2:
                        raise
        return []

    async def _initialize(self) -> None:
        init = await self._post({
            "jsonrpc": "2.0", "id": self._next_id(), "method": "initialize",
            "params": {
                "protocolVersion": _MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "aion-qlib", "version": "1.0"},
            },
        }, expect_session=True)
        if "error" in init:
            raise _McpError(str(init["error"]))
        # Spec: the notification completes the handshake; no response expected.
        await self._post({
            "jsonrpc": "2.0", "method": "notifications/initialized"
        }, notification=True)

    async def _rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        message = await self._post({
            "jsonrpc": "2.0", "id": self._next_id(),
            "method": method, "params": params,
        })
        if "error" in message:
            raise _McpError(str(message["error"]))
        return message.get("result", {})

    async def _post(
        self,
        body: dict[str, Any],
        *,
        expect_session: bool = False,
        notification: bool = False,
    ) -> dict[str, Any]:
        headers = {
            "Content-Type": "application/json",
            # The spec requires advertising both; the server picks.
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": _MCP_PROTOCOL_VERSION,
            **_auth_headers(),
        }
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
        url = get_settings().vibe_mcp_url
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(url, json=body, headers=headers)
        if response.status_code == 404 and self._session_id:
            raise _McpSessionExpired()
        if expect_session:
            self._session_id = response.headers.get("mcp-session-id")
        if notification:
            return {}
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if content_type.startswith("text/event-stream"):
            return _last_data_message(response.text)
        return response.json()

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id


def _last_data_message(sse_text: str) -> dict[str, Any]:
    """Return the last JSON-RPC message in an SSE body (the call's response)."""
    message: dict[str, Any] = {}
    for line in sse_text.splitlines():
        if line.startswith("data:"):
            try:
                message = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
    return message


def _text_of(result: dict[str, Any]) -> str:
    parts = [
        block.get("text", "")
        for block in result.get("content", [])
        if block.get("type") == "text"
    ]
    return "\n".join(p for p in parts if p)


def _payload_of(result: dict[str, Any]) -> Any:
    """Prefer structured output; fall back to parsing the text block."""
    structured = result.get("structuredContent")
    if structured is not None:
        # FastMCP wraps tools returning a plain string as {"result": "<str>"},
        # and vibe's tools answer with JSON strings — unwrap to a real object.
        if (
            isinstance(structured, dict)
            and set(structured) == {"result"}
            and isinstance(structured["result"], str)
        ):
            try:
                return json.loads(structured["result"])
            except json.JSONDecodeError:
                return structured["result"]
        return structured
    text = _text_of(result)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


_mcp = _McpClient()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

class McpCallRequest(BaseModel):
    tool: str
    arguments: dict[str, Any] = Field(default_factory=dict)


@router.get("/vibe/health")
async def vibe_health() -> dict[str, Any]:
    """Reachability of the sidecar, shaped like the qlib /health endpoint."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.get(
                f"{get_settings().vibe_api_url}/health", headers=_auth_headers()
            )
        response.raise_for_status()
        return {"status": "ok"}
    except httpx.HTTPError as exc:
        return {"status": "unreachable", "detail": str(exc)}


@router.get("/vibe/mcp/tools")
async def vibe_mcp_tools() -> dict[str, Any]:
    """The allowlisted subset of the sidecar's MCP tool catalog.

    Reports both sides of the filter. Returning only the allowlisted tools made
    the subset look like the whole catalogue -- a page listing them could say
    "these are the tools" when the honest claim is "these are the N of M this
    app may call, and the rest are file, shell and order-shaped paths the proxy
    refuses".
    """
    try:
        tools = await _mcp.list_tools()
    except (httpx.HTTPError, _McpError, _McpSessionExpired) as exc:
        raise HTTPException(status_code=502, detail=f"vibe-mcp: {exc}")
    allowed = [t for t in tools if t.get("name") in _MCP_ALLOWED_TOOLS]
    return {
        "tools": allowed,
        "total": len(tools),
        "withheld": len(tools) - len(allowed),
    }


@router.post("/vibe/mcp/call")
async def vibe_mcp_call(body: McpCallRequest) -> dict[str, Any]:
    if body.tool not in _MCP_ALLOWED_TOOLS:
        raise HTTPException(
            status_code=404, detail=f"Tool not available: {body.tool}"
        )
    try:
        result = await _mcp.call_tool(body.tool, body.arguments)
    except _McpError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except (httpx.HTTPError, _McpSessionExpired) as exc:
        raise HTTPException(status_code=502, detail=f"vibe-mcp: {exc}")
    return {"tool": body.tool, "result": result}


# Trade-journal exports only: vibe's shadow-account extractor reads roundtrips
# from a CSV/Excel broker export it can reach on its own filesystem, so the
# file goes through vibe's /upload and the returned path feeds
# extract_shadow_strategy. Deliberately not a general upload passthrough.
_JOURNAL_EXTENSIONS = (".csv", ".xls", ".xlsx")


# Raw body + filename query param rather than multipart: the qlib image ships
# no python-multipart, and one file with one name doesn't need form framing.
@router.post("/vibe/journal")
async def vibe_journal_upload(request: Request, filename: str) -> dict[str, Any]:
    name = filename.strip()
    if not name.lower().endswith(_JOURNAL_EXTENSIONS):
        raise HTTPException(
            status_code=400,
            detail="Journal must be a .csv, .xls or .xlsx broker export",
        )
    content = await request.body()
    if not content:
        raise HTTPException(status_code=400, detail="Empty journal file")
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(
                f"{get_settings().vibe_api_url}/upload",
                files={"file": (name, content, "application/octet-stream")},
                headers=_auth_headers(),
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"vibe-api: {exc}")
    try:
        payload: Any = response.json()
    except json.JSONDecodeError:
        payload = {"detail": response.text}
    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code,
                            detail=payload.get("detail", payload))
    return payload


@router.get("/vibe/{path:path}")
async def vibe_rest(path: str, request: Request) -> Response:
    """GET-only passthrough for the REST allowlist; everything else is 404."""
    if not path.startswith(_REST_GET_PREFIXES):
        raise HTTPException(status_code=404, detail="Not proxied")
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.get(
                f"{get_settings().vibe_api_url}/{path}",
                params=dict(request.query_params),
                headers=_auth_headers(),
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"vibe-api: {exc}")
    content_type = response.headers.get("content-type", "")
    if content_type.startswith("application/json"):
        try:
            payload: Any = response.json()
        except json.JSONDecodeError:
            payload = {"detail": response.text}
        return JSONResponse(status_code=response.status_code, content=payload)
    # Shadow reports come back as HTML/PDF — hand them through unwrapped so
    # the page can iframe/download them from a same-origin URL.
    return Response(
        content=response.content,
        status_code=response.status_code,
        media_type=content_type or "application/octet-stream",
    )
