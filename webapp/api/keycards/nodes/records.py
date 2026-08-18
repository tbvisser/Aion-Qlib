"""Record / metric-collection nodes."""
from __future__ import annotations

from typing import Any

from ..models import Defect, Keycard, NodeOutput, NodeTypeMeta, Port, Windows
from ..registry import NodeType, register


class RecordsNode(NodeType):
    """Emits SignalRecord, SigAnaRecord and PortAnaRecord."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="records",
            category="output",
            label="Records",
            icon="file-text",
            description="Records that report signals, signal analysis and portfolio analysis.",
            ports=[
                Port(id="trades", label="Trades", type="trades", direction="in",
                     required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        return NodeOutput(
            fragment={
                "task": {
                    "record": [
                        {"class": "SignalRecord",
                         "module_path": "qlib.workflow.record_temp",
                         "kwargs": {"model": "<MODEL>", "dataset": "<DATASET>"}},
                        {"class": "SigAnaRecord",
                         "module_path": "qlib.workflow.record_temp",
                         "kwargs": {"ana_long_short": False, "ann_scaler": 252}},
                        {"class": "PortAnaRecord",
                         "module_path": "qlib.workflow.record_temp",
                         "kwargs": {"config": "<PORT_ANA_CONFIG>"}},
                    ],
                },
            },
        )

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        return []


register(RecordsNode())
