"""Aion-style variable nodes."""
from __future__ import annotations

from typing import Any

from ..models import Defect, Keycard, NodeOutput, NodeTypeMeta, Port, Windows
from ..registry import NodeType, register


class VariableNode(NodeType):
    """A named value that can be referenced by other nodes."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="variable",
            category="variables",
            label="Variable",
            icon="variable",
            description="A reusable value or parameter.",
            ports=[
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="in", required=False),
                Port(id="value", label="Value", type="value",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Variable name.",
                    },
                    "value": {
                        "type": ["string", "number", "boolean"],
                        "description": "Literal value or expression fragment.",
                    },
                },
                "required": ["name", "value"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        return NodeOutput(outputs={"value": config.get("value")})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        name = config.get("name")
        if not name or not isinstance(name, str):
            return [Defect("missing_name",
                           "A variable needs a non-empty name.",
                           "nodes[?].config.name", "blocking")]
        return []


register(VariableNode())
