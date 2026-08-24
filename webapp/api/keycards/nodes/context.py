"""Context node for the Keycard workflow builder.

A context node holds the user's plain-language objective. It does not take part
in the data-flow graph; it is an annotation that the AI assistant reads when
proposing changes.
"""
from __future__ import annotations

from typing import Any

from ..models import Defect, Keycard, NodeOutput, NodeTypeMeta, Windows
from ..registry import NodeType, register


class ContextNode(NodeType):
    """A free-text objective for the AI assistant."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="context",
            category="management",
            label="Context",
            icon="message-square",
            description="Type what you want to achieve so the AI can factor it in.",
            ports=[],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Plain-language objective for the strategy.",
                    },
                },
                "required": ["text"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        return NodeOutput()

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        return []


register(ContextNode())
