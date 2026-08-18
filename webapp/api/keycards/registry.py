"""Node type registry for the Keycard workflow builder.

Every concrete node type inherits from ``NodeType`` and is registered once at
package import time. The builder reads the registry to draw the palette and to
compile a keycard into a qlib workflow config.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, TypedDict

from .models import Defect, KeycardSpec, NodeOutput, NodeTypeMeta, Windows


class NodeType(ABC):
    """One kind of node in the workflow DAG.

    Node types are stateless callables. The registry stores one instance of
    each concrete class; that instance is reused for validation, schema
    introspection and compilation.
    """

    @abstractmethod
    def meta(self) -> NodeTypeMeta:
        """Static metadata shown in the palette."""

    @abstractmethod
    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        """Turn this node's config and incoming wires into a config fragment."""

    @abstractmethod
    def validate(self, config: dict, keycard: KeycardSpec) -> list[Defect]:
        """Check this node's own config, independent of graph topology."""


NODE_TYPES: dict[str, NodeType] = {}


class NodeCategory(TypedDict):
    """One palette drawer."""

    id: str
    label: str
    items: list[dict]


def register(nt: NodeType) -> NodeType:
    """Add a node type to the global registry."""
    meta = nt.meta()
    NODE_TYPES[meta.id] = nt
    return nt


def list_node_types() -> list[NodeCategory]:
    """All registered node types grouped by category."""
    by_cat: dict[str, NodeCategory] = {}
    for nt in NODE_TYPES.values():
        meta = nt.meta()
        cat = by_cat.setdefault(meta.category, {
            "id": meta.category,
            "label": meta.category.replace("_", " ").title(),
            "items": [],
        })
        cat["items"].append(meta.model_dump())
    return list(by_cat.values())


def get_node_type(id: str) -> NodeType | None:
    """Look up a registered node type by id."""
    return NODE_TYPES.get(id)


def node_schema(id: str) -> dict | None:
    """Return the JSON-ish schema for a registered node type, or None."""
    nt = NODE_TYPES.get(id)
    if nt is None:
        return None
    return nt.meta().model_dump()
