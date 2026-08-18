"""Aion-style schedule / trigger nodes.

These nodes decide *when* the rule chain is evaluated. In the current daily
qlib backtest they compile to an always-true trigger expression; intraday
schedules are accepted for forwards compatibility and surface advisories.
"""
from __future__ import annotations

from typing import Any

from ..models import Defect, Keycard, NodeOutput, NodeTypeMeta, Port, Windows
from ..registry import NodeType, register


class RunPerCandleNode(NodeType):
    """Evaluate the attached rule chain once per bar."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="run_per_candle",
            category="schedule",
            label="Run Per Candle",
            icon="activity",
            description="Trigger the rule chain on every bar.",
            ports=[
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "timeframe": {
                        "type": "string",
                        "enum": ["1m", "5m", "15m", "1h", "1d"],
                        "description": "Candle timeframe for the trigger.",
                    },
                },
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        return NodeOutput(outputs={"trigger": "1"})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        timeframe = config.get("timeframe")
        if timeframe is not None and timeframe not in ("1m", "5m", "15m", "1h", "1d"):
            return [Defect("invalid_timeframe",
                           f"timeframe must be one of 1m, 5m, 15m, 1h, 1d, got {timeframe!r}.",
                           "nodes[?].config.timeframe", "blocking")]
        return []


class RunAtTimeNode(NodeType):
    """Evaluate the rule chain at a specific clock time."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="run_at_time",
            category="schedule",
            label="Run At Time",
            icon="clock",
            description="Trigger at a specific time of day.",
            ports=[
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "time": {
                        "type": "string",
                        "description": "Time of day in HH:MM format.",
                    },
                    "timezone": {
                        "type": "string",
                        "description": "Timezone for the trigger time.",
                    },
                },
                "required": ["time"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        return NodeOutput(outputs={"trigger": "1"})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        time = config.get("time", "")
        if not isinstance(time, str) or len(time.split(":")) != 2:
            return [Defect("invalid_time",
                           "time must be in HH:MM format.",
                           "nodes[?].config.time", "blocking")]
        return [Defect("time_filter_ignored",
                       "Time-of-day filters are accepted but ignored in daily "
                       "backtests; the rule is evaluated at every close.",
                       "nodes[?].config.time", "advisory")]


class RunInSessionNode(NodeType):
    """Evaluate the rule chain inside a named trading session."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="run_in_session",
            category="schedule",
            label="Run In Session",
            icon="calendar-clock",
            description="Trigger only during a named session such as the opening range.",
            ports=[
                Port(id="trigger", label="Trigger", type="trigger",
                     direction="out", required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "session": {
                        "type": "string",
                        "enum": ["pre", "regular", "post"],
                        "description": "Which session activates the trigger.",
                    },
                },
                "required": ["session"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        return NodeOutput(outputs={"trigger": "1"})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        session = config.get("session")
        if session not in ("pre", "regular", "post"):
            return [Defect("invalid_session",
                           f"Unknown session {session!r}.",
                           "nodes[?].config.session", "blocking")]
        return [Defect("session_filter_ignored",
                       "Session filters are accepted but ignored in daily "
                       "backtests; the rule is evaluated at every close.",
                       "nodes[?].config.session", "advisory")]


register(RunPerCandleNode())
register(RunAtTimeNode())
register(RunInSessionNode())
