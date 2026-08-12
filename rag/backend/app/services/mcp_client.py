"""MCP client service for connecting to external MCP servers."""
import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, Optional

from dotenv import dotenv_values

from app.services.langsmith import traceable

logger = logging.getLogger(__name__)


def _build_subprocess_env() -> dict[str, str]:
    """Build environment dict for MCP subprocesses.

    Merges os.environ with variables from .env so that tokens like
    GITHUB_PERSONAL_ACCESS_TOKEN (which pydantic-settings reads but
    does NOT inject into os.environ) are available to child processes.
    """
    env = dict(os.environ)
    dotenv_path = Path(__file__).resolve().parents[2] / ".env"
    if dotenv_path.exists():
        env.update({k: v for k, v in dotenv_values(dotenv_path).items() if v})
    return env


class MCPHttpServerConnection:
    """A single MCP server reached over streamable HTTP (JSON-RPC POSTs).

    Raw httpx rather than the ``mcp`` SDK: the SDK is not in this image's
    requirements (the stdio class below imports it lazily and no stdio server
    has been configured so far), while httpx is already a pinned dependency.
    The protocol subset needed — initialize, tools/list, tools/call — is three
    request shapes. First consumer: the Vibe-Trading sidecar at
    ``http://vibe-mcp:8900/mcp`` (see MCP_SERVERS in .env).

    ``include`` filters discovery: entries are exact tool names, or prefixes
    when ending with ``*`` (``trading_*``). The vibe server exposes 65 tools
    against a ``catalog_max_tools`` of 50, so an unfiltered connect would
    flood the catalog.
    """

    _PROTOCOL_VERSION = "2025-03-26"

    def __init__(self, name: str, url: str, include: Optional[list[str]] = None):
        self.name = name
        self.url = url
        self.include = include or []
        self._session_id: Optional[str] = None
        self._request_id = 0
        self._lock = asyncio.Lock()
        self.tools: dict[str, dict] = {}
        self.connected = False

    def _wanted(self, tool_name: str) -> bool:
        if not self.include:
            return True
        for pattern in self.include:
            if pattern.endswith("*"):
                if tool_name.startswith(pattern[:-1]):
                    return True
            elif tool_name == pattern:
                return True
        return False

    async def connect(self) -> list[dict]:
        """Handshake, discover tools, return the (filtered) tool list."""
        import httpx

        try:
            async with self._lock:
                await self._initialize()
                result = await self._rpc("tools/list", {})
            discovered = []
            for tool in result.get("tools", []):
                if not self._wanted(tool.get("name", "")):
                    continue
                tool_info = {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "input_schema": tool.get("inputSchema", {}),
                }
                self.tools[tool["name"]] = tool_info
                discovered.append(tool_info)
            self.connected = True
            logger.info(
                f"MCP server '{self.name}' connected over http: "
                f"{len(discovered)} tools kept of {len(result.get('tools', []))}"
            )
            return discovered
        except (httpx.HTTPError, RuntimeError, KeyError) as e:
            logger.error(f"Failed to connect to MCP server '{self.name}': {e}")
            self.connected = False
            self._session_id = None
            raise

    @traceable(name="mcp_client.call_tool", run_type="tool")
    async def call_tool(self, tool_name: str, arguments: dict) -> str:
        """Call a tool; returns text for the LLM, errors as JSON strings."""
        import httpx

        if not self.connected:
            return json.dumps({
                "error": "not_connected",
                "message": f"MCP server '{self.name}' is not connected",
            })
        try:
            async with self._lock:
                try:
                    result = await self._rpc(
                        "tools/call", {"name": tool_name, "arguments": arguments}
                    )
                except _McpSessionExpired:
                    # Server restarted; one transparent re-handshake.
                    self._session_id = None
                    await self._initialize()
                    result = await self._rpc(
                        "tools/call", {"name": tool_name, "arguments": arguments}
                    )
        except (httpx.HTTPError, RuntimeError) as e:
            logger.error(f"MCP tool call failed: {self.name}/{tool_name}: {e}")
            return json.dumps({"error": "mcp_call_failed", "message": str(e)})

        parts = [
            block.get("text", "")
            for block in result.get("content", [])
            if block.get("type") == "text"
        ]
        text = "\n".join(p for p in parts if p)
        if not text and result.get("structuredContent") is not None:
            text = json.dumps(result["structuredContent"])
        if result.get("isError"):
            return json.dumps({"error": "mcp_tool_error", "message": text})
        return text

    async def _initialize(self) -> None:
        init = await self._post({
            "jsonrpc": "2.0", "id": self._next_id(), "method": "initialize",
            "params": {
                "protocolVersion": self._PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "aion-rag", "version": "1.0"},
            },
        }, expect_session=True)
        if "error" in init:
            raise RuntimeError(f"MCP initialize failed: {init['error']}")
        await self._post(
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            notification=True,
        )

    async def _rpc(self, method: str, params: dict) -> dict:
        message = await self._post({
            "jsonrpc": "2.0", "id": self._next_id(),
            "method": method, "params": params,
        })
        if "error" in message:
            raise RuntimeError(f"MCP {method} error: {message['error']}")
        return message.get("result", {})

    async def _post(
        self,
        body: dict,
        *,
        expect_session: bool = False,
        notification: bool = False,
    ) -> dict:
        import httpx

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": self._PROTOCOL_VERSION,
        }
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=5.0)) as client:
            response = await client.post(self.url, json=body, headers=headers)
        if response.status_code == 404 and self._session_id:
            raise _McpSessionExpired()
        if expect_session:
            self._session_id = response.headers.get("mcp-session-id")
        if notification:
            return {}
        response.raise_for_status()
        if response.headers.get("content-type", "").startswith("text/event-stream"):
            message: dict = {}
            for line in response.text.splitlines():
                if line.startswith("data:"):
                    try:
                        message = json.loads(line[5:].strip())
                    except json.JSONDecodeError:
                        continue
            return message
        return response.json()

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    async def disconnect(self):
        self._session_id = None
        self.connected = False
        self.tools.clear()
        logger.info(f"MCP server '{self.name}' disconnected")


class _McpSessionExpired(RuntimeError):
    """The HTTP MCP server no longer recognises our session id."""


class MCPServerConnection:
    """Manages a single MCP server connection via stdio transport."""

    def __init__(self, name: str, command: str, args: list[str]):
        self.name = name
        self.command = command
        self.args = args
        self._session = None
        self._client = None
        self._exit_stack = None
        self.tools: dict[str, dict] = {}
        self.connected = False

    async def connect(self) -> list[dict]:
        """Connect to the MCP server, discover tools, return tool list."""
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client

            server_params = StdioServerParameters(
                command=self.command,
                args=self.args,
                env=_build_subprocess_env(),
            )

            # Use contextlib to manage the async context managers
            import contextlib
            self._exit_stack = contextlib.AsyncExitStack()
            await self._exit_stack.__aenter__()

            stdio_transport = await self._exit_stack.enter_async_context(
                stdio_client(server_params)
            )
            read_stream, write_stream = stdio_transport

            self._session = await self._exit_stack.enter_async_context(
                ClientSession(read_stream, write_stream)
            )

            await self._session.initialize()

            # Discover tools
            tools_result = await self._session.list_tools()
            discovered = []
            for tool in tools_result.tools:
                tool_info = {
                    "name": tool.name,
                    "description": tool.description or "",
                    "input_schema": tool.inputSchema if hasattr(tool, 'inputSchema') else {},
                }
                self.tools[tool.name] = tool_info
                discovered.append(tool_info)

            self.connected = True
            logger.info(f"MCP server '{self.name}' connected: {len(discovered)} tools discovered")
            return discovered

        except Exception as e:
            logger.error(f"Failed to connect to MCP server '{self.name}': {e}")
            self.connected = False
            # Clean up exit_stack to avoid leaking subprocess/FDs
            if self._exit_stack:
                try:
                    await self._exit_stack.aclose()
                except Exception:
                    pass
                self._exit_stack = None
            raise

    @traceable(name="mcp_client.call_tool", run_type="tool")
    async def call_tool(self, tool_name: str, arguments: dict) -> str:
        """Call a tool on this MCP server."""
        if not self._session or not self.connected:
            return json.dumps({"error": "not_connected", "message": f"MCP server '{self.name}' is not connected"})

        try:
            result = await self._session.call_tool(tool_name, arguments)

            # Extract text content from MCP result
            parts = []
            for content in result.content:
                if hasattr(content, 'text'):
                    parts.append(content.text)
                elif hasattr(content, 'data'):
                    parts.append(str(content.data))
                else:
                    parts.append(str(content))

            return "\n".join(parts)

        except Exception as e:
            logger.error(f"MCP tool call failed: {self.name}/{tool_name}: {e}")
            return json.dumps({"error": "mcp_call_failed", "message": str(e)})

    async def disconnect(self):
        """Disconnect from the MCP server."""
        if self._exit_stack:
            try:
                await self._exit_stack.aclose()
            except Exception as e:
                logger.warning(f"Error disconnecting MCP server '{self.name}': {e}")
        self._session = None
        self.connected = False
        self.tools.clear()
        logger.info(f"MCP server '{self.name}' disconnected")


def convert_mcp_schema(mcp_tool: dict, server_name: str) -> dict:
    """Convert MCP tool schema to OpenAI function-calling format.

    Args:
        mcp_tool: Dict with 'name', 'description', 'input_schema'
        server_name: Name of the MCP server (used for namespacing)

    Returns:
        OpenAI function-calling tool schema dict
    """
    name = mcp_tool["name"]
    description = mcp_tool.get("description", f"MCP tool from {server_name}")
    input_schema = mcp_tool.get("input_schema", {})

    # MCP input_schema is already JSON Schema — map directly to OpenAI parameters
    parameters = {}
    if isinstance(input_schema, dict):
        parameters = {
            "type": input_schema.get("type", "object"),
            "properties": input_schema.get("properties", {}),
        }
        if "required" in input_schema:
            parameters["required"] = input_schema["required"]

    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        },
    }


class MCPClientManager:
    """Manages connections to multiple MCP servers."""

    def __init__(self):
        self._servers: dict[str, MCPServerConnection] = {}
        self._reconnect_tasks: dict[str, asyncio.Task] = {}

    async def initialize(self, mcp_servers_config: str) -> None:
        """Parse config and connect to all configured MCP servers.

        Config format: JSON array of objects with name, command, args fields.
        Example: '[{"name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}]'

        Entries with a "url" field connect over streamable HTTP instead of
        stdio, with an optional "include" tool filter (exact names, or
        prefixes ending in "*"):
        '[{"name":"vibe","url":"http://vibe-mcp:8900/mcp","include":["trading_*","alpha_zoo"]}]'

        Legacy format (deprecated): comma-separated "name:command:args" entries.
        Example: "github:npx:-y @modelcontextprotocol/server-github"
        """
        if not mcp_servers_config.strip():
            logger.info("No MCP servers configured")
            return

        from app.services.tool_registry import (
            get_tool_registry, ToolDefinition, ToolSource, ToolLoading,
        )

        registry = get_tool_registry()

        # Parse config — try JSON first, fall back to legacy colon-separated format
        server_configs = []
        stripped = mcp_servers_config.strip()
        if stripped.startswith("["):
            try:
                parsed = json.loads(stripped)
            except json.JSONDecodeError as e:
                logger.error(f"Invalid MCP servers JSON config: {e}")
                return
            for item in parsed:
                try:
                    if item.get("url"):
                        server_configs.append({
                            "name": item["name"],
                            "url": item["url"],
                            "include": item.get("include", []),
                            "loading": item.get("loading", "deferred"),
                        })
                    else:
                        server_configs.append({
                            "name": item["name"],
                            "command": item["command"],
                            "args": item.get("args", []),
                            "loading": item.get("loading", "deferred"),
                        })
                except (KeyError, TypeError) as e:
                    logger.warning(f"Skipping invalid MCP server config entry {item!r}: {e}")
        else:
            # Legacy colon-separated format (deprecated — doesn't support Windows paths or spaces)
            logger.warning("Using deprecated colon-separated MCP config format. Use JSON array instead.")
            for entry in stripped.split(","):
                entry = entry.strip()
                if not entry:
                    continue
                parts = entry.split(":", 2)
                if len(parts) < 2:
                    logger.warning(f"Invalid MCP server config: '{entry}' (expected name:command:args)")
                    continue
                name = parts[0].strip()
                command = parts[1].strip()
                args = parts[2].strip().split() if len(parts) > 2 else []
                server_configs.append({
                    "name": name, "command": command, "args": args,
                    "loading": "deferred",
                })

        for cfg in server_configs:
            name = cfg["name"]
            loading_mode = cfg["loading"]
            if cfg.get("url"):
                server = MCPHttpServerConnection(
                    name, cfg["url"], include=cfg.get("include") or None
                )
            else:
                server = MCPServerConnection(name, cfg["command"], cfg["args"])
            self._servers[name] = server

            try:
                discovered = await server.connect()

                # Register each tool in the unified registry
                for mcp_tool in discovered:
                    openai_schema = convert_mcp_schema(mcp_tool, name)
                    func_info = openai_schema.get("function", {})
                    tool_name = func_info.get("name", "")
                    description = func_info.get("description", "")

                    # One-liner for catalog
                    first_sentence = description.split(". ")[0].rstrip(".")
                    if len(first_sentence) > 100:
                        catalog_entry = first_sentence[:97].rsplit(" ", 1)[0] + "..."
                    else:
                        catalog_entry = first_sentence
                    catalog_entry = catalog_entry.replace("|", "\\|")

                    # Create executor that routes through this server
                    server_ref = server

                    def make_executor(srv, tn):
                        async def executor(tool_call: dict, user_id: str, redaction_svc=None) -> str:
                            args_str = tool_call.get("arguments", "{}")
                            arguments = json.loads(args_str) if isinstance(args_str, str) else args_str
                            return await srv.call_tool(tn, arguments)
                        return executor

                    executor = make_executor(server_ref, tool_name)

                    tool_loading = ToolLoading.immediate if loading_mode == "immediate" else ToolLoading.deferred
                    registry.register(ToolDefinition(
                        name=tool_name,
                        description=description,
                        source=ToolSource.mcp,
                        loading=tool_loading,
                        openai_schema=openai_schema,
                        catalog_entry=catalog_entry,
                        executor=executor,
                    ))

                logger.info(f"MCP server '{name}': registered {len(discovered)} tools")

            except Exception as e:
                logger.error(f"Failed to initialize MCP server '{name}': {e}")
                # Start reconnection in background
                self._start_reconnect(name, server)

    def _start_reconnect(self, name: str, server: MCPServerConnection):
        """Start a background reconnection task with exponential backoff."""
        # Cancel any existing reconnect task for this server
        existing = self._reconnect_tasks.get(name)
        if existing and not existing.done():
            existing.cancel()

        async def _reconnect():
            delay = 5
            max_delay = 300
            while True:
                await asyncio.sleep(delay)
                if server.connected:
                    logger.info(f"MCP server '{name}' already connected, stopping reconnect")
                    return
                try:
                    await server.connect()
                    logger.info(f"MCP server '{name}' reconnected successfully")
                    # Re-register tools after reconnect
                    from app.services.tool_registry import (
                        get_tool_registry, ToolDefinition, ToolSource, ToolLoading,
                    )
                    registry = get_tool_registry()
                    for mcp_tool in server.tools.values():
                        openai_schema = convert_mcp_schema(mcp_tool, name)
                        func_info = openai_schema.get("function", {})
                        tool_name = func_info.get("name", "")
                        description = func_info.get("description", "")
                        first_sentence = description.split(". ")[0].rstrip(".")
                        catalog_entry = first_sentence[:100].replace("|", "\\|")

                        server_ref = server

                        async def make_executor(srv, tn):
                            async def executor(tool_call: dict, user_id: str, redaction_svc=None) -> str:
                                args_str = tool_call.get("arguments", "{}")
                                arguments = json.loads(args_str) if isinstance(args_str, str) else args_str
                                return await srv.call_tool(tn, arguments)
                            return executor

                        executor = await make_executor(server_ref, tool_name)

                        registry.register(ToolDefinition(
                            name=tool_name,
                            description=description,
                            source=ToolSource.mcp,
                            loading=ToolLoading.deferred,
                            openai_schema=openai_schema,
                            catalog_entry=catalog_entry,
                            executor=executor,
                        ))
                    return
                except Exception as e:
                    logger.warning(f"MCP reconnect failed for '{name}': {e}, retrying in {delay}s")
                    delay = min(delay * 2, max_delay)

        task = asyncio.create_task(_reconnect())
        self._reconnect_tasks[name] = task

    async def call_tool(self, server_name: str, tool_name: str, arguments: dict) -> str:
        """Call a tool on a specific MCP server."""
        server = self._servers.get(server_name)
        if not server:
            return json.dumps({"error": "server_not_found", "message": f"MCP server '{server_name}' not configured"})
        if not server.connected:
            return json.dumps({"error": "server_disconnected", "message": f"MCP server '{server_name}' is not connected"})
        return await server.call_tool(tool_name, arguments)

    async def shutdown(self):
        """Disconnect all MCP servers and cancel reconnection tasks."""
        for name, task in self._reconnect_tasks.items():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        for name, server in self._servers.items():
            await server.disconnect()

        self._servers.clear()
        self._reconnect_tasks.clear()
        logger.info("All MCP servers shut down")


# Singleton
_manager: Optional[MCPClientManager] = None


def get_mcp_client_manager() -> MCPClientManager:
    global _manager
    if _manager is None:
        _manager = MCPClientManager()
    return _manager
