"""Keycard workflow builder: a DAG-based replacement for the flat strategy spec.

This package is additive in Phase 1. Existing ``StrategySpec`` /
``build_workflow_config`` code paths are untouched; the keycard layer lives
alongside them and can be translated back and forth via ``adapter``.
"""
from __future__ import annotations

from .adapter import keycard_to_strategy, strategy_to_keycard
from .compiler import compile_keycard, render_keycard_yaml
from .models import Defect, Edge, Keycard, KeycardSpec, Node, Windows
from .nodes import costs, data, features, model, portfolio, records  # noqa: F401
from .registry import get_node_type, list_node_types, node_schema, register
from .validator import validate_keycard

__all__ = [
    "Keycard",
    "KeycardSpec",
    "Node",
    "Edge",
    "Defect",
    "Windows",
    "compile_keycard",
    "render_keycard_yaml",
    "validate_keycard",
    "strategy_to_keycard",
    "keycard_to_strategy",
    "list_node_types",
    "get_node_type",
    "node_schema",
    "register",
]
