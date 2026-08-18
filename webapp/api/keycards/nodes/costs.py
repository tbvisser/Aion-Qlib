"""Trading-cost and account nodes."""
from __future__ import annotations

from typing import Any

from ..models import Defect, Keycard, NodeOutput, NodeTypeMeta, Port, Windows
from ..registry import NodeType, register


class CostsNode(NodeType):
    """Account, commission and price-limit settings for the backtest."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="costs",
            category="portfolio",
            label="Costs",
            icon="dollar-sign",
            description="Trading costs, account size and price-limit guard.",
            ports=[
                Port(id="trades", label="Trades", type="trades", direction="in",
                     required=False),
                Port(id="trades", label="Trades", type="trades", direction="out",
                     required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "open_cost": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 0.05,
                        "description": "Cost to open a position as a fraction.",
                    },
                    "close_cost": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 0.05,
                        "description": "Cost to close a position as a fraction.",
                    },
                    "min_cost": {
                        "type": "number",
                        "minimum": 0,
                        "description": "Minimum cost per trade in currency.",
                    },
                    "account": {
                        "type": "number",
                        "exclusiveMinimum": 0,
                        "description": "Starting capital.",
                    },
                    "limit_threshold": {
                        "type": ["number", "null"],
                        "description": "Daily move beyond which a fill is impossible.",
                    },
                },
                "required": ["open_cost", "close_cost", "min_cost", "account"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        exchange_kwargs: dict[str, Any] = {
            "deal_price": "close",
            "open_cost": config.get("open_cost", 0.0005),
            "close_cost": config.get("close_cost", 0.0015),
            "min_cost": config.get("min_cost", 5.0),
        }
        limit_threshold = config.get("limit_threshold")
        if limit_threshold is not None:
            exchange_kwargs["limit_threshold"] = limit_threshold
        return NodeOutput(
            outputs={"trades": {**incoming.get("trades", {}), "costs": config}},
            fragment={
                "exchange_kwargs": exchange_kwargs,
                "port_analysis_config": {
                    "backtest": {
                        "start_time": windows.test_start,
                        "end_time": windows.test_end,
                        "account": config.get("account", 100_000_000),
                        "exchange_kwargs": exchange_kwargs,
                    },
                },
            },
        )

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        defects: list[Defect] = []
        for name in ("open_cost", "close_cost"):
            value = config.get(name)
            if not isinstance(value, (int, float)) or value < 0 or value > 0.05:
                defects.append(Defect(
                    f"invalid_{name}",
                    f"{name} must be between 0 and 0.05.",
                    f"nodes[?].config.{name}", "blocking"))
        min_cost = config.get("min_cost")
        if not isinstance(min_cost, (int, float)) or min_cost < 0:
            defects.append(Defect("invalid_min_cost",
                                  "min_cost must be non-negative.",
                                  "nodes[?].config.min_cost", "blocking"))
        account = config.get("account")
        if not isinstance(account, (int, float)) or account <= 0:
            defects.append(Defect("invalid_account",
                                  "account must be positive.",
                                  "nodes[?].config.account", "blocking"))
        return defects


register(CostsNode())
