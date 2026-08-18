"""Portfolio-construction nodes."""
from __future__ import annotations

from typing import Any

from ..models import Defect, Keycard, NodeOutput, NodeTypeMeta, Port, Windows
from ..registry import NodeType, register


class PortfolioNode(NodeType):
    """Turns model predictions into a tradable portfolio."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="portfolio",
            category="portfolio",
            label="Portfolio",
            icon="briefcase",
            description="Portfolio construction: how many names to hold and how often to rotate.",
            ports=[
                Port(id="signal", label="Signal", type="signal", direction="in",
                     required=True),
                Port(id="trades", label="Trades", type="trades", direction="out",
                     required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "strategy": {
                        "type": "string",
                        "enum": ["TopkDropoutStrategy"],
                        "description": "Portfolio strategy class.",
                    },
                    "topk": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 500,
                        "description": "How many instruments to hold.",
                    },
                    "n_drop": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 100,
                        "description": "How many holdings to replace each rebalance.",
                    },
                },
                "required": ["strategy", "topk", "n_drop"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        signal = incoming.get("signal")
        topk = config.get("topk", 50)
        n_drop = config.get("n_drop", 5)

        if isinstance(signal, str):
            # Aion rule chain: the signal is a per-instrument boolean expression.
            return NodeOutput(
                outputs={"trades": {"strategy": "RuleFlowStrategy", "is_rule_based": True}},
                fragment={
                    "port_analysis_config": {
                        "strategy": {
                            "class": "RuleFlowStrategy",
                            "module_path": "qlib.contrib.strategy.rule_flow",
                            "kwargs": {"rule_expr": signal, "topk": topk, "n_drop": n_drop},
                        },
                    },
                },
            )

        strategy = config.get("strategy", "TopkDropoutStrategy")
        return NodeOutput(
            outputs={"trades": {"strategy": strategy, "topk": topk, "n_drop": n_drop}},
            fragment={
                "port_analysis_config": {
                    "strategy": {
                        "class": strategy,
                        "module_path": "qlib.contrib.strategy",
                        "kwargs": {"signal": "<PRED>", "topk": topk, "n_drop": n_drop},
                    },
                },
            },
        )

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        defects: list[Defect] = []
        strategy = config.get("strategy")
        if strategy != "TopkDropoutStrategy":
            defects.append(Defect("unsupported_strategy",
                                  f"Strategy {strategy!r} is not supported yet.",
                                  "nodes[?].config.strategy", "blocking"))
        topk = config.get("topk")
        if not isinstance(topk, int) or topk < 1 or topk > 500:
            defects.append(Defect("invalid_topk",
                                  "topk must be an integer between 1 and 500.",
                                  "nodes[?].config.topk", "blocking"))
        n_drop = config.get("n_drop")
        if not isinstance(n_drop, int) or n_drop < 0 or n_drop > 100:
            defects.append(Defect("invalid_n_drop",
                                  "n_drop must be an integer between 0 and 100.",
                                  "nodes[?].config.n_drop", "blocking"))
        return defects


register(PortfolioNode())
