"""Translate between the flat StrategySpec and the Keycard DAG.

These adapters exist only during the transition from the 7-stage spec to the
DAG builder. ``strategy_to_keycard`` is the forward path; ``keycard_to_strategy``
is a best-effort reverse for the simple linear chain the legacy UI currently
produces.
"""
from __future__ import annotations

import uuid
from typing import Any

from ..strategies import FeatureColumn, StrategySpec
from .models import Edge, Keycard, Node, Position, Windows


# Vertical layout shared by every converted spec.
_LEFT = 200
_TOP = 100
_SPACING = 180


_NodePlan = tuple[str, str, dict[str, Any]]


def _plan(spec: StrategySpec) -> list[_NodePlan]:
    """The linear 7-node plan that mirrors StrategySpec."""
    return [
        ("data_store", "store-1", {"store": spec.data_store}),
        ("universe", "universe-1", {"universe": spec.universe, "benchmark": spec.benchmark}),
        ("handler", "handler-1", {
            "handler": spec.handler,
            "feature_mode": spec.feature_mode,
            "features": [f.model_dump() for f in spec.features] if spec.features else None,
        }),
        ("model", "model-1", {"model": spec.model}),
        ("portfolio", "portfolio-1", {
            "strategy": "TopkDropoutStrategy",
            "topk": spec.topk,
            "n_drop": spec.n_drop,
        }),
        ("costs", "costs-1", {
            "open_cost": spec.open_cost,
            "close_cost": spec.close_cost,
            "min_cost": spec.min_cost,
            "account": spec.account,
            "limit_threshold": spec.limit_threshold,
        }),
        ("records", "records-1", {}),
    ]


def strategy_to_keycard(spec: StrategySpec) -> Keycard:
    """Convert a flat StrategySpec into a linear Keycard DAG."""
    plan = _plan(spec)
    nodes: list[Node] = []
    for i, (node_type, node_id, cfg) in enumerate(plan):
        nodes.append(Node(
            id=node_id,
            type=node_type,
            position=Position(x=_LEFT, y=_TOP + i * _SPACING),
            config={k: v for k, v in cfg.items() if v is not None},
        ))

    edges: list[Edge] = []
    for i in range(len(plan) - 1):
        src_id, tgt_id = plan[i][1], plan[i + 1][1]
        edges.append(Edge(
            id=f"e{i}",
            source=src_id,
            source_port="data" if plan[i][0] in ("data_store", "universe") else
                       "features" if plan[i][0] == "handler" else
                       "signal" if plan[i][0] == "model" else
                       "trades",
            target=tgt_id,
            target_port="data" if plan[i + 1][0] in ("data_store", "universe", "handler") else
                        "features" if plan[i + 1][0] == "model" else
                        "signal" if plan[i + 1][0] == "portfolio" else
                        "trades",
        ))

    return Keycard(
        id=uuid.uuid4().hex[:12],
        name=spec.name,
        description="",
        tags=[],
        is_template=False,
        template_family=None,
        nodes=nodes,
        edges=edges,
        windows=Windows(
            train_start=spec.train_start,
            train_end=spec.train_end,
            valid_start=spec.valid_start,
            valid_end=spec.valid_end,
            test_start=spec.test_start,
            test_end=spec.test_end,
        ),
    )


def keycard_to_strategy(keycard: Keycard) -> StrategySpec | None:
    """Best-effort reverse adapter for a simple linear chain.

    Returns ``None`` if the graph is not a single chain matching the legacy
    seven-stage pipeline.
    """
    if not keycard.nodes:
        return None

    node_by_id = {n.id: n for n in keycard.nodes}
    node_by_type: dict[str, Node] = {}
    for node in keycard.nodes:
        if node.type in node_by_type:
            # More than one node of the same type: not a simple legacy chain.
            return None
        node_by_type[node.type] = node

    expected_types = ["data_store", "universe", "handler", "model", "portfolio", "costs", "records"]
    if set(node_by_type) != set(expected_types):
        return None

    # Verify the chain edges.
    for i in range(len(expected_types) - 1):
        src = node_by_type[expected_types[i]]
        tgt = node_by_type[expected_types[i + 1]]
        if not any(e.source == src.id and e.target == tgt.id for e in keycard.edges):
            return None

    # No extra edges.
    if len(keycard.edges) != len(expected_types) - 1:
        return None

    store_cfg = node_by_type["data_store"].config
    universe_cfg = node_by_type["universe"].config
    handler_cfg = node_by_type["handler"].config
    model_cfg = node_by_type["model"].config
    portfolio_cfg = node_by_type["portfolio"].config
    costs_cfg = node_by_type["costs"].config

    features = handler_cfg.get("features")
    return StrategySpec(
        name=keycard.name,
        model=model_cfg.get("model", "lightgbm"),
        handler=handler_cfg.get("handler", "Alpha158"),
        data_store=store_cfg.get("store", "us"),
        universe=universe_cfg.get("universe", "top500"),
        benchmark=universe_cfg.get("benchmark", "SPY"),
        train_start=keycard.windows.train_start,
        train_end=keycard.windows.train_end,
        valid_start=keycard.windows.valid_start,
        valid_end=keycard.windows.valid_end,
        test_start=keycard.windows.test_start,
        test_end=keycard.windows.test_end,
        topk=portfolio_cfg.get("topk", 50),
        n_drop=portfolio_cfg.get("n_drop", 5),
        open_cost=costs_cfg.get("open_cost", 0.0005),
        close_cost=costs_cfg.get("close_cost", 0.0015),
        min_cost=costs_cfg.get("min_cost", 5.0),
        account=costs_cfg.get("account", 100_000_000),
        limit_threshold=costs_cfg.get("limit_threshold"),
        features=[FeatureColumn(**f) for f in features] if features else None,
        feature_mode=handler_cfg.get("feature_mode", "extend"),
    )
