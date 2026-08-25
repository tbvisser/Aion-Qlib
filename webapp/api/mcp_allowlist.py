"""Tool allowlists for the Aion MCP server (Hermes and other MCP hosts).

Single source of truth: the MCP server registers only tools in the read and
confirm tiers. Tier-2 tools must never appear here — they stay in the
authenticated UI chat profiles only.
"""
from __future__ import annotations

# Tier 0 — v1 read-only tools safe for external MCP hosts.
AION_MCP_READ_TOOLS: frozenset[str] = frozenset({
    "get_data_status",
    "search_instruments",
    "get_price_summary",
    "evaluate_factor",
    "get_markov_signal",
    "get_run_status",
    "list_runs",
    "get_scalability_report",
})

# Tier 1 — require UI approval before dispatch (Hermes / MCP hosts).
AION_MCP_CONFIRM_TOOLS: frozenset[str] = frozenset({
    "run_backtest",
    "start_scalability_analysis",
})

# Tier 2 — explicitly blocked from MCP even if present in chat profiles.
AION_MCP_BLOCKED_TOOLS: frozenset[str] = frozenset({
    "book_venue_consultation",
    "propose_strategy",
    "propose_keycard",
})


def is_allowed(name: str) -> bool:
    """True when the tool may be registered or invoked via aion-mcp."""
    return name in AION_MCP_READ_TOOLS or name in AION_MCP_CONFIRM_TOOLS


def assert_allowlist_consistency() -> None:
    """Boot-time guard: tiers must not overlap or leak blocked tools."""
    overlap = AION_MCP_READ_TOOLS & AION_MCP_CONFIRM_TOOLS
    if overlap:
        raise RuntimeError(f"MCP allowlist tiers overlap: {sorted(overlap)}")
    leaked = (AION_MCP_READ_TOOLS | AION_MCP_CONFIRM_TOOLS) & AION_MCP_BLOCKED_TOOLS
    if leaked:
        raise RuntimeError(f"Blocked tools found in MCP allowlist: {sorted(leaked)}")
