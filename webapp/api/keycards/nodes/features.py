"""Feature-engineering nodes."""
from __future__ import annotations

from typing import Any

from ..models import Defect, Keycard, NodeOutput, NodeTypeMeta, Port, Windows
from ..registry import NodeType, register


class HandlerNode(NodeType):
    """Chooses the handler and any custom factor columns."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="handler",
            category="features",
            label="Feature Handler",
            icon="layers",
            description="The feature set (Alpha158/Alpha360) and custom factors.",
            ports=[
                Port(id="data", label="Data", type="data", direction="in",
                     required=True),
                Port(id="features", label="Features", type="features",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "handler": {
                        "type": "string",
                        "enum": ["Alpha158", "Alpha360"],
                        "description": "Which built-in handler to use.",
                    },
                    "feature_mode": {
                        "type": "string",
                        "enum": ["extend", "replace"],
                        "description": "Whether custom factors extend or replace the handler.",
                    },
                    "features": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "name": {"type": "string"},
                                "expression": {"type": "string"},
                            },
                            "required": ["name", "expression"],
                        },
                    },
                },
                "required": ["handler"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        data = incoming.get("data", {})
        return NodeOutput(
            outputs={
                "features": {
                    "handler": config.get("handler", "Alpha158"),
                    "feature_mode": config.get("feature_mode", "extend"),
                    "features": config.get("features") or None,
                    "store": data.get("store", "us"),
                    "universe": data.get("universe", "top500"),
                    "benchmark": data.get("benchmark", "SPY"),
                },
            },
            fragment={
                "_handler": {
                    "handler": config.get("handler", "Alpha158"),
                    "feature_mode": config.get("feature_mode", "extend"),
                    "features": config.get("features") or None,
                    "store": data.get("store", "us"),
                    "universe": data.get("universe", "top500"),
                    "benchmark": data.get("benchmark", "SPY"),
                },
            },
        )

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        handler = config.get("handler")
        if handler not in ("Alpha158", "Alpha360"):
            return [Defect("invalid_handler",
                           f"Handler must be Alpha158 or Alpha360, got {handler!r}.",
                           "nodes[?].config.handler", "blocking")]
        feature_mode = config.get("feature_mode", "extend")
        if feature_mode not in ("extend", "replace"):
            return [Defect("invalid_feature_mode",
                           f"feature_mode must be extend or replace, got {feature_mode!r}.",
                           "nodes[?].config.feature_mode", "blocking")]
        if feature_mode == "replace" and not config.get("features"):
            return [Defect("replace_needs_features",
                           "feature_mode 'replace' needs at least one custom feature.",
                           "nodes[?].config.features", "blocking")]
        return []


register(HandlerNode())
