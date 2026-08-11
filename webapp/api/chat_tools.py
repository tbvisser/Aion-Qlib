"""Tools the chat assistant can call.

Each tool is a thin wrapper over the same functions the HTTP endpoints use, so
the assistant and the UI can never disagree about what the engine did. Tools
return plain dicts; the model sees them as JSON.

Nothing here can delete data or spend money beyond an EODHD/OpenRouter call the
user already initiated -- the destructive operations (deleting a strategy,
refreshing the whole store) are deliberately not exposed.

**Profiles.** Two surfaces share this machinery: the general Chat page, and the
assistant docked in the Strategy Builder. They get different prompts and
different tool sets, and the difference is load-bearing rather than cosmetic --
the builder assistant proposes strategies and *cannot run one*, because
`run_backtest` is simply absent from its registry. `chat.py` can only dispatch
what `build_registry` returned, so that guarantee is structural and does not
depend on the prompt being obeyed.
"""
from __future__ import annotations

from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict

from .config import get_settings
from .factorlab.operators import expression_language_block
from .strategies import MODEL_SPECS, StrategySpec, StrategyStore, build_workflow_config
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


def render_context(context: BuilderContext | None) -> str | None:
    """The context as a system message, or None when there is nothing to say."""
    if context is None or (context.spec is None and not context.expression):
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
    return "\n".join(lines)


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


#: Tools whose parameters must be generated rather than written down.
_SCHEMA_BUILDERS: dict[str, Callable[[], dict]] = {
    "propose_strategy": _propose_strategy_schema,
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


def build_registry(
    run_manager, profile: str = "general", context: BuilderContext | None = None,
) -> dict[str, Callable[..., dict]]:
    """Bind the tools to the live RunManager so chat-started runs are real runs.

    Returns only the profile's own tools. That is the enforcement point for
    "the builder assistant cannot run a backtest": the handler is not there to
    dispatch to, whatever the model asks for.
    """
    settings = get_settings()
    store = StrategyStore(settings.strategies_dir)

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

    def run_backtest(**kwargs) -> dict:
        provider_uri, region = _require_store()
        spec = StrategySpec(**{k: v for k, v in kwargs.items() if v is not None})
        problems = spec.validate_windows() + spec.validate_features()
        if problems:
            return {"error": " ".join(problems)}
        config = build_workflow_config(spec, provider_uri, region)
        stored = store.create(spec)
        run = run_manager.start(
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
        run = run_manager.get(run_id)
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
                for r in run_manager.list(limit=limit)
            ]
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

    handlers: dict[str, Callable[..., dict]] = {
        "get_data_status": get_data_status,
        "search_instruments": search_instruments,
        "get_price_summary": get_price_summary,
        "evaluate_factor": evaluate_factor,
        "run_backtest": run_backtest,
        "get_run_status": get_run_status,
        "list_runs": list_runs,
        "propose_strategy": propose_strategy,
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


#: The general assistant gets everything; the builder gets what it needs to
#: propose and nothing that acts. `run_backtest` is absent by design.
PROFILES: dict[str, Profile] = {
    "general": Profile(
        system_prompt=SYSTEM_PROMPT,
        tools=("get_data_status", "search_instruments", "get_price_summary",
               "evaluate_factor", "run_backtest", "get_run_status", "list_runs"),
    ),
    "builder": Profile(
        system_prompt=BUILDER_PROMPT,
        tools=("propose_strategy", "list_templates", "evaluate_factor", "get_data_status"),
    ),
}
