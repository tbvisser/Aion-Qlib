"""Data-source nodes: store and universe selection."""
from __future__ import annotations

from typing import Any

from ..models import Defect, Keycard, NodeOutput, NodeTypeMeta, Port, Windows
from ..registry import NodeType, register


class DataStoreNode(NodeType):
    """Picks the qlib store the workflow runs against."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="data_store",
            category="data",
            label="Data Store",
            icon="database",
            description="The qlib store and trading calendar the backtest uses.",
            ports=[
                Port(id="data", label="Data", type="data", direction="out",
                     required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "store": {
                        "type": "string",
                        "enum": ["us", "crypto_365"],
                        "description": "Which qlib store to run against.",
                    },
                },
                "required": ["store"],
            },
        )

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        return NodeOutput(outputs={"data": config.get("store", "us")})

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        store = config.get("store")
        if store not in ("us", "crypto_365"):
            return [Defect("invalid_store",
                           f"Store must be 'us' or 'crypto_365', got {store!r}.",
                           "nodes[?].config.store", "blocking")]
        return []


class UniverseNode(NodeType):
    """Selects the instrument universe and benchmark."""

    def meta(self) -> NodeTypeMeta:
        return NodeTypeMeta(
            id="universe",
            category="data",
            label="Universe",
            icon="globe",
            description="The instruments to trade and the benchmark to compare against.",
            ports=[
                Port(id="data", label="Data", type="data", direction="in",
                     required=True),
                Port(id="data", label="Data", type="data", direction="out",
                     required=True),
            ],
            config_schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "universe": {
                        "type": "string",
                        "description": "Instrument set, e.g. 'top500'.",
                    },
                    "benchmark": {
                        "type": "string",
                        "description": "Benchmark symbol, e.g. 'SPY'.",
                    },
                },
                "required": ["universe", "benchmark"],
            },
        )

    def _upstream_store(self, config: dict, keycard: Keycard) -> str | None:
        """Find the store supplied by the connected data_store node."""
        my_id = next((n.id for n in keycard.nodes if n.type == "universe" and
                      n.config.get("universe") == config.get("universe") and
                      n.config.get("benchmark") == config.get("benchmark")), None)
        if my_id is None:
            return None
        edge = next((e for e in keycard.edges if e.target == my_id and
                     e.target_port == "data"), None)
        if edge is None:
            return None
        source = next((n for n in keycard.nodes if n.id == edge.source), None)
        if source is None or source.type != "data_store":
            return None
        return source.config.get("store")

    def compile(self, config: dict, incoming: dict[str, Any], windows: Windows) -> NodeOutput:
        store = incoming.get("data", "us")
        universe = config.get("universe", "top500")
        benchmark = config.get("benchmark", "SPY")
        return NodeOutput(
            outputs={
                "data": {
                    "store": store,
                    "universe": universe,
                    "benchmark": benchmark,
                },
            },
            fragment={
                "_universe": {
                    "store": store,
                    "universe": universe,
                    "benchmark": benchmark,
                },
            },
        )

    def validate(self, config: dict, keycard: Keycard) -> list[Defect]:
        defects: list[Defect] = []
        universe = config.get("universe")
        benchmark = config.get("benchmark")
        if not universe:
            defects.append(Defect("missing_universe", "Universe is required.",
                                  "nodes[?].config.universe"))
        if not benchmark:
            defects.append(Defect("missing_benchmark", "Benchmark is required.",
                                  "nodes[?].config.benchmark"))

        store_key = self._upstream_store(config, keycard)
        if store_key is None:
            return defects

        from ...marketdata import store_for, store_symbols

        store = store_for(store_key)
        if store is None or not store.get("exists"):
            return defects

        if universe and universe not in (store.get("universes") or []):
            defects.append(Defect(
                "unknown_universe",
                f"The {store_key!r} store has no universe {universe!r}. "
                f"Available: {', '.join(store.get('universes', []))}.",
                "nodes[?].config.universe", "blocking"))

        if benchmark and benchmark not in set(store_symbols(store_key, "all")):
            defects.append(Defect(
                "unknown_benchmark",
                f"{benchmark!r} is not in the {store_key!r} store.",
                "nodes[?].config.benchmark", "blocking"))

        return defects


register(DataStoreNode())
register(UniverseNode())
