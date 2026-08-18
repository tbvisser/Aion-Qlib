"""Schedule grammar and next-run calculation for scheduled tasks.

The recurrence model is intentionally simple: a frequency, a time of day, and an
optional weekday. This covers every cadence the UI currently advertises without
pulling in a cron library. All times are interpreted as UTC; the UI displays
local time and stores UTC.
"""
from __future__ import annotations

import re
from datetime import datetime, time, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Frequency = Literal["daily", "weekdays", "weekly"]
WeekDay = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

_KINDS = ("macro_refresh", "data_refresh", "run_strategy", "outlook_report", "scalability_report")

_WEEKDAY_ORDER: dict[WeekDay, int] = {
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
}

_TIME_RE = re.compile(r"^([0-1]\d|2[0-3]):([0-5]\d)$")


class Schedule(BaseModel):
    """A simple recurrence: when during the day and on which days."""

    frequency: Frequency
    time: str = Field(..., examples=["07:00"])
    day: WeekDay | None = None

    @field_validator("time")
    @classmethod
    def _validate_time(cls, value: str) -> str:
        if not _TIME_RE.fullmatch(value):
            raise ValueError("time must be HH:MM in 24-hour format")
        return value

    @model_validator(mode="after")
    def _validate_day(self) -> "Schedule":
        if self.frequency == "weekly" and self.day is None:
            raise ValueError("weekly schedules require a day")
        if self.frequency != "weekly" and self.day is not None:
            raise ValueError("day is only used with weekly frequency")
        return self

    def time_tuple(self) -> tuple[int, int]:
        hour, minute = self.time.split(":")
        return int(hour), int(minute)


def _weekday(dt: datetime) -> int:
    # Monday = 0
    return dt.weekday()


def _next_weekday(dt: datetime, target: int) -> datetime:
    """Return the next occurrence of target weekday on or after dt (date only)."""
    current = _weekday(dt)
    delta = (target - current) % 7
    return dt + timedelta(days=delta)


def next_run(schedule: Schedule, after: datetime | None = None) -> datetime:
    """Compute the first scheduled instant at or after ``after`` (UTC).

    The result is always anchored at the scheduled clock time on the resolved
    day. If ``after`` falls later than that time, we advance to the next
    matching day.
    """
    after = after or datetime.now(timezone.utc)
    after = after.replace(second=0, microsecond=0)
    hour, minute = schedule.time_tuple()
    candidate = after.replace(hour=hour, minute=minute, second=0, microsecond=0)

    if schedule.frequency == "daily":
        if candidate < after:
            candidate = candidate + timedelta(days=1)
        return candidate

    if schedule.frequency == "weekdays":
        # Monday (0) through Friday (4)
        while _weekday(candidate) >= 5 or candidate < after:
            candidate = candidate + timedelta(days=1)
            candidate = candidate.replace(hour=hour, minute=minute)
        return candidate

    if schedule.frequency == "weekly":
        target = _WEEKDAY_ORDER[schedule.day]  # type: ignore[arg-type]
        candidate = _next_weekday(candidate, target).replace(
            hour=hour, minute=minute, second=0, microsecond=0
        )
        if candidate < after:
            candidate = candidate + timedelta(weeks=1)
        return candidate

    raise ValueError(f"unknown frequency {schedule.frequency}")


class ScheduledTaskSpec(BaseModel):
    """What the user supplies when creating or updating a scheduled task."""

    name: str = Field(..., min_length=1, max_length=120)
    kind: Literal["macro_refresh", "data_refresh", "run_strategy", "outlook_report", "scalability_report"]
    schedule: Schedule
    params: dict = Field(default_factory=dict)
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def _validate_params(self) -> "ScheduledTaskSpec":
        if self.kind == "macro_refresh":
            what = self.params.get("what", "all")
            if what not in ("all", "calendar", "indicators"):
                raise ValueError("macro_refresh.what must be all, calendar or indicators")
        elif self.kind == "data_refresh":
            universe_size = self.params.get("universe_size", 500)
            if not isinstance(universe_size, int) or not (1 <= universe_size <= 5000):
                raise ValueError("data_refresh.universe_size must be 1..5000")
            mode = self.params.get("mode", "all")
            if mode not in ("all", "update"):
                raise ValueError("data_refresh.mode must be all or update")
        elif self.kind == "run_strategy":
            strategy_id = self.params.get("strategy_id")
            if not strategy_id or not isinstance(strategy_id, str):
                raise ValueError("run_strategy.params requires strategy_id")
        elif self.kind == "outlook_report":
            scope = self.params.get("scope", "week")
            if scope not in ("day", "week", "month"):
                raise ValueError("outlook_report.scope must be day, week or month")
            self.params["scope"] = scope
        elif self.kind == "scalability_report":
            # Both params are optional: the dispatcher falls back to the user's
            # latest parsed upload and the full venue catalog.
            upload_id = self.params.get("upload_id")
            if upload_id is not None and not isinstance(upload_id, str):
                raise ValueError("scalability_report.upload_id must be a string")
            candidate_venues = self.params.get("candidate_venues")
            if candidate_venues is not None and (
                not isinstance(candidate_venues, list)
                or not all(isinstance(venue, str) for venue in candidate_venues)
            ):
                raise ValueError("scalability_report.candidate_venues must be a list of strings")
        return self


def cadence_label(schedule: Schedule) -> str:
    """Human-friendly rendering matching the suggestions on the page."""
    time_label = schedule.time
    if schedule.frequency == "daily":
        return f"Every day at {time_label}"
    if schedule.frequency == "weekdays":
        return f"Weekdays at {time_label}"
    day_labels = {
        "mon": "Monday", "tue": "Tuesday", "wed": "Wednesday",
        "thu": "Thursday", "fri": "Friday", "sat": "Saturday", "sun": "Sunday",
    }
    return f"Every {day_labels[schedule.day]} at {time_label}"  # type: ignore[index]
