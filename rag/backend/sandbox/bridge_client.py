"""Bridge client for sandbox tool access."""
import json
import os
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError


class ToolClient:
    """Client for calling tools via the HTTP bridge from within the sandbox."""

    def __init__(self):
        self._url = os.environ.get("BRIDGE_URL", "")
        self._token = os.environ.get("BRIDGE_TOKEN", "")

    def call(self, tool_name: str, **kwargs) -> dict:
        """Call a tool by name with keyword arguments. Returns result dict."""
        if not self._url or not self._token:
            return {"error": "bridge_not_configured", "message": "BRIDGE_URL or BRIDGE_TOKEN not set"}
        body = json.dumps({
            "tool_name": tool_name,
            "arguments": kwargs,
            "session_token": self._token,
        }).encode("utf-8")
        req = Request(
            f"{self._url}/bridge/call",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("result", data)
        except HTTPError as e:
            try:
                err_body = json.loads(e.read().decode("utf-8"))
                return {"error": "bridge_http_error", "status": e.code, "message": err_body.get("detail", str(e))}
            except Exception:
                return {"error": "bridge_http_error", "status": e.code, "message": str(e)}
        except URLError as e:
            return {"error": "bridge_connection_error", "message": str(e.reason)}
        except Exception as e:
            return {"error": "bridge_error", "message": str(e)}

    def search(self, query: str) -> list:
        """Search for tools by keyword. Returns list of tool info dicts."""
        if not self._url or not self._token:
            return []
        req = Request(
            f"{self._url}/bridge/catalog?session_token={self._token}",
            method="GET",
        )
        try:
            with urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                tools = data.get("tools", [])
                query_lower = query.lower()
                return [t for t in tools if query_lower in t.get("name", "").lower() or query_lower in t.get("description", "").lower()]
        except Exception:
            return []

    def list_tools(self) -> list:
        """List all available tool names."""
        if not self._url or not self._token:
            return []
        req = Request(
            f"{self._url}/bridge/catalog?session_token={self._token}",
            method="GET",
        )
        try:
            with urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return [t["name"] for t in data.get("tools", [])]
        except Exception:
            return []


# Module-level client instance
tool_client = ToolClient()
