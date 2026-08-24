"""Tests for the Keycard DAG workflow builder."""
from __future__ import annotations

import pytest

from ...strategies import StrategySpec, build_workflow_config
from ..adapter import keycard_to_strategy, strategy_to_keycard
from ..compiler import compile_keycard
from ..models import Edge, Keycard, Node, Position, Port, Windows
from ..registry import list_node_types
from ..validator import validate_keycard


def test_strategy_to_keycard_roundtrip_fields():
    """Every StrategySpec field survives conversion into keycard nodes."""
    spec = StrategySpec(
        name="Roundtrip Test",
        model="xgboost",
        handler="Alpha360",
        data_store="crypto_365",
        universe="crypto_top100",
        benchmark="BTC-USD",
        train_start="2018-01-01",
        train_end="2020-12-31",
        valid_start="2021-01-01",
        valid_end="2021-12-31",
        test_start="2022-01-01",
        test_end="2023-12-31",
        topk=30,
        n_drop=3,
        open_cost=0.001,
        close_cost=0.002,
        min_cost=10.0,
        account=50_000_000,
        limit_threshold=0.5,
        features=[{"name": "MOM5", "expression": "Ref($close,-5)/$close-1"}],
        feature_mode="replace",
    )
    keycard = strategy_to_keycard(spec)

    by_type = {n.type: n.config for n in keycard.nodes}
    assert by_type["data_store"]["store"] == "crypto_365"
    assert by_type["universe"]["universe"] == "crypto_top100"
    assert by_type["universe"]["benchmark"] == "BTC-USD"
    assert by_type["handler"]["handler"] == "Alpha360"
    assert by_type["handler"]["feature_mode"] == "replace"
    assert by_type["handler"]["features"][0]["name"] == "MOM5"
    assert by_type["model"]["model"] == "xgboost"
    assert by_type["portfolio"]["topk"] == 30
    assert by_type["portfolio"]["n_drop"] == 3
    assert by_type["costs"]["open_cost"] == 0.001
    assert by_type["costs"]["limit_threshold"] == 0.5
    assert keycard.windows.train_start == "2018-01-01"
    assert keycard.windows.test_end == "2023-12-31"


def test_compile_matches_legacy(tmp_path):
    """A keycard built from a spec compiles to the same workflow config."""
    provider_uri = str(tmp_path / "qlib_data")
    region = "us"
    spec = StrategySpec(
        name="Compile Match",
        model="lightgbm",
        handler="Alpha158",
        data_store="us",
        universe="top500",
        benchmark="SPY",
        features=[{"name": "MOM5", "expression": "Ref($close,-5)/$close-1"}],
        feature_mode="extend",
    )
    keycard = strategy_to_keycard(spec)

    legacy = build_workflow_config(spec, provider_uri, region)
    dag = compile_keycard(keycard, provider_uri, region)

    assert dag == legacy


def test_validate_detects_cycle():
    """A cyclic graph is reported as a blocking defect."""
    nodes = [
        Node(id="a", type="model", position=Position(x=0, y=0),
             config={"model": "lightgbm"}),
        Node(id="b", type="portfolio", position=Position(x=0, y=0),
             config={"strategy": "TopkDropoutStrategy", "topk": 50, "n_drop": 5}),
    ]
    edges = [
        Edge(id="e1", source="a", source_port="signal", target="b", target_port="signal"),
        Edge(id="e2", source="b", source_port="trades", target="a", target_port="features"),
    ]
    keycard = Keycard(
        id="cycle-test", name="cycle", nodes=nodes, edges=edges,
        windows=Windows(),
    )
    defects = validate_keycard(keycard)
    codes = {d.code for d in defects}
    assert "cycle" in codes
    assert any(d.severity == "blocking" for d in defects if d.code == "cycle")


def test_validate_detects_missing_required_port():
    """A model node with no features input is flagged."""
    nodes = [
        Node(id="m", type="model", position=Position(x=0, y=0),
             config={"model": "lightgbm"}),
    ]
    keycard = Keycard(
        id="missing-port-test", name="missing port", nodes=nodes, edges=[],
        windows=Windows(),
    )
    defects = validate_keycard(keycard)
    codes = {d.code for d in defects}
    assert "missing_required_port" in codes


def test_list_node_types_returns_expected_categories():
    """The palette contains the expected categories."""
    categories = list_node_types()
    cat_ids = {c["id"] for c in categories}
    assert "data" in cat_ids
    assert "features" in cat_ids
    assert "model" in cat_ids
    assert "portfolio" in cat_ids
    assert "output" in cat_ids

    # Every registered node type appears exactly once.
    all_items = [item["id"] for cat in categories for item in cat["items"]]
    assert "data_store" in all_items
    assert "universe" in all_items
    assert "handler" in all_items
    assert "model" in all_items
    assert "portfolio" in all_items
    assert "costs" in all_items
    assert "records" in all_items
    # Aion-style blocks are registered too.
    assert "buy_now" in all_items
    assert "previous_day_bullish" in all_items


def test_rule_based_workflow_compiles_without_model(tmp_path):
    """A Aion-style rule chain can replace the model/handler pipeline."""
    provider_uri = str(tmp_path / "qlib_data")
    keycard = Keycard(
        id="rule-test", name="Rule breakout",
        nodes=[
            Node(id="sched-1", type="run_per_candle", position=Position(x=0, y=0), config={}),
            Node(id="rule-1", type="previous_day_bullish", position=Position(x=0, y=100), config={}),
            Node(id="rule-2", type="price_above_previous_day_close", position=Position(x=0, y=200), config={}),
            Node(id="buy-1", type="buy_now", position=Position(x=0, y=300), config={}),
            Node(id="port-1", type="portfolio", position=Position(x=0, y=400),
                 config={"strategy": "TopkDropoutStrategy", "topk": 10, "n_drop": 0}),
            Node(id="costs-1", type="costs", position=Position(x=0, y=500),
                 config={"open_cost": 0.0005, "close_cost": 0.0015,
                         "min_cost": 5.0, "account": 1_000_000}),
            Node(id="rec-1", type="records", position=Position(x=0, y=600), config={}),
        ],
        edges=[
            Edge(id="e1", source="sched-1", source_port="trigger",
                 target="rule-1", target_port="trigger"),
            Edge(id="e2", source="rule-1", source_port="trigger",
                 target="rule-2", target_port="trigger"),
            Edge(id="e3", source="rule-2", source_port="trigger",
                 target="buy-1", target_port="trigger"),
            Edge(id="e4", source="buy-1", source_port="signal",
                 target="port-1", target_port="signal"),
            Edge(id="e5", source="port-1", source_port="trades",
                 target="costs-1", target_port="trades"),
            Edge(id="e6", source="costs-1", source_port="trades",
                 target="rec-1", target_port="trades"),
        ],
        windows=Windows(),
    )

    defects = validate_keycard(keycard)
    blocking = [d for d in defects if d.severity == "blocking"]
    assert not blocking, blocking
    assert not any(d.code == "missing_model" for d in defects)

    config = compile_keycard(keycard, provider_uri, "us")
    strategy = config["port_analysis_config"]["strategy"]
    assert strategy["class"] == "RuleFlowStrategy"
    assert strategy["module_path"] == "qlib.contrib.strategy.rule_flow"
    assert "rule_expr" in strategy["kwargs"]
    assert "data_handler_config" not in config
    assert [r["class"] for r in config["task"].get("record", [])] == ["PortAnaRecord"]


def test_multiple_rules_merge_into_buy_now(tmp_path):
    """Several rule nodes can wire into the same trigger input."""
    provider_uri = str(tmp_path / "qlib_data")
    keycard = Keycard(
        id="merge-test", name="Merged rules",
        nodes=[
            Node(id="sched-1", type="run_per_candle", position=Position(x=0, y=0), config={}),
            Node(id="rule-1", type="previous_day_bullish", position=Position(x=0, y=100), config={}),
            Node(id="rule-2", type="price_above_previous_day_close", position=Position(x=0, y=200), config={}),
            Node(id="buy-1", type="buy_now", position=Position(x=0, y=300), config={}),
            Node(id="port-1", type="portfolio", position=Position(x=0, y=400),
                 config={"strategy": "TopkDropoutStrategy", "topk": 10, "n_drop": 0}),
            Node(id="costs-1", type="costs", position=Position(x=0, y=500),
                 config={"open_cost": 0.0005, "close_cost": 0.0015,
                         "min_cost": 5.0, "account": 1_000_000}),
            Node(id="rec-1", type="records", position=Position(x=0, y=600), config={}),
        ],
        edges=[
            Edge(id="e1", source="sched-1", source_port="trigger",
                 target="rule-1", target_port="trigger"),
            Edge(id="e2", source="sched-1", source_port="trigger",
                 target="rule-2", target_port="trigger"),
            Edge(id="e3", source="rule-1", source_port="trigger",
                 target="buy-1", target_port="trigger"),
            Edge(id="e4", source="rule-2", source_port="trigger",
                 target="buy-1", target_port="trigger"),
            Edge(id="e5", source="buy-1", source_port="signal",
                 target="port-1", target_port="signal"),
            Edge(id="e6", source="port-1", source_port="trades",
                 target="costs-1", target_port="trades"),
            Edge(id="e7", source="costs-1", source_port="trades",
                 target="rec-1", target_port="trades"),
        ],
        windows=Windows(),
    )

    defects = validate_keycard(keycard)
    blocking = [d for d in defects if d.severity == "blocking"]
    assert not blocking, blocking

    config = compile_keycard(keycard, provider_uri, "us")
    rule_expr = config["port_analysis_config"]["strategy"]["kwargs"]["rule_expr"]
    assert "Ref($close,-1) > Ref($open,-1)" in rule_expr
    assert "$close > Ref($close,-1)" in rule_expr


def test_validator_rejects_second_edge_into_non_multiple_port():
    """A non-multiple input port can only have one incoming edge."""
    nodes = [
        Node(id="store-1", type="data_store", position=Position(x=0, y=0), config={"store": "us"}),
        Node(id="store-2", type="data_store", position=Position(x=0, y=100), config={"store": "crypto_365"}),
        Node(id="universe-1", type="universe", position=Position(x=0, y=200), config={}),
    ]
    edges = [
        Edge(id="e1", source="store-1", source_port="data",
             target="universe-1", target_port="data"),
        Edge(id="e2", source="store-2", source_port="data",
             target="universe-1", target_port="data"),
    ]
    keycard = Keycard(
        id="multi-edge-test", name="multi edge", nodes=nodes, edges=edges,
        windows=Windows(),
    )
    defects = validate_keycard(keycard)
    codes = {d.code for d in defects}
    assert "too_many_incoming_edges" in codes


def test_context_node_is_allowed_in_a_valid_keycard():
    """A context node is an annotation and does not add its own defects."""
    nodes = [
        Node(id="store-1", type="data_store", position=Position(x=0, y=0),
             config={"store": "us"}),
        Node(id="universe-1", type="universe", position=Position(x=0, y=100),
             config={"universe": "top500", "benchmark": "SPY"}),
        Node(id="handler-1", type="handler", position=Position(x=0, y=200),
             config={"handler": "Alpha158", "feature_mode": "extend"}),
        Node(id="model-1", type="model", position=Position(x=0, y=300),
             config={"model": "lightgbm"}),
        Node(id="portfolio-1", type="portfolio", position=Position(x=0, y=400),
             config={"strategy": "TopkDropoutStrategy", "topk": 50, "n_drop": 5}),
        Node(id="costs-1", type="costs", position=Position(x=0, y=500),
             config={"open_cost": 0.0005, "close_cost": 0.0015,
                     "min_cost": 5, "account": 100_000_000}),
        Node(id="records-1", type="records", position=Position(x=0, y=600), config={}),
        Node(id="c", type="context", position=Position(x=200, y=0),
             config={"text": "Lower volatility than the benchmark"}),
    ]
    edges = [
        Edge(id="e1", source="store-1", source_port="data",
             target="universe-1", target_port="data"),
        Edge(id="e2", source="universe-1", source_port="data",
             target="handler-1", target_port="data"),
        Edge(id="e3", source="handler-1", source_port="features",
             target="model-1", target_port="features"),
        Edge(id="e4", source="model-1", source_port="signal",
             target="portfolio-1", target_port="signal"),
        Edge(id="e5", source="portfolio-1", source_port="trades",
             target="costs-1", target_port="trades"),
        Edge(id="e6", source="costs-1", source_port="trades",
             target="records-1", target_port="trades"),
    ]
    keycard = Keycard(
        id="context-test", name="context", nodes=nodes, edges=edges,
        windows=Windows(),
    )
    defects = validate_keycard(keycard)
    assert not any(d.severity == "blocking" for d in defects)


def test_context_node_is_in_palette():
    """The palette serves the context node type."""
    categories = list_node_types()
    ids = {item["id"] for cat in categories for item in cat["items"]}
    assert "context" in ids
