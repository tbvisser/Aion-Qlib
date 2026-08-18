"""Model nodes."""
from __future__ import annotations

from typing import Any

from ...strategies import MODEL_SPECS
from ..models import Defect, Keycard, NodeOutput, NodeTypeMeta, Port, Windows
from ..registry import NodeType, register


class ModelNode(NodeType):
    """Selects the learner that turns features into predictions."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="model",
            category="model",
            label="Model",
            icon="brain",
            description="The learner trained on the feature set.",
            ports=[
                Port(id="features", label="Features", type="features",
                     direction="in", required=True),
                Port(id="signal", label="Signal", type="signal",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "model": {
                        "type": "string",
                        "enum": list(MODEL_SPECS.keys()),
                        "description": "Which model to train.",
                    },
                },
                "required": ["model"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        model_key = config.get("model", "lightgbm")
        model = MODEL_SPECS.get(model_key, MODEL_SPECS["lightgbm"])
        return NodeOutput(
            outputs={"signal": model},
            fragment={
                "task": {
                    "model": {
                        "class": model["class"],
                        "module_path": model["module_path"],
                        "kwargs": model["kwargs"],
                    },
                },
            },
        )

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        model = config.get("model")
        if model not in MODEL_SPECS:
            return [Defect("invalid_model",
                           f"Unknown model {model!r}. Available: "
                           f"{', '.join(MODEL_SPECS)}.",
                           "nodes[?].config.model", "blocking")]
        return []


register(ModelNode())
