"""Aion-style rule / filter nodes.

Each rule takes a trigger expression, appends its own boolean condition, and
forwards the combined expression on its ``trigger`` output port.  The chain is
compiled into a single qlib boolean expression that the ``buy_now`` node turns
into a portfolio signal.
"""
from __future__ import annotations

from typing import Any

from ..compiler import _merge_triggers
from ..models import Defect, Keycard, NodeOutput, NodeTypeMeta, Port, Windows
from ..registry import NodeType, register


def _and(trigger: str, condition: str) -> str:
    """Combine a schedule trigger with a rule condition.

    ``1`` is the neutral trigger, so it is omitted when possible.
    """
    if trigger and trigger != "1":
        return f"({trigger}) * ({condition})"
    return condition


def _trigger_value(incoming: dict[str, Any]) -> str:
    """Return the merged trigger expression from a possibly-multi-edge input."""
    value = incoming.get("trigger", "1")
    if isinstance(value, list):
        return _merge_triggers(value)
    return value or "1"


class TradeRuleNode(NodeType):
    """A user-written boolean expression evaluated per instrument."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="trade_rule",
            category="rules",
            label="Trade Rule",
            icon="code",
            description="A custom boolean expression such as $close > Ref($close,-1).",
            ports=[
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="in", required=True, multiple=True),
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "condition": {
                        "type": "string",
                        "description": "A per-instrument qlib boolean expression.",
                    },
                },
                "required": ["condition"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        trigger = _trigger_value(incoming)
        return NodeOutput(outputs={"trigger": _and(trigger, config.get("condition", "1"))})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        condition = config.get("condition")
        if not condition or not isinstance(condition, str):
            return [Defect("missing_condition",
                           "A trade rule needs a non-empty condition.",
                           "nodes[?].config.condition", "blocking")]
        return []


class CheckSpreadNode(NodeType):
    """Require a minimum bid/ask spread or avoid zero-volume prints."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="check_spread",
            category="rules",
            label="Check Spread",
            icon="arrow-left-right",
            description="Filter out instruments with a wide spread or missing quote.",
            ports=[
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="in", required=True, multiple=True),
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "max_spread_bps": {
                        "type": "number",
                        "minimum": 0,
                        "description": "Maximum spread in basis points.",
                    },
                },
                "required": ["max_spread_bps"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        trigger = _trigger_value(incoming)
        # Daily stores do not carry bid/ask spreads, so the filter is accepted
        # for forwards compatibility but currently passes the trigger through.
        return NodeOutput(outputs={"trigger": _and(trigger, "1")})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        bps = config.get("max_spread_bps")
        if not isinstance(bps, (int, float)) or bps < 0:
            return [Defect("invalid_max_spread_bps",
                           "max_spread_bps must be a non-negative number.",
                           "nodes[?].config.max_spread_bps", "blocking")]
        return [Defect("spread_filter_not_enforced",
                       "Spread filters are accepted but not enforced in daily "
                       "backtests; the rule is evaluated at every close.",
                       "nodes[?].config.max_spread_bps", "advisory")]


class PreviousDayBullishNode(NodeType):
    """Require the previous daily candle to have closed above its open."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="previous_day_bullish",
            category="rules",
            label="Previous Day Bullish",
            icon="trending-up",
            description="Only trade when the previous bar was bullish.",
            ports=[
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="in", required=True, multiple=True),
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="out", required=True),
            ],
            config_schema={"type": "object", "additionalProperties": False},
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        trigger = _trigger_value(incoming)
        return NodeOutput(outputs={"trigger": _and(trigger, "Ref($close,-1) > Ref($open,-1)")})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        return []


class CandleCloseAboveOpeningRangeNode(NodeType):
    """Require the close to be above the high of the opening range."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="candle_close_above_opening_range",
            category="rules",
            label="Close Above Opening Range",
            icon="candlestick-chart",
            description="Trade when price breaks above the opening range high.",
            ports=[
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="in", required=True, multiple=True),
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "minutes": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Opening range in minutes. In daily backtests this is treated as the number of opening bars.",
                    },
                },
                "required": ["minutes"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        trigger = _trigger_value(incoming)
        bars = config.get("minutes", 5)
        refs = ", ".join(f"Ref($high,-{i})" for i in range(bars, 0, -1))
        condition = f"$close > Max({refs})"
        return NodeOutput(outputs={"trigger": _and(trigger, condition)})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        minutes = config.get("minutes")
        if not isinstance(minutes, int) or minutes < 1:
            return [Defect("invalid_minutes",
                           "minutes must be a positive integer.",
                           "nodes[?].config.minutes", "blocking")]
        return []


class PriceAbovePreviousDayCloseNode(NodeType):
    """Require the current close to be above the previous day's close."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="price_above_previous_day_close",
            category="rules",
            label="Above Prev Close",
            icon="arrow-up-circle",
            description="Only trade when price is above the previous close.",
            ports=[
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="in", required=True, multiple=True),
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="out", required=True),
            ],
            config_schema={"type": "object", "additionalProperties": False},
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        trigger = _trigger_value(incoming)
        return NodeOutput(outputs={"trigger": _and(trigger, "$close > Ref($close,-1)")})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        return []


class NoTradeForDayNode(NodeType):
    """Block trading on a specific instrument for the current day."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="no_trade_for_day",
            category="rules",
            label="No Trade For Day",
            icon="ban",
            description="Do not trade instruments that match the suppression condition.",
            ports=[
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="in", required=True, multiple=True),
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "Why trades are blocked today.",
                    },
                },
                "required": ["reason"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        trigger = _trigger_value(incoming)
        # Day-level trade suppression is stateful and not enforced by the daily
        # expression bridge; the trigger passes through.
        return NodeOutput(outputs={"trigger": _and(trigger, "1")})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        reason = config.get("reason")
        if not reason or not isinstance(reason, str):
            return [Defect("missing_reason",
                           "A no-trade rule needs a reason.",
                           "nodes[?].config.reason", "blocking")]
        return [Defect("no_trade_not_enforced",
                       "Day-level trade suppression is accepted but not enforced "
                       "by the daily expression bridge.",
                       "nodes[?].config.reason", "advisory")]


class NewsFilterNode(NodeType):
    """Placeholder for a news/sentiment filter."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="news_filter",
            category="rules",
            label="News Filter",
            icon="newspaper",
            description="Filter by news sentiment (placeholder; currently passes trigger through).",
            ports=[
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="in", required=True, multiple=True),
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "source": {
                        "type": "string",
                        "enum": ["general", "earnings", "fed", "macro"],
                        "description": "News source to filter on.",
                    },
                    "sentiment": {
                        "type": "string",
                        "enum": ["any", "positive", "negative"],
                        "description": "Required sentiment direction.",
                    },
                },
                "required": ["source"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        trigger = _trigger_value(incoming)
        return NodeOutput(outputs={"trigger": _and(trigger, "1")})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        source = config.get("source")
        if source not in ("general", "earnings", "fed", "macro"):
            return [Defect("invalid_source",
                           "source must be one of general, earnings, fed, macro.",
                           "nodes[?].config.source", "blocking")]
        sentiment = config.get("sentiment")
        if sentiment is not None and sentiment not in ("any", "positive", "negative"):
            return [Defect("invalid_sentiment",
                           "sentiment must be one of any, positive, negative.",
                           "nodes[?].config.sentiment", "blocking")]
        return [Defect("news_filter_placeholder",
                       "News filtering is not wired to a data source yet; "
                       "the node currently passes the trigger through.",
                       "nodes[?].config.source", "advisory")]


register(TradeRuleNode())
register(CheckSpreadNode())
register(PreviousDayBullishNode())
register(CandleCloseAboveOpeningRangeNode())
register(PriceAbovePreviousDayCloseNode())
register(NoTradeForDayNode())
register(NewsFilterNode())
