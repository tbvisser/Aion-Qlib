"""Tools the chat assistant can call.

Each tool is a thin wrapper over the same functions the HTTP endpoints use, so
the assistant and the UI can never disagree about what the engine did. Tools
return plain dicts; the model sees them as JSON.

Nothing here can delete data or spend money beyond an EODHD/OpenRouter call the
user already initiated -- the destructive operations (deleting a strategy,
refreshing the whole store) are deliberately not exposed.

**Profiles.** Three surfaces share this machinery: the general Chat page, the
assistant docked in the Strategy Builder, and the Keycard Builder dock. They
get different prompts and different tool sets, and the difference is
load-bearing rather than cosmetic -- the builder assistants propose and
*cannot run*, because `run_backtest` is simply absent from their registries.
`chat.py` can only dispatch what `build_registry` returned, so that guarantee
is structural and does not depend on the prompt being obeyed.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict

from .config import get_settings
from .factorlab.operators import expression_language_block
from .keycards.models import KeycardSpec
from .strategies import MODEL_SPECS, StrategySpec, build_workflow_config
from .strategy_gen import templates as strategy_templates
from .strategy_gen.draft import (
    AssumedParam, DraftError, StrategyDraft, draft_json_schema, lower_draft,
)

_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_data_status",
            "description": "What market data is loaded: region, date range, instrument count, universes.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_instruments",
            "description": (
                "Find assets by ticker or company name across equities, ETFs, crypto, "
                "FX and indices. Only equities and ETFs can be used in factors or backtests."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "search": {"type": "string", "description": "Ticker or name, e.g. 'apple' or 'NV'"},
                    "asset_class": {
                        "type": "string",
                        "enum": ["equity", "etf", "crypto", "fx", "index"],
                        "description": "Optional filter to one asset class.",
                    },
                    "limit": {"type": "integer", "default": 20},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_price_summary",
            "description": "Recent price history and simple statistics for one symbol.",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string"},
                    "start": {"type": "string", "description": "YYYY-MM-DD"},
                    "end": {"type": "string", "description": "YYYY-MM-DD"},
                },
                "required": ["symbol"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "evaluate_factor",
            "description": (
                "Measure how well a qlib expression predicts forward returns "
                "(cross-sectional IC and rank IC). Use this to test an alpha idea "
                "before committing it to a strategy."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {"type": "string", "description": "e.g. Ref($close,20)/$close - 1"},
                    "horizon": {"type": "integer", "default": 5},
                    "start": {"type": "string"},
                },
                "required": ["expression"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_markov_signal",
            "description": (
                "Estimate a Markov Chain regime model for a single symbol and return "
                "the current state, transition probabilities, forecast regime "
                "probabilities, and a trading signal (long/short/flat)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "e.g. 'SPY'"},
                    "window": {"type": "integer", "default": 20, "description": "Rolling window for state labels"},
                    "bull": {"type": "number", "default": 0.02, "description": "Bull threshold as a fraction"},
                    "bear": {"type": "number", "default": -0.02, "description": "Bear threshold as a fraction"},
                    "lookback": {"type": "integer", "default": 252, "description": "Days used to estimate the transition matrix"},
                    "steps": {"type": "string", "default": "1,5,12,24", "description": "Comma-separated forecast steps"},
                },
                "required": ["symbol"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_backtest",
            "description": (
                "Train a model and backtest it. Returns a run id immediately; the run "
                "takes minutes. Call get_run_status to check on it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "model": {"type": "string", "enum": list(MODEL_SPECS)},
                    "handler": {"type": "string", "enum": ["Alpha158", "Alpha360"]},
                    "universe": {"type": "string", "default": "top500"},
                    "benchmark": {"type": "string", "default": "SPY"},
                    "topk": {"type": "integer", "default": 50},
                    "n_drop": {"type": "integer", "default": 5},
                    "train_start": {"type": "string"},
                    "train_end": {"type": "string"},
                    "valid_start": {"type": "string"},
                    "valid_end": {"type": "string"},
                    "test_start": {"type": "string"},
                    "test_end": {"type": "string"},
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_run_status",
            "description": "Status, phase and (when finished) the results of a run.",
            "parameters": {
                "type": "object",
                "properties": {"run_id": {"type": "string"}},
                "required": ["run_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_runs",
            "description": "Recent runs with their status and headline metrics.",
            "parameters": {
                "type": "object",
                "properties": {"limit": {"type": "integer", "default": 10}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "start_scalability_analysis",
            "description": (
                "Queue a venue-scalability analysis on the user's uploaded trading "
                "data: how large the fund can grow on its current venue before costs "
                "consume the edge, and what a better-matched venue would allow. Runs "
                "in the background and takes minutes; check later with "
                "get_scalability_report. Leave upload_id null to use the most recent "
                "parsed upload."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "upload_id": {
                        "type": ["string", "null"],
                        "description": "Which upload to analyze; null = the latest parsed one.",
                    },
                    "candidate_venues": {
                        "type": ["array", "null"],
                        "items": {"type": "string"},
                        "description": "Venues to compare against; null = every venue in the catalog.",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_scalability_report",
            "description": (
                "The user's venue-scalability report: the ceiling on their current "
                "venue, what caps it (fees vs. liquidity vs. conditions), and the "
                "best alternative venue with reasons. If the analysis is still "
                "running, returns the job status instead."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "report_id": {
                        "type": ["string", "null"],
                        "description": "Which report; null = the latest one.",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "book_venue_consultation",
            "description": (
                "Book a consultation with a venue and return its booking link. "
                "IMPORTANT: booking is also the user's consent to share the "
                "scalability report with that venue -- only call this when the user "
                "has explicitly asked to book, and say that the report will be shared."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "report_id": {"type": "string"},
                    "venue": {"type": "string", "description": "e.g. 'UBS'"},
                },
                "required": ["report_id", "venue"],
            },
        },
    },
]


class BuilderContext(BaseModel):
    """What the Strategy Builder currently has on screen.

    Typed rather than prose, because the same object is used twice: it is
    rendered into a system message the model reads, and it is the merge base when
    the model asks to change "this" strategy. Prose cannot be merged, and two
    separate representations of the same thing would eventually disagree.

    Rebuilt from the request every turn and never appended to the transcript, so
    it is structurally impossible to show the model a stale spec.
    """

    model_config = ConfigDict(extra="forbid")

    spec: StrategySpec | None = None
    strategy_id: str | None = None
    saved: bool = False
    mode: Literal["form", "canvas"] = "form"
    #: The column being edited, when the canvas is open.
    expression: str | None = None
    #: Every column on the canvas, finished or not -- so the model can talk
    #: about a set it cannot see one expression at a time.
    features: list[dict] | None = None
    feature_mode: str | None = None
    #: Rows from a previous proposal, so "why 50 positions?" is answerable.
    assumed: list[AssumedParam] | None = None
    #: User's plain-language objective for the AI.
    context: str = ""


class KeycardContext(BaseModel):
    """What the Keycard Builder currently has on screen.

    Carries the current KeycardSpec and whether it has been saved, so the
    assistant can change "this" keycard or start from defaults.
    """

    model_config = ConfigDict(extra="forbid")

    spec: KeycardSpec | None = None
    keycard_id: str | None = None
    saved: bool = False


def _builder_objective(context: BuilderContext) -> str:
    return context.context or (context.spec.context if context.spec else "")


def _keycard_objective(spec: KeycardSpec | None) -> str:
    if spec is None:
        return ""
    texts = [
        str(n.config.get("text", "")).strip()
        for n in spec.nodes
        if n.type == "context"
    ]
    return "\n".join(t for t in texts if t)


def _render_builder_context(context: BuilderContext) -> str | None:
    """Render the Strategy Builder context."""
    if context.spec is None and not context.expression:
        return None

    lines = ["The user currently has this in the Strategy Builder."]
    if context.spec is not None:
        fields = ", ".join(f"{k}={v!r}" for k, v in context.spec.model_dump().items())
        lines.append(f"Current strategy: {fields}")
        lines.append("Saved." if context.saved else "Not saved yet.")
    if context.expression:
        lines.append(
            f"They are on the canvas, editing the factor expression: {context.expression}. "
            "You can measure it with evaluate_factor, and you can put it into the "
            "strategy as a named column via propose_strategy's `features`.")
    if context.features:
        rows = "; ".join(
            f"{f.get('name')}={f.get('expression')}"
            + ("" if f.get("complete", True) else " (unfinished)")
            for f in context.features)
        mode = context.feature_mode or "extend"
        lines.append(
            f"The whole feature set on the canvas ({mode}): {rows}. "
            "Unfinished columns are not in the config.")
    if context.assumed:
        rows = "; ".join(f"{a.path}={a.value!r} ({a.why})" for a in context.assumed)
        lines.append(f"Filled in by an earlier proposal rather than chosen: {rows}")
    objective = _builder_objective(context)
    if objective:
        lines.append(f"The user's stated objective: {objective}")
    return "\n".join(lines)


def _render_keycard_context(context: KeycardContext) -> str | None:
    """Render the Keycard Builder context."""
    if context.spec is None:
        return None

    spec = context.spec
    lines = ["The user currently has this in the Keycard Builder."]
    lines.append(f"Keycard name: {spec.name!r}")
    lines.append(f"Blocks: {len(spec.nodes)} nodes, {len(spec.edges)} edges")
    if spec.description:
        lines.append(f"Description: {spec.description}")
    if spec.tags:
        lines.append(f"Tags: {', '.join(spec.tags)}")
    node_summary = "; ".join(
        f"{n.type}({n.id})" for n in spec.nodes[:10])
    if len(spec.nodes) > 10:
        node_summary += f"; and {len(spec.nodes) - 10} more"
    lines.append(f"Node types: {node_summary}")
    objective = _keycard_objective(spec)
    if objective:
        lines.append(f"The user's stated objective: {objective}")
    lines.append("Saved." if context.saved else "Not saved yet.")
    return "\n".join(lines)


def render_context(context: BuilderContext | KeycardContext | None) -> str | None:
    """The context as a system message, or None when there is nothing to say."""
    if context is None:
        return None
    if isinstance(context, KeycardContext):
        return _render_keycard_context(context)
    return _render_builder_context(context)


def _propose_strategy_schema() -> dict:
    """The draft schema, plus where to start from.

    Built at call time for the same reason `draft_json_schema` is: a store
    gaining a universe must be visible without restarting the process. A schema
    frozen at import would reintroduce exactly the drift the draft exists to
    remove.
    """
    base = draft_json_schema()
    properties = dict(base["properties"])
    properties["start_from"] = {
        "type": ["string", "null"],
        "enum": ["current", "defaults", "template", None],
        "description": (
            "What to build on. 'current' keeps every field of the strategy the "
            "user has on screen and applies only what you state — use this for "
            "any change to an existing strategy. 'defaults' starts fresh. "
            "'template' starts from template_id. Null means 'current' when there "
            "is a strategy on screen, otherwise 'defaults'."),
    }
    properties["template_id"] = {
        "type": ["string", "null"],
        "description": "The template to start from. Only with start_from='template'.",
    }
    return {**base, "properties": properties, "required": list(properties)}


def _propose_keycard_schema() -> dict:
    """The KeycardSpec schema, plus where to start from."""
    base = KeycardSpec.model_json_schema()
    properties = dict(base.get("properties", {}))
    properties["start_from"] = {
        "type": ["string", "null"],
        "enum": ["current", "defaults", "template", None],
        "description": (
            "What to build on. 'current' keeps every field of the keycard the "
            "user has on screen and applies only what you state — use this for "
            "any change to an existing keycard. 'defaults' starts fresh. "
            "'template' starts from template_id. Null means 'current' when there "
            "is a keycard on screen, otherwise 'defaults'."),
    }
    properties["template_id"] = {
        "type": ["string", "null"],
        "description": "The template to start from. Only with start_from='template'.",
    }
    return {**base, "properties": properties, "required": list(properties)}


#: Tools whose parameters must be generated rather than written down.
_SCHEMA_BUILDERS: dict[str, Callable[[], dict]] = {
    "propose_strategy": _propose_strategy_schema,
    "propose_keycard": _propose_keycard_schema,
}

_GENERATED_SCHEMAS: dict[str, dict] = {
    "propose_strategy": {
        "type": "function",
        "function": {
            "name": "propose_strategy",
            "description": (
                "Propose a complete strategy for the user to review. Does NOT run "
                "or save anything — the user applies it from the panel. Leave any "
                "field null when the user did not state it; the server fills it "
                "from the default and records that it did."),
            "parameters": {},  # replaced by the builder at request time
        },
    },
    "propose_keycard": {
        "type": "function",
        "function": {
            "name": "propose_keycard",
            "description": (
                "Propose a complete keycard workflow for the user to review. Does NOT "
                "run or save anything — the user applies it from the panel. Leave any "
                "field null when the user did not state it; the server fills it from "
                "the default and records that it did."),
            "parameters": {},  # replaced by the builder at request time
        },
    },
    "list_templates": {
        "type": "function",
        "function": {
            "name": "list_templates",
            "description": (
                "The curated strategies a proposal can start from, with what each "
                "is good and bad at. Call this before proposing something generic."),
            "parameters": {"type": "object", "properties": {}},
        },
    },
}


class Profile(BaseModel):
    system_prompt: str
    tools: tuple[str, ...]


def tool_schemas(profile: str = "general") -> list[dict[str, Any]]:
    """The schemas for one profile, with generated parameters filled in."""
    wanted = PROFILES[profile].tools
    by_name = {s["function"]["name"]: s for s in _TOOL_SCHEMAS}
    by_name.update(_GENERATED_SCHEMAS)

    out: list[dict[str, Any]] = []
    for name in wanted:
        schema = by_name[name]
        builder = _SCHEMA_BUILDERS.get(name)
        if builder:
            schema = {**schema, "function": {**schema["function"], "parameters": builder()}}
        out.append(schema)
    return out


def system_prompt(profile: str = "general") -> str:
    return PROFILES[profile].system_prompt


def _default_keycard_spec() -> dict:
    """A runnable Aion-style opening-range breakout keycard.

    Mirrors the default shipped in webapp/ui/src/lib/keycardGraph/keycardTemplates.ts
    so the assistant and the palette start from the same shape.
    """
    left = 200
    top = 100
    spacing = 180

    nodes = [
        {"id": "store-1", "type": "data_store",
         "position": {"x": left, "y": top}, "config": {"store": "us"}, "notes": ""},
        {"id": "universe-1", "type": "universe",
         "position": {"x": left, "y": top + spacing},
         "config": {"universe": "top500", "benchmark": "SPY"}, "notes": ""},
        {"id": "schedule-1", "type": "run_per_candle",
         "position": {"x": left + spacing * 2, "y": top},
         "config": {"timeframe": "1d"}, "notes": ""},
        {"id": "rule-1", "type": "previous_day_bullish",
         "position": {"x": left + spacing * 2, "y": top + spacing},
         "config": {"lookback": 1}, "notes": ""},
        {"id": "rule-2", "type": "candle_close_above_opening_range",
         "position": {"x": left + spacing * 2, "y": top + spacing * 2},
         "config": {"minutes": 30}, "notes": ""},
        {"id": "exec-1", "type": "buy_now",
         "position": {"x": left + spacing * 2, "y": top + spacing * 3},
         "config": {"side": "long", "size": "100%"}, "notes": ""},
        {"id": "portfolio-1", "type": "portfolio",
         "position": {"x": left + spacing * 3, "y": top + spacing * 2},
         "config": {"strategy": "TopkDropoutStrategy", "topk": 50, "n_drop": 5},
         "notes": ""},
        {"id": "costs-1", "type": "costs",
         "position": {"x": left + spacing * 3, "y": top + spacing * 3},
         "config": {"open_cost": 0.0005, "close_cost": 0.0015, "min_cost": 5,
                    "account": 100_000_000}, "notes": ""},
        {"id": "records-1", "type": "records",
         "position": {"x": left + spacing * 3, "y": top + spacing * 4},
         "config": {}, "notes": ""},
    ]

    edges = [
        {"id": "e1", "source": "store-1", "source_port": "data",
         "target": "universe-1", "target_port": "data"},
        {"id": "e2", "source": "schedule-1", "source_port": "trigger",
         "target": "rule-1", "target_port": "trigger"},
        {"id": "e3", "source": "rule-1", "source_port": "trigger",
         "target": "rule-2", "target_port": "trigger"},
        {"id": "e4", "source": "rule-2", "source_port": "trigger",
         "target": "exec-1", "target_port": "trigger"},
        {"id": "e5", "source": "exec-1", "source_port": "signal",
         "target": "portfolio-1", "target_port": "signal"},
        {"id": "e6", "source": "portfolio-1", "source_port": "trades",
         "target": "costs-1", "target_port": "trades"},
        {"id": "e7", "source": "costs-1", "source_port": "trades",
         "target": "records-1", "target_port": "trades"},
    ]

    from .keycards.models import Windows

    windows = Windows()
    return {
        "name": "Opening range breakout",
        "description": "Aion-style opening-range breakout keycard.",
        "tags": ["aion", "breakout"],
        "is_template": False,
        "template_family": "aion",
        "nodes": nodes,
        "edges": edges,
        "windows": windows.model_dump(),
    }


def _compact_scalability_report(report: dict) -> dict:
    """The slice of a scalability report the model needs to narrate it.

    The report row is the durable contract; the ``result`` blob is written by
    the scalability agent and versioned with its engine. Keys are therefore
    read defensively: a missing one degrades to None in a chat turn rather
    than raising, and the model narrates only what is there.
    """
    result = report.get("result") or {}
    # The engine nests the ceiling math under "comparison"
    # (scalability_agent.engine.compare.compare_venues).
    comparison = result.get("comparison") or {}
    alternatives = comparison.get("alternatives") or []
    best = comparison.get("best_alternative") or next(
        (a for a in alternatives if a.get("eligible", True)), None
    )
    current = comparison.get("current") or {}
    return {
        "report_id": str(report["id"]),
        "created_at": str(report["created_at"]),
        "job_status": report.get("job_status"),
        "current_venue": report.get("current_venue"),
        "catalog_version": report.get("catalog_version"),
        # Ceiling and the fees/impact/conditions decomposition for the venue
        # the fund trades on today.
        "current": current or None,
        # The highest-ranked eligible alternative: venue, ceiling, and the
        # plain-language reasons for it.
        "best_alternative": best,
        # Ineligible and near-miss ("you almost qualify") venues, kept
        # explicit because surfacing them is a feature, not an error.
        "eligibility_notes": [
            {k: a.get(k) for k in ("venue", "eligible", "near_miss", "reasons")}
            for a in alternatives if not a.get("eligible", True) or a.get("near_miss")
        ],
        "confidence": current.get("confidence_band_usd"),
    }


def build_registry(
    run_manager, principal, profile: str = "general",
    context: BuilderContext | KeycardContext | None = None,
) -> dict[str, Callable[..., dict]]:
    """Bind the tools to the live RunManager so chat-started runs are real runs.

    Returns only the profile's own tools. That is the enforcement point for
    "the builder assistant cannot run a backtest": the handler is not there to
    dispatch to, whatever the model asks for.

    ``principal`` is who the assistant is acting for. Every strategy it saves
    and every run it starts is owned by that person -- an agent is a way of
    doing your own work, not a shared account, and without this a strategy the
    assistant created would belong to nobody and be visible to no one.
    """
    settings = get_settings()
    from .repositories import StrategyRepo

    store = StrategyRepo(principal)

    from . import qlib_session, results

    def _require_store() -> tuple[str, str]:
        state = qlib_session.init_qlib()
        if not state["ready"]:
            raise RuntimeError(state["error"] or "qlib is not initialised")
        return state["provider_uri"], state["region"]

    def get_data_status() -> dict:
        from .routers.health import health as health_endpoint

        return health_endpoint()

    def search_instruments(search: str = "", asset_class: str = "", limit: int = 20) -> dict:
        """Search every asset the app holds, by ticker or company name.

        Reads the catalog rather than the qlib store: the store holds tickers
        only and none of the crypto/FX/index assets, so a qlib-backed search
        could neither match "apple" nor find bitcoin.
        """
        from . import marketdata

        catalog = marketdata.load_catalog()
        if catalog["count"]:
            return marketdata.search(query=search, asset_class=asset_class, limit=limit)

        # No catalog yet (store predates the multi-asset ingest) — fall back.
        _require_store()
        from qlib.data import D

        universe = "top500"
        try:
            symbols = D.list_instruments(D.instruments(universe), as_list=True)
        except Exception:
            universe = "all"
            symbols = D.list_instruments(D.instruments(universe), as_list=True)
        names = sorted(str(s) for s in symbols)
        if search:
            names = [n for n in names if search.lower() in n.lower()]
        return {"universe": universe, "total": len(names), "instruments": names[:limit]}

    def get_price_summary(symbol: str, start: str | None = None, end: str | None = None) -> dict:
        _require_store()
        from .routers.data import bars as bars_endpoint

        # Two views of the same bars. Raw prices are what a human recognises
        # ("NVDA was $1150"), but a return computed from them is wrong across a
        # split -- NVDA's 10:1 in June 2024 reads as -88%. Returns therefore come
        # from the adjusted series, and both are labelled so the distinction
        # survives into the model's answer.
        raw = bars_endpoint(symbol=symbol, start=start, end=end, adjusted=False)["bars"]
        adjusted = bars_endpoint(symbol=symbol, start=start, end=end, adjusted=True)["bars"]
        if not raw:
            return {"symbol": symbol.upper(), "error": "No data for that symbol/range."}

        raw_closes = [r["close"] for r in raw if r["close"] is not None]
        adj_closes = [r["close"] for r in adjusted if r["close"] is not None]
        period_return = (adj_closes[-1] / adj_closes[0] - 1) if len(adj_closes) > 1 else None

        return {
            "symbol": symbol.upper(),
            "bars": len(raw),
            "first_date": raw[0]["time"],
            "last_date": raw[-1]["time"],
            "first_close_raw": raw_closes[0] if raw_closes else None,
            "last_close_raw": raw_closes[-1] if raw_closes else None,
            "high_raw": max(raw_closes) if raw_closes else None,
            "low_raw": min(raw_closes) if raw_closes else None,
            "period_return": period_return,
            "period_return_note": (
                "Computed from split/dividend-adjusted closes. The *_raw prices are "
                "the actual traded prices and may jump across a split."
            ),
        }

    def evaluate_factor(expression: str, horizon: int = 5, start: str | None = None) -> dict:
        _require_store()
        from .routers.factors import EvaluateRequest, evaluate as evaluate_endpoint

        result = evaluate_endpoint(
            EvaluateRequest(expression=expression, horizon=horizon, start=start or "2022-01-01")
        )
        # Trim the monthly series: the model needs the summary, not 60 points.
        return {k: v for k, v in result.items() if k != "series"}

    def get_markov_signal(
        symbol: str,
        window: int = 20,
        bull: float = 0.02,
        bear: float = -0.02,
        lookback: int = 252,
        steps: str = "1,5,12,24",
    ) -> dict:
        from .routers.markov import signal as signal_endpoint

        result = signal_endpoint(
            symbol=symbol,
            window=window,
            bull=bull,
            bear=bear,
            lookback=lookback,
            steps=steps,
        )
        # Keep the payload compact for the model.
        return {
            "symbol": result.get("symbol"),
            "as_of": result.get("as_of"),
            "current_state": result.get("current_state"),
            "signal": result.get("signal"),
            "position": result.get("position"),
            "bull_prob": result.get("bull_prob"),
            "bear_prob": result.get("bear_prob"),
            "sideways_prob": result.get("sideways_prob"),
            "forecasts": result.get("forecasts"),
            "stationary_distribution": result.get("stationary_distribution"),
            "backtest": result.get("backtest"),
        }

    def run_backtest(**kwargs) -> dict:
        provider_uri, region = _require_store()
        spec = StrategySpec(**{k: v for k, v in kwargs.items() if v is not None})
        problems = spec.validate_windows() + spec.validate_features()
        if problems:
            return {"error": " ".join(problems)}
        config = build_workflow_config(spec, provider_uri, region)
        stored = store.create(spec)
        run = run_manager.start(
            principal,
            name=spec.name, config=config, kind="backtest", strategy_id=stored.id,
            extra={"model": spec.model, "handler": spec.handler,
                   "universe": spec.universe, "benchmark": spec.benchmark},
        )
        return {
            "run_id": run.id,
            "strategy_id": stored.id,
            "status": run.meta["status"],
            "note": "Training and backtesting takes several minutes. Poll get_run_status.",
        }

    def get_run_status(run_id: str) -> dict:
        run = run_manager.get(principal, run_id)
        if run is None:
            return {"error": f"No run {run_id}"}
        payload = {k: run.meta.get(k) for k in
                   ("id", "name", "status", "phase", "model", "universe", "error")}
        if run.meta.get("status") == "succeeded":
            report = results.build_report(run.meta.get("experiment_name", ""))
            if report:
                payload["metrics"] = report.get("metrics")
                payload["risk"] = report.get("risk")
                payload["period"] = report.get("period")
        return payload

    def list_runs(limit: int = 10) -> dict:
        return {
            "runs": [
                {k: r.get(k) for k in ("id", "name", "status", "phase", "model", "created_at")}
                for r in run_manager.list(principal, limit=limit)
            ]
        }

    def start_scalability_analysis(
        upload_id: str | None = None,
        candidate_venues: list[str] | None = None,
    ) -> dict:
        """Queue an analysis; the scalability agent does the work, not the API.

        Control plane / data plane: this only writes a job row, exactly as the
        upload and REST paths do. The agent service claims it with
        SELECT ... FOR UPDATE SKIP LOCKED and writes the report back.
        """
        from .db import user_tx

        with user_tx(principal.user_id) as cur:
            if upload_id:
                cur.execute(
                    "SELECT id, status FROM aion.scalability_uploads WHERE id = %s",
                    (upload_id,))
                upload = cur.fetchone()
                if upload is None:
                    return {"error": f"No upload {upload_id} -- upload a trading "
                                     "statement first, or omit upload_id to use the latest."}
            else:
                cur.execute(
                    "SELECT id, status FROM aion.scalability_uploads "
                    "WHERE status = 'parsed' ORDER BY created_at DESC LIMIT 1")
                upload = cur.fetchone()
                if upload is None:
                    return {"error": "No parsed upload yet -- upload a trading "
                                     "statement and wait for it to parse."}
            if upload["status"] != "parsed":
                return {"error": f"Upload {upload['id']} is '{upload['status']}', "
                                 "not parsed yet."}
            params = json.dumps({
                "upload_id": str(upload["id"]),
                "candidate_venues": candidate_venues or [],
            })
            cur.execute(
                "INSERT INTO aion.scalability_jobs (user_id, org_id, kind, params, upload_id) "
                "VALUES (%s, %s, 'analyze', %s, %s) RETURNING id",
                (principal.user_id, principal.org_id, params, upload["id"]))
            job = cur.fetchone()
        return {
            "job_id": str(job["id"]),
            "upload_id": str(upload["id"]),
            "status": "queued",
            "note": "The analysis runs in the background and takes minutes. "
                    "Check later with get_scalability_report.",
        }

    def get_scalability_report(report_id: str | None = None) -> dict:
        """A compact summary of a report, or the job status while it runs."""
        from .db import user_tx

        with user_tx(principal.user_id) as cur:
            if report_id:
                cur.execute(
                    "SELECT r.*, j.status AS job_status FROM aion.scalability_reports r "
                    "LEFT JOIN aion.scalability_jobs j ON j.id = r.job_id "
                    "WHERE r.id = %s",
                    (report_id,))
            else:
                cur.execute(
                    "SELECT r.*, j.status AS job_status FROM aion.scalability_reports r "
                    "LEFT JOIN aion.scalability_jobs j ON j.id = r.job_id "
                    "ORDER BY r.created_at DESC LIMIT 1")
            report = cur.fetchone()
            if report is None:
                # No finished report: say whether the agent is still on it, so
                # the model answers "still running" instead of "no report".
                cur.execute(
                    "SELECT id, status, error FROM aion.scalability_jobs "
                    "WHERE kind = 'analyze' ORDER BY created_at DESC LIMIT 1")
                job = cur.fetchone()
                if job and job["status"] in ("queued", "running"):
                    return {"status": job["status"], "job_id": str(job["id"]),
                            "note": "The analysis is still running; ask again shortly."}
                if job and job["status"] == "failed":
                    return {"status": "failed", "job_id": str(job["id"]),
                            "error": job["error"]}
                return {"error": "No scalability report yet -- start one with "
                                 "start_scalability_analysis."}
        return _compact_scalability_report(report)

    def book_venue_consultation(report_id: str, venue: str) -> dict:
        """Book a consultation; booking IS the consent to share the report.

        CONSENT GATE: `report_shared_at` is the one flag that lets the
        platform forward the report to the venue, and it may be set only on a
        completed booking, never by the agent. The gate has a single
        implementation -- `routers/scalability.py::book_consultation_for`,
        shared with the REST endpoint (PRD M8: enforced in one place).
        """
        from .routers.scalability import BookingError, book_consultation_for

        try:
            out = book_consultation_for(principal, report_id, venue)
        except BookingError as exc:
            return {"error": str(exc)}
        booking = out["booking"]
        return {
            "booking_id": str(booking["id"]),
            "venue": venue,
            "booking_link": out["booking_link"],
            "note": "Booked. The report is now shared with the venue "
                    "(report_shared_at set).",
        }

    def list_templates() -> dict:
        """Runnable templates only.

        A template that cannot be built on this machine is worse than no
        suggestion at all: the model would propose it, the user would apply it,
        and lowering would refuse it for a reason neither of them chose.
        """
        return {
            "templates": [
                {
                    **{k: entry[k] for k in
                       ("id", "title", "family", "tags", "rationale", "good_for", "bad_for")},
                    # What the template already decides; everything else is left
                    # unstated for the same defaulting the model relies on.
                    "sets": {k: v for k, v in template.draft.model_dump().items()
                             if v is not None and k != "assumed"},
                }
                for template, entry in zip(strategy_templates.load_templates(),
                                           strategy_templates.catalog())
                if entry["runnable"]
            ]
        }

    def _merge_base(start_from: str | None, template_id: str | None) -> tuple[dict, str]:
        """The fields a proposal inherits, and where they came from."""
        if start_from is None:
            start_from = "current" if (context and context.spec) else "defaults"

        if start_from == "current":
            if context is None or context.spec is None:
                return {}, "defaults"
            stated = {k: v for k, v in context.spec.model_dump().items() if v is not None}
            return stated, "current"

        if start_from == "template":
            template = strategy_templates.get_template(template_id or "")
            if template is None:
                raise ValueError(
                    f"There is no template {template_id!r}. Call list_templates first.")
            stated = {k: v for k, v in template.draft.model_dump().items()
                      if v is not None and k != "assumed"}
            return stated, f"template:{template.id}"

        return {}, "defaults"

    def propose_strategy(**kwargs) -> dict:
        """Plain language -> a complete strategy, for the user to apply.

        Merging happens *before* lowering, deliberately. A field carried over
        from what is on screen is then a **stated** field, so `to_spec` never
        emits an `AssumedParam` for it — those rows must keep meaning "nobody
        decided this" rather than "you decided this earlier". Carried fields are
        reported separately as `inherited`.
        """
        start_from = kwargs.pop("start_from", None)
        template_id = kwargs.pop("template_id", None)
        stated = {k: v for k, v in kwargs.items() if v is not None}

        try:
            base, source = _merge_base(start_from, template_id)
        except ValueError as exc:
            return {"errors": [{"code": "unknown_template", "message": str(exc),
                                "path": "template_id"}]}

        merged = {**base, **stated}
        try:
            lowered = lower_draft(merged)
        except DraftError as exc:
            # Returned, not raised: chat.py would flatten an exception into one
            # string and destroy the per-field paths the model needs to repair.
            return {"errors": exc.errors}

        return {
            "spec": lowered.spec.model_dump(),
            "assumed": [a.model_dump() for a in lowered.assumed],
            "inherited": [{"path": k, "value": v, "source": source}
                          for k, v in base.items() if k not in stated],
            "warnings": lowered.warnings,
            "source": source,
            # No YAML: ~2kB of tokens the model never reads, and the panel
            # regenerates it from the spec anyway.
        }

    def _keycard_merge_base(start_from: str | None, template_id: str | None) -> tuple[dict, str]:
        """The fields a keycard proposal inherits, and where they came from."""
        if start_from is None:
            has_current = (isinstance(context, KeycardContext) and
                           context is not None and context.spec is not None)
            start_from = "current" if has_current else "defaults"

        if start_from == "current":
            if context is None or not isinstance(context, KeycardContext) or context.spec is None:
                return _default_keycard_spec(), "defaults"
            return context.spec.model_dump(), "current"

        if start_from == "template":
            # For now keycards do not ship backend templates; fall back to defaults
            # with a warning source so the model knows nothing was inherited.
            if template_id:
                return {**_default_keycard_spec(), "template_family": template_id}, "template"
            return _default_keycard_spec(), "defaults"

        return _default_keycard_spec(), "defaults"

    def propose_keycard(**kwargs) -> dict:
        """Plain language -> a complete keycard workflow, for the user to apply."""
        start_from = kwargs.pop("start_from", None)
        template_id = kwargs.pop("template_id", None)
        stated = {k: v for k, v in kwargs.items() if v is not None}

        base, source = _keycard_merge_base(start_from, template_id)
        merged = {**base, **stated}

        try:
            spec = KeycardSpec(**merged)
        except Exception as exc:
            return {"errors": [{"code": "invalid_keycard", "message": str(exc)}]}

        if source == "defaults":
            assumed = [{"path": k, "value": v, "why": "default"}
                       for k, v in base.items() if k not in stated]
            inherited = []
        else:
            assumed = []
            inherited = [{"path": k, "value": v, "source": source}
                         for k, v in base.items() if k not in stated]
        return {
            "spec": spec.model_dump(),
            "assumed": assumed,
            "inherited": inherited,
            "warnings": [],
            "source": source,
        }

    handlers: dict[str, Callable[..., dict]] = {
        "get_data_status": get_data_status,
        "search_instruments": search_instruments,
        "get_price_summary": get_price_summary,
        "evaluate_factor": evaluate_factor,
        "get_markov_signal": get_markov_signal,
        "run_backtest": run_backtest,
        "get_run_status": get_run_status,
        "list_runs": list_runs,
        "start_scalability_analysis": start_scalability_analysis,
        "get_scalability_report": get_scalability_report,
        "book_venue_consultation": book_venue_consultation,
        "propose_strategy": propose_strategy,
        "propose_keycard": propose_keycard,
        "list_templates": list_templates,
    }
    return {name: handlers[name] for name in PROFILES[profile].tools}


# The factor-language briefing, generated from the served operator registry so
# the model is told about all 44 operators rather than the 14 someone typed out.
EXPRESSION_LANGUAGE = expression_language_block()


SYSTEM_PROMPT = f"""You are the assistant inside AION, a quantitative research app.

You have tools that operate the app for real: they query the loaded market data, measure \
factors, and launch actual backtests. Use them rather than guessing or estimating. When a \
user asks for a number you can measure, measure it.

Context you should establish early if it matters: call get_data_status to find out which \
market, date range and universe are loaded, instead of assuming.

{EXPRESSION_LANGUAGE}

Be honest about what the numbers mean. An IC near 0.00 is no signal, however nice the \
expression looks. Backtests on a universe selected by today's liquidity carry survivorship \
bias, and results net of cost matter more than gross. Say so when it is relevant rather than \
presenting a flattering number without its caveat.

Backtests take minutes. Start one, tell the user its run id and that it is running, and let \
them watch it on the Runs page — do not poll in a tight loop.

Keep replies short and concrete. Prefer a small table of numbers over a paragraph about them."""


BUILDER_PROMPT = f"""You are the strategy assistant inside AION's Strategy Builder. You turn a \
plain-language description into a complete, runnable strategy — and you propose it. You do \
not apply it.

You have no tool that saves a strategy or starts a backtest, and this is deliberate: the user \
applies your proposal from the panel, or does not. Never say you have started, saved or run \
anything.

To propose, call propose_strategy. Every field may be left null. Null means "the description \
did not state this", and the server fills it from the default and records a row saying so. \
Leaving a field null is better than guessing it — state a field only when the user's words \
imply it.

If the user has entered an objective in the Context block, treat it as the primary guide \
when proposing changes. A strategy that contradicts its own objective is worse than no \
proposal at all.

The user usually has a strategy on screen. When they ask to change it — "more conservative", \
"fewer names", "try it on ETFs" — call propose_strategy with start_from="current" and state \
only the fields that change; everything else is carried over for you. Use start_from="defaults" \
only when they are starting something genuinely new, and start_from="template" with a \
template_id when a curated starting point fits better. Call list_templates if you are not sure \
one exists.

If propose_strategy comes back with errors, read them: each names the field it is about and \
what is available instead. Fix those fields and call it again rather than explaining the error.

Report what was assumed. The proposal returns an "assumed" list — one row per decision nobody \
made. Name the two or three that actually matter for what the user asked (position count, \
turnover, costs, the backtest window) in one line each. Do not read the list out; the panel \
shows it.

The three windows must not overlap: training, then validation, then the backtest, in that \
order, no shared days. Validation overlapping training scores the model on data it already \
saw; a backtest overlapping validation is optimistic by construction. Call get_data_status \
before choosing dates rather than assuming the store covers them.

A strategy has no entry or exit rule. This engine ranks every instrument each day and holds \
the top k — there is no "buy when RSI crosses 30" here. Say so plainly instead of proposing \
something that pretends otherwise.

What the model sees is the handler's feature set: Alpha158 is 158 engineered factors, \
Alpha360 is 360 raw price/volume lags. You can add columns of your own with `features` — \
each one a name and a qlib expression — and `feature_mode` decides what happens to the \
handler's own: "extend" adds yours alongside them, "replace" trains on yours alone. Prefer \
extend. A single factor almost never beats 158 of them, and the useful question is usually \
whether an idea adds anything to a real baseline.

Two rules the server enforces, so do not fight them. A custom column must not repeat one of \
the handler's own names — the loader would silently drop qlib's column and keep yours. And a \
feature must not read the future: Ref(x,-n) belongs in a label, never in a feature, and a \
backtest built on one measures hindsight rather than skill.

{EXPRESSION_LANGUAGE}

Be honest about what a backtest can and cannot show. It cannot tell you a strategy will make \
money. A universe chosen by today's liquidity carries survivorship bias, so every result on \
top500 is flattered by the names that survived to be in it. Results net of cost are the only \
ones worth quoting, and the cost assumptions are the user's, not the market's. An IC near 0.00 \
is no signal however good the idea sounds. A model trained through 2019 and tested from 2022 \
has seen one regime and is judged on another. Say the relevant one when you propose something; \
do not hand over a clean-looking configuration without it.

Keep replies short. A paragraph on the shape of what you propose, then the assumptions that \
matter. The panel lists the parameters — do not repeat them back."""


KEYCARD_PROMPT = f"""You are the keycard assistant inside AION's Keycard Builder. You turn a \
plain-language description into a complete, runnable keycard workflow — and you propose it. \
You do not apply it.

A keycard is a directed graph of blocks. The Aion-style blocks are:
- Schedule: run_per_candle, run_at_time, run_in_session (these emit triggers)
- Rules: trade_rule, check_spread, previous_day_bullish, candle_close_above_opening_range, \
price_above_previous_day_close, no_trade_for_day, news_filter (these filter triggers)
- Execution: buy_now (turns a true rule chain into a signal for the portfolio)
- Management: trade_counter, reset_trade_counter
- Variables: variable
- Chart Drawings: chart_drawing

A rule workflow ends at buy_now, and buy_now's signal output feeds the existing portfolio node \
(TopkDropoutStrategy). The portfolio node then connects to costs and records so the backtest \
can run. Quant pipeline nodes (data_store, universe, handler, model, portfolio, costs, records) \
remain available and fully runnable.

You have no tool that saves a keycard or starts a backtest, and this is deliberate: the user \
applies your proposal from the panel, or does not. Never say you have started, saved or run \
anything.

To propose, call propose_keycard. Every field may be left null. Null means "the description \
did not state this", and the server fills it from the default and records a row saying so. \
Leaving a field null is better than guessing it — state a field only when the user's words \
imply it.

If the user has entered an objective in the Context block, treat it as the primary guide \
when proposing changes. A keycard that contradicts its own objective is worse than no \
proposal at all.

The user usually has a keycard on screen. When they ask to change it — "add a rule", "trade \
only in the regular session", "make it long only" — call propose_keycard with \
start_from="current" and state only the fields that change; everything else is carried over \
for you. Use start_from="defaults" only when they are starting something genuinely new.

If propose_keycard comes back with errors, read them and call it again rather than explaining \
the error.

Report what was assumed. The proposal returns an "assumed" list — one row per decision nobody \
made. Name the two or three that actually matter in one line each. Do not read the list out; \
the panel shows it.

{EXPRESSION_LANGUAGE}

Keep replies short. A paragraph on the shape of what you propose, then the assumptions that \
matter. The panel lists the blocks — do not repeat them back."""


#: The general assistant gets everything; the builder gets what it needs to
#: propose and nothing that acts. `run_backtest` is absent by design.
PROFILES: dict[str, Profile] = {
    "general": Profile(
        system_prompt=SYSTEM_PROMPT,
        tools=("get_data_status", "search_instruments", "get_price_summary",
               "evaluate_factor", "get_markov_signal", "run_backtest", "get_run_status",
               "list_runs", "start_scalability_analysis", "get_scalability_report",
               "book_venue_consultation"),
    ),
    "builder": Profile(
        system_prompt=BUILDER_PROMPT,
        tools=("propose_strategy", "list_templates", "evaluate_factor", "get_data_status"),
    ),
    "keycard-builder": Profile(
        system_prompt=KEYCARD_PROMPT,
        tools=("propose_keycard", "list_templates", "evaluate_factor", "get_data_status"),
    ),
}
