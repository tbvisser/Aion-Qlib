"""MCP tool allowlist invariants."""
from __future__ import annotations

from webapp.api.chat_tools import PROFILES
from webapp.api.mcp_allowlist import (
    AION_MCP_BLOCKED_TOOLS,
    AION_MCP_CONFIRM_TOOLS,
    AION_MCP_READ_TOOLS,
    assert_allowlist_consistency,
    is_allowed,
)


def test_allowlist_tiers_do_not_overlap():
    assert_allowlist_consistency()


def test_blocked_tools_are_not_allowed():
    for name in AION_MCP_BLOCKED_TOOLS:
        assert not is_allowed(name)


def test_read_tools_are_allowed():
    for name in AION_MCP_READ_TOOLS:
        assert is_allowed(name)


def test_confirm_tools_are_allowed():
    assert AION_MCP_CONFIRM_TOOLS == frozenset({"run_backtest", "start_scalability_analysis"})
    for name in AION_MCP_CONFIRM_TOOLS:
        assert is_allowed(name)


def test_tier2_act_tools_not_mcp_except_confirm_tier():
    """Blocked tools stay out of MCP; confirm tier requires approval."""
    for blocked in AION_MCP_BLOCKED_TOOLS:
        assert not is_allowed(blocked)
    for confirm in AION_MCP_CONFIRM_TOOLS:
        assert confirm in set(PROFILES["general"].tools)
        assert is_allowed(confirm)
