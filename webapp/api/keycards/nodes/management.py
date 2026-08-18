"""Aion-style trade-management nodes.

Management nodes are stateful in a full event-driven engine.  In the compiled
qlib expression bridge they act as pass-throughs and emit advisories so the
workflow remains valid without building a custom execution runtime.
"""
from __future__ import annotations

from typing import Any

from ..models import Defect, Keycard, NodeOutput, NodeTypeMeta, Port, Windows
from ..registry import NodeType, register


class TradeCounterNode(NodeType):
    """Count how many trades have been taken and stop after a limit."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="trade_counter",
            category="management",
            label="Trade Counter",
            icon="hash",
            description="Cap the number of trades in a session or day.",
            ports=[
                Port(id="trade", label="Trade", type="trade",
                     direction="in", required=True),
                Port(id="trade", label="Trade", type="trade",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "max_trades": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Maximum number of trades to allow.",
                    },
                },
                "required": ["max_trades"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        return NodeOutput(outputs={"trade": incoming.get("trade", "1") or "1"})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        max_trades = config.get("max_trades")
        defects: list[Defect] = []
        if not isinstance(max_trades, int) or max_trades < 1:
            defects.append(Defect("invalid_max_trades",
                                  "max_trades must be a positive integer.",
                                  "nodes[?].config.max_trades", "blocking"))
        defects.append(Defect("trade_counter_not_enforced",
                              "Trade counters are accepted but not enforced by "
                              "the daily expression bridge.",
                              "nodes[?].config.max_trades", "advisory"))
        return defects


class ResetTradeCounterNode(NodeType):
    """Reset the trade counter on a schedule or condition."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="reset_trade_counter",
            category="management",
            label="Reset Trade Counter",
            icon="rotate-ccw",
            description="Reset the trade counter at the start of each session or day.",
            ports=[
                Port(id="trade", label="Trade", type="trade",
                     direction="in", required=True),
                Port(id="trade", label="Trade", type="trade",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "max_trades": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Maximum number of trades to allow after the reset.",
                    },
                },
                "required": ["max_trades"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        return NodeOutput(outputs={"trade": incoming.get("trade", "1") or "1"})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        max_trades = config.get("max_trades")
        defects: list[Defect] = []
        if not isinstance(max_trades, int) or max_trades < 1:
            defects.append(Defect("invalid_max_trades",
                                  "max_trades must be a positive integer.",
                                  "nodes[?].config.max_trades", "blocking"))
        defects.append(Defect("reset_counter_not_enforced",
                              "Counter resets are accepted but not enforced by "
                              "the daily expression bridge.",
                              "nodes[?].config.max_trades", "advisory"))
        return defects


register(TradeCounterNode())
register(ResetTradeCounterNode())
