"""The Vibe MCP tools this app is allowed to call: 34 of the sidecar's catalogue.

Market data, fundamentals, filings, options, the alpha zoo and its bench,
broker reads and pre-trade checks, and the shadow-account chain. What is missing
is missing on purpose: `bash`, the file tools, `read_url`, `web_search` and
anything order-shaped stay outside `_MCP_ALLOWED_TOOLS` so the read-only
guarantee is enforced here rather than trusted upstream.

This provider counts **both** sides. A Tools tab that silently listed 34 would
read as "these are the tools", when the honest claim is "these are the 34 of N
this app may call, and the rest are refused" -- so `withheld` rides along in
every row's payload and the tab can say so.

**Why it borrows the router's MCP client.** `routers/vibe.py` already owns the
streamable-HTTP handshake, the session id and the retry-on-expired-session; a
second implementation here would be fifty lines of protocol to keep in step. The
client makes a fresh `AsyncClient` per request, so it is not bound to a loop --
and `aggregate` runs providers on a worker thread with no running loop, which is
what makes `asyncio.run` legal below.
"""
from __future__ import annotations

import asyncio
from typing import Any, Iterable

from ...catalog.schema import Entity
from ..aggregate import Provider

#: Coarse grouping for the facet rail, by name prefix. The MCP catalogue carries
#: no category of its own, and 34 ungrouped rows is a list rather than a
#: browsable collection.
_FAMILY_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("trading", ("trading_",)),
    ("shadow", ("analyze_trade_journal", "extract_shadow", "run_shadow", "scan_shadow",
                "render_shadow")),
    ("research", ("alpha_", "factor_analysis", "pattern_recognition", "backtest",
                  "list_runs", "get_run_result")),
    ("options", ("analyze_options", "get_options")),
)


def _family(name: str) -> str:
    for family, prefixes in _FAMILY_RULES:
        if name.startswith(prefixes):
            return family
    return "market data"


def _required_params(schema: dict) -> list[str]:
    required = schema.get("required") if isinstance(schema, dict) else None
    return [str(r) for r in required] if isinstance(required, list) else []


def fetch(settings: Any) -> Iterable[Entity]:
    # Imported inside the function: `routers.vibe` pulls in FastAPI routing, and
    # a provider module should stay importable without it.
    from ...routers.vibe import _MCP_ALLOWED_TOOLS, _mcp

    tools = asyncio.run(_mcp.list_tools())
    allowed = [t for t in tools if t.get("name") in _MCP_ALLOWED_TOOLS]
    withheld = len(tools) - len(allowed)

    out: list[Entity] = []
    for tool in allowed:
        name = tool["name"]
        schema = tool.get("inputSchema") or {}
        description = (tool.get("description") or "").strip()
        # MCP descriptions are multi-paragraph usage docs. The first line is the
        # sentence; the whole thing goes in the payload for the detail rail.
        first_line = description.split("\n", 1)[0].strip()

        out.append(
            Entity(
                kind="tool",
                source="vibe",
                local_id=name,
                name=name,
                title=name,
                summary=first_line,
                family=_family(name),
                tags=sorted(_required_params(schema)),
                payload={
                    "description": description,
                    "input_schema": schema,
                    "output_schema": tool.get("outputSchema"),
                    "transport": "mcp",
                    # So the tab can say "34 of N reachable" rather than
                    # presenting the allowlist as the whole catalogue.
                    "catalogue_total": len(tools),
                    "catalogue_withheld": withheld,
                },
            )
        )
    return out


PROVIDER = Provider(
    name="vibe_tools",
    kind="tool",
    source="vibe",
    label="Vibe MCP tools",
    fetch=fetch,
    remote=True,
)
