"""Compile a Keycard DAG into a qlib workflow config.

The compiler topologically sorts the nodes, evaluates each one in turn, and
merges the emitted fragments into the same shape produced by
``strategies.build_workflow_config``.
"""
from __future__ import annotations

from typing import Any

import yaml

from ..marketdata import store_calendar_end
from ..strategies import HANDLERS, MODEL_SPECS
from .models import Defect, KeycardSpec, NodeOutput, Windows
from .registry import NODE_TYPES, get_node_type


# ---------------------------------------------------------------------------
# Incoming value helpers
# ---------------------------------------------------------------------------
def _merge_triggers(values: list[str]) -> str:
    """AND-combine a list of trigger expressions, omitting neutral '1'."""
    parts = [v for v in values if v and v != "1"]
    if not parts:
        return "1"
    if len(parts) == 1:
        return parts[0]
    return " * ".join(f"({p})" for p in parts)


# ---------------------------------------------------------------------------
# Topological sort
# ---------------------------------------------------------------------------
def _topological_order(keycard: KeycardSpec) -> list[str]:
    """Kahn's algorithm over the keycard edges."""
    ids = {n.id for n in keycard.nodes}
    in_degree: dict[str, int] = {n.id: 0 for n in keycard.nodes}
    adj: dict[str, list[str]] = {n.id: [] for n in keycard.nodes}
    for edge in keycard.edges:
        if edge.source not in ids or edge.target not in ids:
            continue
        adj[edge.source].append(edge.target)
        in_degree[edge.target] += 1

    queue = [n for n, d in in_degree.items() if d == 0]
    order: list[str] = []
    while queue:
        # Deterministic order for tests.
        queue.sort()
        current = queue.pop(0)
        order.append(current)
        for nxt in sorted(adj[current]):
            in_degree[nxt] -= 1
            if in_degree[nxt] == 0:
                queue.append(nxt)
    return order


# ---------------------------------------------------------------------------
# Fragment merge
# ---------------------------------------------------------------------------
def _deep_merge(base: dict, update: dict) -> dict:
    """Merge ``update`` into ``base`` recursively; arrays are replaced."""
    for key, value in update.items():
        if isinstance(value, dict) and key in base and isinstance(base[key], dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


# ---------------------------------------------------------------------------
# Handler config helpers
# ---------------------------------------------------------------------------
# TODO: these helpers duplicate logic from webapp.api.strategies because that
# module keeps the implementations private. When keycards replace the flat
# spec, move the canonical versions here or make them public in strategies.

_NEEDS_FINITE_FEATURES = {"linear"}

_BASE_LOADERS = {
    "Alpha158": {"class": "Alpha158DL", "module_path": "qlib.contrib.data.loader"},
    "Alpha360": {"class": "Alpha360DL", "module_path": "qlib.contrib.data.loader"},
}

_COLUMNS_NEEDING: dict[str, dict[str, str]] = {
    "Alpha158": {"VWAP0": "vwap"},
    "Alpha360": {f"VWAP{i}": "vwap" for i in range(60)},
}

_FINITE_INFER_PROCESSORS = [
    {"class": "RobustZScoreNorm",
     "kwargs": {"fields_group": "feature", "clip_outlier": True}},
    {"class": "Fillna", "kwargs": {"fields_group": "feature"}},
]


def _dead_columns(handler: str, provider_uri: str) -> list[str]:
    """Handler columns this store cannot compute, so they are all-NaN."""
    from ..factorlab.stores import census

    needs = _COLUMNS_NEEDING.get(handler)
    if not needs:
        return []
    found = census(provider_uri)
    available = set(found.get("fields", []))
    if not available:
        return []
    return sorted(col for col, field in needs.items() if field not in available)


def _processor_recipe(handler: str, model: str, fit_start: str, fit_end: str) -> tuple[list, list]:
    """The infer/learn processor lists this handler/model pair needs."""
    import copy as _copy
    import inspect as _inspect

    from qlib.contrib.data.handler import Alpha158, Alpha360, check_transform_proc

    cls = {"Alpha158": Alpha158, "Alpha360": Alpha360}[handler]
    defaults = _inspect.signature(cls.__init__).parameters
    infer = (_FINITE_INFER_PROCESSORS if model in _NEEDS_FINITE_FEATURES
             else defaults["infer_processors"].default)
    return (
        check_transform_proc(_copy.deepcopy(infer), fit_start, fit_end),
        check_transform_proc(_copy.deepcopy(defaults["learn_processors"].default),
                             fit_start, fit_end),
    )


def _custom_handler(
    handler: str,
    feature_mode: str,
    features: list[dict] | None,
    universe: str,
    train_start: str,
    test_end: str,
    infer: list,
    learn: list,
) -> dict:
    """A DataHandlerLP that computes the user's own columns."""
    from ..factorlab.indicators import handler_label

    label_expressions, label_names = handler_label(handler)
    custom = {
        "feature": [
            [f["expression"] for f in features],
            [f["name"] for f in features],
        ],
        "label": [list(label_expressions), list(label_names)],
    }
    custom_loader = {
        "class": "QlibDataLoader",
        "module_path": "qlib.data.dataset.loader",
        "kwargs": {"config": custom},
    }

    if feature_mode == "replace":
        data_loader = custom_loader
    else:
        data_loader = {
            "class": "NestedDataLoader",
            "module_path": "qlib.data.dataset.loader",
            "kwargs": {"dataloader_l": [_BASE_LOADERS[handler], custom_loader]},
        }

    return {
        "class": "DataHandlerLP",
        "module_path": "qlib.data.dataset.handler",
        "kwargs": {
            "instruments": universe,
            "start_time": train_start,
            "end_time": test_end,
            "infer_processors": infer,
            "learn_processors": learn,
            "process_type": "append",
            "data_loader": data_loader,
        },
    }


def _build_handler_config(
    handler_req: dict,
    model: str,
    windows: Windows,
    provider_uri: str,
) -> tuple[dict, dict]:
    """Build the ``task.dataset.kwargs.handler`` block and the top-level
    ``data_handler_config``.

    Mirrors ``strategies.build_workflow_config`` for the default and custom
    handler paths. Returns ``(handler_config, data_handler_config)`` because the
    legacy layout keeps a top-level ``data_handler_config`` that may differ from
    the handler's own ``kwargs`` when custom features are present.
    """
    handler = handler_req["handler"]
    feature_mode = handler_req.get("feature_mode", "extend")
    features = handler_req.get("features")
    universe = handler_req.get("universe", "top500")

    data_handler_config = {
        "start_time": windows.train_start,
        "end_time": windows.test_end,
        "fit_start_time": windows.train_start,
        "fit_end_time": windows.train_end,
        "instruments": universe,
    }

    dead = _dead_columns(handler, provider_uri)
    if dead or model in _NEEDS_FINITE_FEATURES:
        infer, learn = _processor_recipe(handler, model,
                                         windows.train_start, windows.train_end)
        if dead:
            drop = {"class": "DropCol", "module_path": "qlib.data.dataset.processor",
                    "kwargs": {"col_list": dead}}
            infer, learn = [drop, *infer], [drop, *learn]
        data_handler_config["infer_processors"] = infer
        data_handler_config["learn_processors"] = learn

    if features:
        # The custom handler recomputes its own processor lists in the legacy
        # path, so we give it a fresh pair rather than the drop-prepended one.
        infer, learn = _processor_recipe(handler, model,
                                         windows.train_start, windows.train_end)
        handler_config = _custom_handler(handler, feature_mode, features, universe,
                                         windows.train_start, windows.test_end,
                                         infer, learn)
    else:
        handler_config = {
            "class": handler,
            "module_path": HANDLERS[handler],
            "kwargs": data_handler_config,
        }

    return handler_config, data_handler_config


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def compile_keycard(keycard: KeycardSpec, provider_uri: str, region: str) -> dict:
    """Render a Keycard into a qlib workflow config dict.

    The output matches ``strategies.build_workflow_config`` for a simple linear
    chain of one store, universe, handler, model, portfolio, costs and records
    node.
    """
    # Resolve the store early so every node sees the clamped test end.
    store_key = "us"
    store_node = next((n for n in keycard.nodes if n.type == "data_store"), None)
    if store_node is not None:
        store_key = store_node.config.get("store", "us")

    safe_end = store_calendar_end(store_key)
    windows = keycard.windows
    if safe_end and windows.test_end > safe_end:
        windows = windows.model_copy(update={"test_end": safe_end})

    order = _topological_order(keycard)
    if len(order) != len(keycard.nodes):
        # Cycles are caught by the validator; here we just refuse to compile.
        raise ValueError("Keycard contains a cycle")

    node_by_id = {n.id: n for n in keycard.nodes}
    outputs: dict[str, dict[str, Any]] = {}
    fragments: dict[str, Any] = {}

    for node_id in order:
        node = node_by_id[node_id]
        nt = get_node_type(node.type)
        if nt is None:
            raise ValueError(f"Unknown node type: {node.type!r}")

        port_meta = {p.id: p for p in nt.meta().ports}
        incoming: dict[str, Any] = {}
        for edge in keycard.edges:
            if edge.target == node_id:
                src_out = outputs.get(edge.source, {})
                value = src_out.get(edge.source_port)
                port = port_meta.get(edge.target_port)
                if port is not None and port.multiple:
                    incoming.setdefault(edge.target_port, []).append(value)
                else:
                    incoming[edge.target_port] = value

        result = nt.compile(node.config, incoming, windows)
        outputs[node_id] = result.outputs
        if result.fragment:
            _deep_merge(fragments, result.fragment)

    handler_req = fragments.pop("_handler", None)
    universe_req = fragments.pop("_universe", None)
    if handler_req is not None:
        universe = handler_req.get("universe", "top500")
        benchmark = handler_req.get("benchmark", "SPY")
    elif universe_req is not None:
        universe = universe_req.get("universe", "top500")
        benchmark = universe_req.get("benchmark", "SPY")
    else:
        universe = "top500"
        benchmark = "SPY"
    model_key = "lightgbm"
    task_model = fragments.get("task", {}).get("model")
    if task_model is not None:
        model_key = next((k for k, v in MODEL_SPECS.items()
                          if v["class"] == task_model.get("class")), "lightgbm")

    handler_config: dict | None = None
    data_handler_config: dict | None = None
    if handler_req is not None:
        handler_config, data_handler_config = _build_handler_config(
            handler_req, model_key, windows, provider_uri)

    port_analysis_config: dict = fragments.pop("port_analysis_config", {})
    exchange_kwargs: dict = fragments.pop("exchange_kwargs", {})
    if "backtest" in port_analysis_config:
        port_analysis_config["backtest"]["benchmark"] = benchmark
        # Ensure exchange_kwargs from the costs node is wired into backtest.
        if "exchange_kwargs" not in port_analysis_config["backtest"]:
            port_analysis_config["backtest"]["exchange_kwargs"] = exchange_kwargs

    # Rule-based strategies need the instrument universe and benchmark because
    # they do not receive it through a model/dataset pipeline.
    strategy_cfg = port_analysis_config.get("strategy")
    if strategy_cfg is not None and strategy_cfg.get("class") == "RuleFlowStrategy":
        strategy_cfg.setdefault("kwargs", {})
        strategy_cfg["kwargs"]["instruments"] = universe
        strategy_cfg["kwargs"]["benchmark"] = benchmark

    task: dict[str, Any] = fragments.pop("task", {})
    if handler_config is not None:
        task["dataset"] = {
            "class": "DatasetH",
            "module_path": "qlib.data.dataset",
            "kwargs": {
                "handler": handler_config,
                "segments": {
                    "train": [windows.train_start, windows.train_end],
                    "valid": [windows.valid_start, windows.valid_end],
                    "test": [windows.test_start, windows.test_end],
                },
            },
        }

    # Rule-based workflows have no model/dataset, so SignalRecord/SigAnaRecord
    # would fail at runtime.  Keep only the portfolio analysis record.
    if handler_config is None:
        task["record"] = [r for r in task.get("record", [])
                          if r.get("class") == "PortAnaRecord"]

    # PortAnaRecord needs the real port_analysis_config dict, not a placeholder.
    for rec in task.get("record", []):
        if rec.get("class") == "PortAnaRecord" and rec.get("kwargs", {}).get("config") == "<PORT_ANA_CONFIG>":
            rec["kwargs"]["config"] = port_analysis_config

    # Any leftover fragments are merged at the top level.
    config: dict[str, Any] = {
        "qlib_init": {"provider_uri": provider_uri, "region": region},
        "market": universe,
        "benchmark": benchmark,
    }
    if data_handler_config is not None:
        config["data_handler_config"] = data_handler_config

    config["port_analysis_config"] = port_analysis_config
    config["task"] = task

    _deep_merge(config, fragments)
    return config


def render_keycard_yaml(keycard: KeycardSpec, provider_uri: str, region: str) -> str:
    """The exact text handed to qrun for a keycard."""
    config = compile_keycard(keycard, provider_uri, region)
    return yaml.safe_dump(config, sort_keys=False, default_flow_style=False, width=100)
