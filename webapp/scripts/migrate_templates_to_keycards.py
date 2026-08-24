"""Migrate shipped strategy templates into the keycards table.

Each curated template becomes a keycard marked ``is_template=true`` with a stable
id derived from its filename, so re-running the script updates rather than
duplicates.

Usage, from the repo root::

    docker compose exec api python -m webapp.scripts.migrate_templates_to_keycards --user-id <uuid>
    docker compose exec api python -m webapp.scripts.migrate_templates_to_keycards --user-id <uuid> --apply

Without ``--apply`` it reports what it would do and writes nothing.
"""
from __future__ import annotations

import argparse
import re
import sys

from webapp.api.auth import Principal
from webapp.api.db import service_tx
from webapp.api.keycards.adapter import strategy_to_keycard
from webapp.api.keycards.models import Edge, KeycardSpec, Node, Position, Windows
from webapp.api.keycards.repo import KeycardRepo
from webapp.api.strategy_gen.draft import lower_draft
from webapp.api.strategy_gen.templates import load_templates


# Canvas layout constants.  These match the frontend defaults in
# ``webapp/ui/src/lib/keycardGraph/keycardTemplates.ts`` so migrated templates
# look the same as the static fallback gallery.
_LEFT = 100
_TOP = 300
_SPACING_X = 220
_SPACING_Y = 120

# Families that are rendered as rich Aion-style rule DAGs instead of the legacy
# linear model pipeline.
_RICH_FAMILIES = {"factors", "shape", "universe"}


def resolve_principal(user_id: str) -> Principal:
    """Build a principal for the migration owner.

    The org_id is read as service_role so the script can run without a JWT.
    Writes then go through ``KeycardRepo`` / ``user_tx`` as the target user,
    exercising the same RLS path a request would.
    """
    with service_tx() as cur:
        cur.execute(
            "SELECT default_org_id FROM public.user_profiles WHERE user_id = %s",
            (user_id,),
        )
        row = cur.fetchone()
    if row is None or row.get("default_org_id") is None:
        raise SystemExit(
            f"No user profile found for {user_id!r}. Sign in once through the UI "
            "so the signup trigger creates the profile and organisation, then re-run."
        )
    return Principal(
        user_id=user_id,
        email="templates@example.invalid",
        org_id=str(row["default_org_id"]),
        org_role="owner",
    )


def _description(template) -> str:
    """Rationale plus good_for/bad_for, so nothing from the template is lost."""
    parts = [template.rationale.strip()]
    if template.good_for:
        parts.append("Good for:\n- " + "\n- ".join(template.good_for))
    if template.bad_for:
        parts.append("Bad for:\n- " + "\n- ".join(template.bad_for))
    return "\n\n".join(parts)


def _layout(nodes: list[Node], edges: list[Edge]) -> dict[str, Position]:
    """Place nodes in a left-to-right grid keyed by topological depth.

    Annotation nodes (``context``, ``variable``, ``chart_drawing``) have no
    incoming edges and therefore sit in the leftmost column, which matches the
    example templates in the frontend fallback.
    """
    node_ids = {n.id for n in nodes}
    in_degree: dict[str, int] = {n.id: 0 for n in nodes}
    adj: dict[str, list[str]] = {n.id: [] for n in nodes}
    for edge in edges:
        if edge.source in node_ids and edge.target in node_ids:
            adj[edge.source].append(edge.target)
            in_degree[edge.target] += 1

    queue = sorted([n for n in node_ids if in_degree[n] == 0])
    depths: dict[str, int] = {n: 0 for n in node_ids}
    while queue:
        current = queue.pop(0)
        for nxt in sorted(adj[current]):
            depths[nxt] = max(depths[nxt], depths[current] + 1)
            in_degree[nxt] -= 1
            if in_degree[nxt] == 0:
                queue.append(nxt)
        queue.sort()

    by_depth: dict[int, list[str]] = {}
    for node in nodes:
        by_depth.setdefault(depths[node.id], []).append(node.id)

    positions: dict[str, Position] = {}
    for d, ids in sorted(by_depth.items()):
        for i, node_id in enumerate(ids):
            positions[node_id] = Position(
                x=_LEFT + d * _SPACING_X,
                y=_TOP + i * _SPACING_Y,
            )
    return positions


def _extract_numeric_default(expression: str) -> str:
    """Pull a plausible numeric default out of a feature expression.

    Falls back to a generic value when no obvious window appears.
    """
    # Look for numbers inside common window arguments: Std(...,20), RSI(...,14).
    match = re.search(r",\s*(\d+)\s*\)", expression)
    if match:
        return match.group(1)
    # Look for a standalone integer.
    match = re.search(r"\b(\d+)\b", expression)
    if match:
        return match.group(1)
    return "20"


def _as_boolean_condition(expression: str) -> str:
    """Wrap a raw feature expression so it reads as a boolean branch condition."""
    expression = expression.strip()
    if any(op in expression for op in (">", "<", "=", "!") if op != "="):
        # Heuristic: already contains a comparison operator.
        return expression
    return f"({expression}) > 0"


def _rich_aion_keycard(template) -> KeycardSpec:
    """Build a rich Aion-style rule DAG for factors/shape/universe templates."""
    draft = template.draft
    store = draft.data_store or "us"
    universe = draft.universe or "top500"
    benchmark = draft.benchmark or "SPY"
    topk = draft.topk if draft.topk is not None else 50
    n_drop = draft.n_drop if draft.n_drop is not None else 5
    features = draft.features or []

    prefix = template.id.replace("-", "_")
    nodes: list[Node] = []
    edges: list[Edge] = []
    edge_index = 0

    def node_id(suffix: str) -> str:
        return f"{prefix}-{suffix}"

    def add_node(suffix: str, type_: str, config: dict) -> str:
        nid = node_id(suffix)
        nodes.append(Node(
            id=nid,
            type=type_,
            position=Position(x=0, y=0),
            config=config,
            notes="",
        ))
        return nid

    def add_edge(source: str, source_port: str, target: str, target_port: str) -> None:
        nonlocal edge_index
        edge_index += 1
        edges.append(Edge(
            id=f"{prefix}-e{edge_index}",
            source=source,
            source_port=source_port,
            target=target,
            target_port=target_port,
        ))

    # Annotation / parameter nodes (left column, disconnected).
    context_text = (
        f"{template.title}. Store: {store}, universe: {universe}, "
        f"benchmark: {benchmark}. {template.rationale.strip()}"
    )
    add_node("ctx", "context", {"text": context_text[:280]})

    if features:
        first_feature = features[0]
        var_name = first_feature.name.lower()
        var_value = _extract_numeric_default(first_feature.expression)
        feature_rule = first_feature.expression
        entry_condition = _as_boolean_condition(first_feature.expression)
    else:
        var_name = "lookback"
        var_value = "20"
        feature_rule = "$close > Ref($close,1)"
        entry_condition = "$close > Ref($close,1)"

    add_node("var", "variable", {"name": var_name, "value": var_value})

    drawing_type = "level"
    if "range" in template.id or "vol" in template.id or "risk" in template.id:
        drawing_type = "zone"
    elif "trend" in template.id or "momentum" in template.id:
        drawing_type = "trend"
    add_node("draw", "chart_drawing", {"type": drawing_type, "price": 0})

    # Schedule node.
    if "index" in template.id:
        schedule_type = "run_at_time"
        schedule_config = {"time": "09:31", "timezone": "America/New_York"}
    else:
        schedule_type = "run_per_candle"
        schedule_config = {"timeframe": "1d"}
    sched_id = add_node("sched", schedule_type, schedule_config)

    # Market filter branch.
    if "crypto" in template.id or "btc" in template.id:
        market_condition = "close > EMA($close,20)"
    elif "short" in template.id:
        market_condition = "close > EMA($close,10)"
    else:
        market_condition = "close > EMA($close,50)"
    mkt_id = add_node("mkt", "branch", {"condition": market_condition})

    # Rule chain.
    prev_id = add_node("prev", "previous_day_bullish", {"lookback": 1})
    rule_id = add_node("rule", "trade_rule", {"condition": feature_rule})

    spread_id = add_node("spread", "check_spread", {"max_spread_bps": 10})

    news_source = "general"
    if "crypto" in template.id or "macro" in template.id or "fx" in template.id:
        news_source = "macro"
    elif "quality" in template.id or "earnings" in template.id:
        news_source = "earnings"
    news_id = add_node("news", "news_filter", {"source": news_source, "sentiment": "positive"})

    entry_id = add_node("entry", "branch", {"condition": entry_condition})

    # Execution and back-end pipeline.
    buy_id = add_node("buy", "buy_now", {"side": "long", "size": "100%"})
    port_id = add_node("port", "portfolio", {
        "strategy": "TopkDropoutStrategy",
        "topk": topk,
        "n_drop": n_drop,
    })
    costs_id = add_node("costs", "costs", {
        "open_cost": 0.0005,
        "close_cost": 0.0015,
        "min_cost": 5,
        "account": 100_000_000,
    })
    rec_id = add_node("rec", "records", {})

    no_mkt_id = add_node("no-mkt", "no_trade_for_day", {"reason": "market filter failed"})
    no_entry_id = add_node("no-entry", "no_trade_for_day", {"reason": "entry condition failed"})

    # Optional second feature rule to push node count toward the 12-16 target.
    if len(features) >= 2:
        rule2_id = add_node("rule2", "trade_rule", {"condition": features[1].expression})
    else:
        rule2_id = None

    # Edges: schedule -> market filter.
    add_edge(sched_id, "trigger", mkt_id, "trigger")

    # Market filter true/false branches.
    add_edge(mkt_id, "true", prev_id, "trigger")
    add_edge(mkt_id, "false", no_mkt_id, "trigger")

    # Main rule chain.
    add_edge(prev_id, "trigger", rule_id, "trigger")
    if rule2_id is not None:
        add_edge(rule_id, "trigger", rule2_id, "trigger")
        add_edge(rule2_id, "trigger", spread_id, "trigger")
    else:
        add_edge(rule_id, "trigger", spread_id, "trigger")

    add_edge(spread_id, "trigger", entry_id, "trigger")
    add_edge(news_id, "trigger", entry_id, "trigger")
    add_edge(node_id("draw"), "trigger", entry_id, "trigger")

    # Entry true/false branches.
    add_edge(entry_id, "true", buy_id, "trigger")
    add_edge(entry_id, "false", no_entry_id, "trigger")

    # Portfolio -> costs -> records.
    add_edge(buy_id, "signal", port_id, "signal")
    add_edge(port_id, "trades", costs_id, "trades")
    add_edge(costs_id, "trades", rec_id, "trades")

    positions = _layout(nodes, edges)
    for node in nodes:
        node.position = positions[node.id]

    return KeycardSpec(
        name=template.title,
        description=_description(template),
        tags=list(template.tags),
        is_template=True,
        template_family=template.family,
        nodes=nodes,
        edges=edges,
        windows=Windows(),
    )


def _legacy_keycard(template) -> KeycardSpec:
    """Fallback: convert the template through the flat StrategySpec path."""
    lowered = lower_draft(template.draft)
    keycard = strategy_to_keycard(lowered.spec)
    spec = KeycardSpec(
        **keycard.model_dump(exclude={"id", "created_at", "updated_at", "user_id", "visibility"})
    )
    spec.name = template.title
    spec.description = _description(template)
    spec.tags = list(template.tags)
    spec.is_template = True
    spec.template_family = template.family
    return spec


def template_to_keycard(template) -> KeycardSpec:
    """Template -> a keycard spec ready for storage."""
    if template.family in _RICH_FAMILIES:
        return _rich_aion_keycard(template)
    return _legacy_keycard(template)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m webapp.scripts.migrate_templates_to_keycards",
        description=__doc__,
    )
    parser.add_argument(
        "--user-id", required=True,
        help="UUID of the owner every migrated template is filed under.")
    parser.add_argument(
        "--apply", action="store_true",
        help="Actually write. Without it, nothing is changed.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    principal = resolve_principal(args.user_id)
    repo = KeycardRepo(principal)

    templates = load_templates()
    specs: dict[str, KeycardSpec] = {}
    errors: list[str] = []
    for template in templates:
        try:
            specs[f"template-{template.id}"] = template_to_keycard(template)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{template.id}: {type(exc).__name__}: {exc}")

    print(f"Owner: user_id={principal.user_id}  org_id={principal.org_id}")
    print(f"Mode : {'APPLY (writing)' if args.apply else 'DRY RUN (no writes)'}")
    print(f"Templates parsed: {len(specs)} / {len(templates)}")

    if errors:
        print(f"\nSkipped {len(errors)} template(s):")
        for line in errors:
            print(f"  - {line}")

    created = updated = 0
    if args.apply:
        for record_id, spec in specs.items():
            existing = repo.get(record_id)
            repo.upsert(record_id, spec)
            if existing is None:
                created += 1
            else:
                updated += 1
    else:
        # In dry-run we still validate ids and report the set that would be written.
        for record_id in specs:
            try:
                repo._check_id(record_id)
            except ValueError as exc:
                errors.append(f"{record_id}: invalid id: {exc}")

    print(f"Would write: {len(specs)} keycard(s)")
    if args.apply:
        print(f"  created: {created}")
        print(f"  updated: {updated}")
    else:
        print("Nothing was written. Re-run with --apply.")

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
