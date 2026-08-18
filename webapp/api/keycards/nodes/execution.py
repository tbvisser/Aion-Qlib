"""Aion-style execution nodes."""
from __future__ import annotations

from typing import Any

from ..models import Defect, Keycard, NodeOutput, NodeTypeMeta, Port, Windows
from ..registry import NodeType, register


class BuyNowNode(NodeType):
    """Convert a boolean rule chain into a portfolio signal.

    The incoming ``trigger`` port carries the compiled boolean expression for
    the rule chain.  This node forwards it on a ``signal`` port so the existing
    portfolio node can consume it.
    """

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="buy_now",
            category="execution",
            label="Buy Now",
            icon="zap",
            description="Fire the rule chain and turn the result into a trade signal.",
            ports=[
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="in", required=True),
                Port(id="signal", label="Signal", type="signal",
                     direction="out", required=True),
            ],
            config_schema={"type": "object", "additionalProperties": False},
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        expression = incoming.get("trigger", "1") or "1"
        return NodeOutput(outputs={"signal": expression})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        return []


register(BuyNowNode())
