"""Pydantic models for the Keycard DAG workflow builder.

A keycard is a visual, node-and-edge representation of a quant workflow. It
carries the same information as the flat ``StrategySpec`` but lets the builder
lay out, inspect and rewrite the pipeline as a directed acyclic graph.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Position(BaseModel):
    """A node’s location on the canvas."""

    model_config = ConfigDict(extra="forbid")

    x: float
    y: float


class Port(BaseModel):
    """One typed socket on a node."""

    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    type: Literal["data", "features", "signal", "trades", "config",
                  "trigger", "trade", "value"]
    direction: Literal["in", "out"]
    required: bool = True


class Node(BaseModel):
    """One box on the canvas."""

    model_config = ConfigDict(extra="forbid")

    id: str
    type: str
    position: Position
    config: dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class Edge(BaseModel):
    """A connection between two ports."""

    model_config = ConfigDict(extra="forbid")

    id: str
    source: str
    source_port: str
    target: str
    target_port: str


class Windows(BaseModel):
    """The three non-overlapping windows every run needs."""

    model_config = ConfigDict(extra="forbid")

    train_start: str = "2010-01-04"
    train_end: str = "2019-12-31"
    valid_start: str = "2020-01-01"
    valid_end: str = "2021-12-31"
    test_start: str = "2022-01-01"
    test_end: str = "2026-08-07"

    @field_validator("train_start", "train_end", "valid_start", "valid_end",
                     "test_start", "test_end")
    @classmethod
    def _iso_date(cls, v: str) -> str:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            raise ValueError(f"'{v}' must be YYYY-MM-DD")
        return v


class KeycardSpec(BaseModel):
    """The caller-editable part of a keycard workflow.

    Everything except the identity, ownership and timestamp metadata that the
    store manages. This is the shape accepted by ``POST /api/keycards`` and
    returned inside the stored ``Keycard``.
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    is_template: bool = False
    template_family: str | None = None
    nodes: list[Node] = Field(default_factory=list)
    edges: list[Edge] = Field(default_factory=list)
    windows: Windows = Field(default_factory=Windows)


class Keycard(KeycardSpec):
    """A complete workflow as a DAG, as it is stored and returned."""

    id: str
    created_at: str = ""
    updated_at: str = ""
    user_id: str = ""
    visibility: str = "private"


Severity = Literal["blocking", "advisory"]


@dataclass(frozen=True)
class Defect:
    """One thing wrong with a keycard, in keycard coordinates.

    ``path`` names a node or edge, e.g. ``nodes[store-1].config.store`` or
    ``edges[e1]``, so the builder can place the message on the right card.
    """

    code: str
    message: str
    path: str
    severity: Severity = "blocking"

    def as_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "path": self.path,
                "severity": self.severity}


class NodeTypeMeta(BaseModel):
    """Static metadata that populates the node palette."""

    model_config = ConfigDict(extra="forbid")

    id: str
    category: str
    label: str
    icon: str | None = None
    description: str = ""
    ports: list[Port] = Field(default_factory=list)
    config_schema: dict[str, Any] = Field(default_factory=dict)


@dataclass
class NodeOutput:
    """The result of compiling one node.

    ``outputs`` feeds downstream nodes; ``fragment`` is merged into the final
    qlib workflow config.
    """

    outputs: dict[str, Any] = field(default_factory=dict)
    fragment: dict[str, Any] = field(default_factory=dict)
