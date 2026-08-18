"""Validate a Keycard DAG."""
from __future__ import annotations

from .compiler import _topological_order
from .models import Defect, KeycardSpec, Node
from .registry import get_node_type


def _node_path(node: Node) -> str:
    return f"nodes[{node.id}]"


def _edge_path(edge_id: str) -> str:
    return f"edges[{edge_id}]"


def _port_meta(node_type_id: str, port_id: str, direction: str):
    nt = get_node_type(node_type_id)
    if nt is None:
        return None
    for p in nt.meta().ports:
        if p.id == port_id and p.direction == direction:
            return p
    return None


def _has_rule_signal_path(keycard: KeycardSpec) -> bool:
    """Return True when a buy_now node can reach a portfolio node by edges."""
    node_by_id = {n.id: n for n in keycard.nodes}
    adj: dict[str, list[str]] = {n.id: [] for n in keycard.nodes}
    for edge in keycard.edges:
        if edge.source in adj:
            adj[edge.source].append(edge.target)

    buy_now_ids = [n.id for n in keycard.nodes if n.type == "buy_now"]
    portfolio_ids = {n.id for n in keycard.nodes if n.type == "portfolio"}
    if not buy_now_ids or not portfolio_ids:
        return False

    for start in buy_now_ids:
        seen: set[str] = set()
        stack = [start]
        while stack:
            current = stack.pop()
            if current in portfolio_ids:
                return True
            if current in seen:
                continue
            seen.add(current)
            stack.extend(adj.get(current, []))
    return False


def _nodes_reaching_records(keycard: KeycardSpec) -> set[str]:
    """IDs of nodes with a directed path to at least one records node."""
    records_ids = {n.id for n in keycard.nodes if n.type == "records"}
    if not records_ids:
        return set()

    # Reverse adjacency: for each node, who points to it.
    reverse: dict[str, list[str]] = {n.id: [] for n in keycard.nodes}
    for edge in keycard.edges:
        if edge.target in reverse:
            reverse[edge.target].append(edge.source)

    reaching: set[str] = set(records_ids)
    stack = list(records_ids)
    while stack:
        current = stack.pop()
        for predecessor in reverse.get(current, []):
            if predecessor not in reaching:
                reaching.add(predecessor)
                stack.append(predecessor)
    return reaching


def validate_keycard(keycard: KeycardSpec) -> list[Defect]:
    """Every defect in a keycard, in keycard coordinates.

    Checks for cycles, disconnected required ports, port type mismatches,
    missing required node categories, and delegates per-node validation to the
    registered node type.
    """
    defects: list[Defect] = []
    node_by_id = {n.id: n for n in keycard.nodes}

    # Unknown node types are caught first so later checks don't crash.
    for node in keycard.nodes:
        if get_node_type(node.type) is None:
            defects.append(Defect(
                "unknown_node_type",
                f"Unknown node type {node.type!r}.",
                _node_path(node), "blocking"))

    # Cycles
    order = _topological_order(keycard)
    if len(order) != len(keycard.nodes):
        defects.append(Defect(
            "cycle",
            "The workflow graph contains a cycle.",
            "edges", "blocking"))

    # Edges reference real nodes and ports.
    for edge in keycard.edges:
        src = node_by_id.get(edge.source)
        tgt = node_by_id.get(edge.target)
        if src is None:
            defects.append(Defect(
                "dangling_source",
                f"Edge {edge.id!r} references unknown source node {edge.source!r}.",
                _edge_path(edge.id), "blocking"))
            continue
        if tgt is None:
            defects.append(Defect(
                "dangling_target",
                f"Edge {edge.id!r} references unknown target node {edge.target!r}.",
                _edge_path(edge.id), "blocking"))
            continue
        src_port = _port_meta(src.type, edge.source_port, "out")
        tgt_port = _port_meta(tgt.type, edge.target_port, "in")
        if src_port is None:
            defects.append(Defect(
                "missing_source_port",
                f"Node {src.id!r} has no port {edge.source_port!r}.",
                _edge_path(edge.id), "blocking"))
        if tgt_port is None:
            defects.append(Defect(
                "missing_target_port",
                f"Node {tgt.id!r} has no port {edge.target_port!r}.",
                _edge_path(edge.id), "blocking"))
        if src_port is not None and tgt_port is not None:
            if src_port.direction != "out":
                defects.append(Defect(
                    "source_port_not_output",
                    f"Port {edge.source_port!r} on {src.id!r} is not an output.",
                    _edge_path(edge.id), "blocking"))
            if tgt_port.direction != "in":
                defects.append(Defect(
                    "target_port_not_input",
                    f"Port {edge.target_port!r} on {tgt.id!r} is not an input.",
                    _edge_path(edge.id), "blocking"))
            if src_port.type != tgt_port.type:
                defects.append(Defect(
                    "port_type_mismatch",
                    f"Cannot connect {src_port.type!r} port {edge.source_port!r} "
                    f"to {tgt_port.type!r} port {edge.target_port!r}.",
                    _edge_path(edge.id), "blocking"))

    # Required input ports connected.
    incoming_by_target: dict[str, set[str]] = {}
    for edge in keycard.edges:
        incoming_by_target.setdefault(edge.target, set()).add(edge.target_port)

    for node in keycard.nodes:
        nt = get_node_type(node.type)
        if nt is None:
            continue
        connected = incoming_by_target.get(node.id, set())
        for port in nt.meta().ports:
            if port.direction == "in" and port.required and port.id not in connected:
                defects.append(Defect(
                    "missing_required_port",
                    f"Required input port {port.id!r} on node {node.id!r} is not connected.",
                    f"{_node_path(node)}.ports[{port.id}]", "blocking"))

    # Required / recommended node categories.
    type_counts: dict[str, int] = {}
    for node in keycard.nodes:
        type_counts[node.type] = type_counts.get(node.type, 0) + 1

    # Rule-based workflows (Schedule -> Rules -> buy_now -> portfolio) do not
    # need a model because the signal is a compiled boolean expression.
    has_rule_path = _has_rule_signal_path(keycard)
    if type_counts.get("model", 0) == 0 and not has_rule_path:
        defects.append(Defect(
            "missing_model",
            "A model node is required to produce predictions.",
            "nodes", "blocking"))
    if type_counts.get("portfolio", 0) == 0:
        defects.append(Defect(
            "missing_portfolio",
            "A portfolio node is required to turn predictions into trades.",
            "nodes", "blocking"))
    if type_counts.get("records", 0) == 0:
        defects.append(Defect(
            "missing_records",
            "No records node is attached; the run will not report metrics.",
            "nodes", "advisory"))

    # Disconnected subgraphs: nodes that cannot affect the backtest output.
    reaching_records = _nodes_reaching_records(keycard)
    # Data/global nodes are always allowed because they set context for the
    # compiled workflow even when they are not wired directly to records.
    exempt_types = {"data_store", "universe", "chart_drawing", "variable"}
    for node in keycard.nodes:
        if node.id in reaching_records or node.type in exempt_types:
            continue
        defects.append(Defect(
            "disconnected_subgraph",
            f"Node {node.id!r} is not connected to a records node and will not "
            f"affect the backtest.",
            _node_path(node), "advisory"))

    # Per-node validation.
    for node in keycard.nodes:
        nt = get_node_type(node.type)
        if nt is None:
            continue
        try:
            for defect in nt.validate(node.config, keycard):
                path = defect.path.replace("nodes[?]", f"nodes[{node.id}]")
                defects.append(Defect(
                    defect.code, defect.message, path, defect.severity))
        except Exception as exc:  # noqa: BLE001
            defects.append(Defect(
                "validation_error",
                f"Could not validate {node.type!r} node: {exc}",
                _node_path(node), "blocking"))

    return defects
