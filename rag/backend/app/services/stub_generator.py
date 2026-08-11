"""Generate Python stubs for sandbox tool access via HTTP bridge."""
import json
import re
from typing import Any


BRIDGE_CLIENT_CODE = '''"""Bridge client for sandbox tool access."""
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
            f"{self._url}/bridge/catalog",
            headers={"X-Bridge-Token": self._token},
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
            f"{self._url}/bridge/catalog",
            headers={"X-Bridge-Token": self._token},
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
'''


def generate_bridge_client() -> str:
    """Return the Python source for the bridge client module."""
    return BRIDGE_CLIENT_CODE


def _python_type(json_type: str) -> str:
    """Map JSON Schema type to Python type hint."""
    mapping = {
        "string": "str",
        "integer": "int",
        "number": "float",
        "boolean": "bool",
        "array": "list",
        "object": "dict",
    }
    return mapping.get(json_type, "Any")


def generate_stubs(tools: list[dict[str, Any]]) -> str:
    """Generate typed Python wrapper functions for a list of tool schemas.

    Each tool schema should be an OpenAI function-calling format dict.
    Returns Python source code that can be written to a file.
    """
    lines = [
        '"""Auto-generated tool stubs for sandbox use."""',
        "from bridge_client import tool_client",
        "",
    ]

    for tool_schema in tools:
        func = tool_schema.get("function", {})
        name = func.get("name", "")
        if not name:
            continue
        # Sanitize tool name to valid Python identifier
        safe_name = re.sub(r'[^a-zA-Z0-9_]', '_', name)
        if safe_name[0:1].isdigit():
            safe_name = f"_{safe_name}"

        description = func.get("description", "")
        params = func.get("parameters", {})
        properties = params.get("properties", {})
        required = set(params.get("required", []))

        # Build function signature with sanitized parameter names.
        # Required params must come before optional params to avoid SyntaxError.
        required_parts = []
        optional_parts = []
        # Map original param name -> safe Python identifier
        param_name_map: dict[str, str] = {}
        for pname in properties:
            safe_pname = re.sub(r'[^a-zA-Z0-9_]', '_', pname)
            if safe_pname[0:1].isdigit():
                safe_pname = f"_{safe_pname}"
            param_name_map[pname] = safe_pname

        for pname, pschema in properties.items():
            safe_pname = param_name_map[pname]
            ptype = _python_type(pschema.get("type", "string"))
            if pname in required:
                required_parts.append(f"{safe_pname}: {ptype}")
            else:
                default = "None"
                if ptype == "str":
                    default = '""'
                elif ptype == "int":
                    default = "0"
                elif ptype == "float":
                    default = "0.0"
                elif ptype == "bool":
                    default = "False"
                elif ptype in ("list", "dict"):
                    default = "None"
                type_hint = f"{ptype} | None" if default == "None" else ptype
                optional_parts.append(f"{safe_pname}: {type_hint} = {default}")

        sig = ", ".join(required_parts + optional_parts)

        # Build kwargs for the call
        kwargs_parts = []
        for pname in properties:
            safe_pname = param_name_map[pname]
            kwargs_parts.append(f"{safe_pname}={safe_pname}")
        kwargs = ", ".join(kwargs_parts)

        # Filter out None optional params
        optional_params = [p for p in properties if p not in required]

        lines.append(f"def {safe_name}({sig}) -> str:")
        if description:
            short_desc = description.split(". ")[0].rstrip(".")
            lines.append(f'    """{short_desc}.')
            lines.append(f'')
            lines.append(f'    Returns a string. Use json.loads() if the result is JSON-formatted.')
            lines.append(f'    """')

        # Use json.dumps to safely escape the tool name in the string literal
        escaped_name = json.dumps(name)

        if optional_params:
            lines.append(f"    kwargs = {{}}")
            for pname in properties:
                safe_pname = re.sub(r'[^a-zA-Z0-9_]', '_', pname)
                if pname in required:
                    lines.append(f'    kwargs[{json.dumps(pname)}] = {safe_pname}')
                else:
                    lines.append(f"    if {safe_pname} is not None:")
                    lines.append(f'        kwargs[{json.dumps(pname)}] = {safe_pname}')
            lines.append(f'    return tool_client.call({escaped_name}, **kwargs)')
        else:
            lines.append(f'    return tool_client.call({escaped_name}, {kwargs})')
        lines.append("")
        lines.append("")

    return "\n".join(lines)
