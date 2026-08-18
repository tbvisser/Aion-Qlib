"""Aion-style chart drawing nodes."""
from __future__ import annotations

from typing import Any

from ..models import Defect, Keycard, NodeOutput, NodeTypeMeta, Port, Windows
from ..registry import NodeType, register


class ChartDrawingNode(NodeType):
    """Draw a horizontal line, marker or shaded region on the chart."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="chart_drawing",
            category="chart_drawings",
            label="Chart Drawing",
            icon="pencil",
            description="A visual annotation for the chart panel.",
            ports=[
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="in", required=False),
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "type": {
                        "type": "string",
                        "enum": ["level", "trend", "zone"],
                        "description": "Type of drawing to render.",
                    },
                    "price": {
                        "type": "number",
                        "description": "Price level for the drawing.",
                    },
                },
                "required": ["type", "price"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        # Chart drawings are frontend-only annotations; they produce no qlib config.
        return NodeOutput()

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        drawing_type = config.get("type")
        if drawing_type not in ("level", "trend", "zone"):
            return [Defect("invalid_drawing_type",
                           f"Unknown drawing type {drawing_type!r}.",
                           "nodes[?].config.type", "blocking")]
        price = config.get("price")
        if not isinstance(price, (int, float)):
            return [Defect("invalid_price",
                           "price must be a number.",
                           "nodes[?].config.price", "blocking")]
        return []


register(ChartDrawingNode())
