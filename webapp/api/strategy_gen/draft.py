"""A typed draft of a strategy, and the deterministic lowering of it into a run.

`StrategySpec` bakes its defaults into its fields, which makes it unable to hold
the one distinction generation depends on: whether a value was *chosen* or
merely *inherited*. A spec with ``topk=50`` cannot say whether the user asked for
fifty or whether nobody said anything. `StrategyDraft` is the same vocabulary
with every field nullable, so ``None`` means "the description did not state
this" -- and `lower_draft` fills each one from the spec's own default while
recording an `AssumedParam` saying so. That list is what an honest UI shows under
"What I assumed", and what a scorer penalises.

The second thing it fixes is drift. Anything that re-declares this vocabulary by
hand goes stale: `chat_tools.py`'s ``run_backtest`` schema is already missing six
of `StrategySpec`'s fields and re-types its defaults and its handler enum.
`draft_json_schema` is built at call time from the live registries -- the
importable models, the stores that exist on disk, the universes globbed out of
each store's ``instruments/`` -- so it cannot drift, and it cannot offer the user
something the engine would refuse minutes into a run.

Nothing here calls an LLM or touches the network. The strict JSON Schema is a
*guardrail* for a model that will eventually fill this in; pydantic and the
prepass are the authority, because a schema cannot express "this universe exists
in that store" and should not pretend to.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .. import marketdata
from ..strategies import (
    HANDLERS,
    MODEL_SPECS,
    FeatureColumn,
    StrategySpec,
    available_models,
    build_workflow_config,
    render_yaml,
)

# Keywords OpenAI's strict structured-output mode rejects outright. Listed here
# rather than merely avoided, so the test that walks the emitted schema and this
# module read from one source.
UNSUPPORTED_SCHEMA_KEYWORDS = frozenset({
    "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "minLength", "maxLength", "pattern", "format", "minItems", "maxItems",
    "uniqueItems", "oneOf", "allOf", "not", "if", "then", "else",
    "propertyNames", "patternProperties", "contains", "multipleOf",
})


class AssumedParam(BaseModel):
    """One decision nobody made, recorded so it can be shown and argued with."""

    model_config = ConfigDict(extra="forbid")

    path: str
    value: Any = None
    why: str = ""


class StrategyDraft(BaseModel):
    """`StrategySpec`, but able to say "unstated".

    Field for field the same vocabulary -- deliberately, so the test that
    compares the two field sets fails the moment one grows without the other.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=80)

    model: str | None = None
    handler: str | None = None
    data_store: str | None = None
    universe: str | None = None
    benchmark: str | None = None

    train_start: str | None = None
    train_end: str | None = None
    valid_start: str | None = None
    valid_end: str | None = None
    test_start: str | None = None
    test_end: str | None = None

    topk: int | None = None
    n_drop: int | None = None
    open_cost: float | None = None
    close_cost: float | None = None
    min_cost: float | None = None
    account: float | None = None
    limit_threshold: float | None = None

    #: Reused from `strategies`, not re-declared. A second copy of the same
    #: vocabulary is exactly what this module exists to stop.
    features: list[FeatureColumn] | None = None
    #: A plain string rather than a Literal: a draft's job is to hold what was
    #: said, and `_vocabulary_defects` reports an unknown value as a defect
    #: instead of raising on the first bad one.
    feature_mode: str | None = None

    #: Assumptions the *author* of the draft declares. `lower_draft` appends the
    #: ones the server itself makes; both end up in `LoweredDraft.assumed`.
    assumed: list[AssumedParam] = Field(default_factory=list)


# Why each field gets filled, in the second person, for the "What I assumed"
# rows. Keyed by field name; the value shown beside it is always read from
# `StrategySpec` rather than repeated here.
_WHY = {
    "model": "not stated, so the default learner is used",
    "handler": "not stated, so the default feature set is used",
    "data_store": "not stated, so the 252-day store is used -- the one that can "
                  "hold equities, ETFs, crypto, FX and indices together",
    "universe": "not stated, so the default instrument set is used",
    "benchmark": "not stated, so returns are compared against the default",
    "train_start": "training window not stated",
    "train_end": "training window not stated",
    "valid_start": "validation window not stated",
    "valid_end": "validation window not stated",
    "test_start": "backtest window not stated",
    "test_end": "backtest window not stated",
    "topk": "position count not stated",
    "n_drop": "turnover not stated",
    "open_cost": "trading costs not stated",
    "close_cost": "trading costs not stated",
    "min_cost": "trading costs not stated",
    "account": "starting capital not stated",
    "limit_threshold": "no price limit, which is normal outside China",
    "features": "no custom factors, so the handler's own feature set is used as it is",
    "feature_mode": "not stated, so custom factors are added to the handler's own "
                    "features rather than replacing them",
}


class DraftError(ValueError):
    """A draft that cannot be lowered, with every defect the stage could find.

    ``errors`` is a list of ``{code, message, path?}``. ``path`` is in *draft*
    coordinates, so a caller -- or a model reading its own mistakes back -- sees
    the name it used, not an internal one.
    """

    def __init__(self, errors: list[dict]):
        self.errors = errors
        super().__init__("; ".join(e["message"] for e in errors[:5]))


@dataclass(frozen=True)
class LoweredDraft:
    spec: StrategySpec
    assumed: list[AssumedParam]
    warnings: list[str] = field(default_factory=list)
    config: dict = field(default_factory=dict)
    yaml: str = ""


def _err(code: str, message: str, path: str | None = None) -> dict:
    out = {"code": code, "message": message}
    if path is not None:
        out["path"] = path
    return out


def _loc_to_path(loc: tuple) -> str:
    """A pydantic error location as draft coordinates: ``assumed[0].path``."""
    out = ""
    for part in loc:
        if isinstance(part, int):
            out += f"[{part}]"
        else:
            out += f".{part}" if out else str(part)
    return out


# --------------------------------------------------------------------------
# The schema
# --------------------------------------------------------------------------
def _nullable(kind: str, description: str, enum: list | None = None) -> dict:
    """A property that may be omitted.

    Strict mode requires every property in ``required``, so optionality has to
    live in the *type*. ``null`` is how the draft says "unstated" anyway, which
    makes this the honest encoding rather than a workaround.
    """
    out: dict[str, Any] = {"type": [kind, "null"], "description": description}
    if enum is not None:
        # A null-able enum must admit null, or a strict decoder cannot emit the
        # very value the type says is allowed.
        out["enum"] = [*enum, None]
    return out


def _store_keys() -> list[str]:
    stores = marketdata.data_stores()
    built = [s["key"] for s in stores if s["exists"]]
    # An empty enum is not a legal schema. If nothing is built, offer everything
    # and let the prepass deliver the real news.
    return built or [s["key"] for s in stores]


def draft_json_schema(data_store: str | None = None) -> dict:
    """The draft's JSON Schema, built now, from what this machine can run.

    Pass ``data_store`` once it is known and the universe and benchmark enums
    narrow to that store's own instrument files. Without it they are the union
    across stores, and membership is left to the prepass -- a universe that
    exists in one store and not the other is a real distinction the schema
    cannot draw.

    Deliberately not derived from ``StrategyDraft.model_json_schema()``:
    pydantic emits ``default``, ``anyOf``, ``title`` and an optionality-derived
    ``required``, every one of which strict mode rejects or misreads.
    """
    stores = [data_store] if data_store else _store_keys()

    universes: list[str] = []
    benchmarks: list[str] = []
    for key in stores:
        store = marketdata.store_for(key)
        if store is None:
            continue
        universes += store["universes"]
        benchmarks += marketdata.store_symbols(key, "benchmarks")
    universes = sorted(set(universes))
    benchmarks = sorted(set(benchmarks))

    properties: dict[str, dict] = {
        "name": {"type": "string",
                 "description": "A short name for the strategy, 1-80 characters."},
        "model": _nullable("string", "The learner to train.",
                           [m["id"] for m in available_models()]),
        "handler": _nullable("string", "The feature set. Alpha158 is 158 "
                                       "engineered factors; Alpha360 is 360 raw "
                                       "price/volume lags.", list(HANDLERS)),
        "data_store": _nullable(
            "string",
            "Which store to run against. A store is one trading calendar: 'us' "
            "is the 252-day NYSE calendar and can hold equities, ETFs, crypto, "
            "FX and indices together; 'crypto_365' is crypto on all 365 days "
            "and nothing else can join it.", _store_keys()),
        "universe": _nullable(
            "string", "The instrument set to trade. Must exist in the chosen "
                      "store.", universes or None),
        "benchmark": _nullable(
            "string", "The symbol returns are compared against. Must exist in "
                      "the chosen store -- note SPY is not in the crypto store.",
            benchmarks or None),
    }

    for name, what in (
        ("train_start", "Training window start"), ("train_end", "Training window end"),
        ("valid_start", "Validation window start"), ("valid_end", "Validation window end"),
        ("test_start", "Backtest window start"), ("test_end", "Backtest window end"),
    ):
        properties[name] = _nullable(
            "string", f"{what}, YYYY-MM-DD. The three windows must not overlap: "
                      "validation after training, backtest after validation.")

    properties.update({
        "topk": _nullable("integer", "How many instruments to hold, 1-500."),
        "n_drop": _nullable("integer", "How many holdings to replace each "
                                       "rebalance, 0-100. Drives turnover."),
        "open_cost": _nullable("number", "Cost to open, as a fraction, 0-0.05."),
        "close_cost": _nullable("number", "Cost to close, as a fraction, 0-0.05."),
        "min_cost": _nullable("number", "Minimum cost per trade, in currency."),
        "account": _nullable("number", "Starting capital. Must be positive."),
        "limit_threshold": _nullable(
            "number", "Daily move beyond which a fill is impossible. Meaningful "
                      "for China's price limits; leave null otherwise."),
        "features": {
            # An array of objects under strict mode: every property required,
            # `additionalProperties: false`, and no `minItems` -- the 32-column
            # cap lives on StrategySpec and is caught at lowering, exactly as
            # topk's bounds are. `assumed` below is the same shape.
            "type": ["array", "null"],
            "description": "Custom factor columns to compute and put in front of "
                           "the model. Null means the handler's own feature set, "
                           "untouched. A name must not repeat one of the "
                           "handler's own columns.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {"type": "string",
                             "description": "The column name, e.g. 'MOM_RATIO'. "
                                            "Letters, digits and underscores; it "
                                            "must not start with LABEL."},
                    "expression": {"type": "string",
                                   "description": "A qlib expression over $fields. "
                                                  "It must not read the future: "
                                                  "Ref(x,-n) is a label, never a "
                                                  "feature."},
                },
                "required": ["name", "expression"],
            },
        },
        "feature_mode": _nullable(
            "string", "Whether custom factors are added to the handler's own "
                      "features or replace them entirely.",
            ["extend", "replace"]),
        "assumed": {
            "type": "array",
            "description": "One entry per parameter you chose that the "
                           "description did not state. Do not list values you "
                           "left null -- those are recorded for you.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "path": {"type": "string",
                             "description": "The field name, e.g. 'topk'."},
                    "value": {"type": ["string", "number", "boolean", "null"],
                              "description": "The value you chose."},
                    "why": {"type": "string",
                            "description": "One line, in plain language."},
                },
                "required": ["path", "value", "why"],
            },
        },
    })

    return {
        "type": "object",
        "additionalProperties": False,
        "properties": properties,
        "required": list(properties),
    }


# --------------------------------------------------------------------------
# Lowering
# --------------------------------------------------------------------------
def to_spec(draft: StrategyDraft) -> tuple[StrategySpec, list[AssumedParam]]:
    """Fill in what the draft left unstated, and say what was filled.

    Pure: no filesystem, no registries, no clock. Defaults are read out of
    ``StrategySpec.model_fields`` rather than repeated here -- a second copy of
    a default is the drift this module exists to remove.

    Raises `ValidationError` when the filled-in values do not make a spec; the
    caller turns that into draft-coordinate defects.
    """
    values: dict[str, Any] = {}
    assumed: list[AssumedParam] = []

    for name, info in StrategySpec.model_fields.items():
        stated = getattr(draft, name, None)
        if stated is not None:
            values[name] = stated
            continue
        if info.is_required():
            continue  # `name`; a missing one is a draft-shape error, not an assumption
        values[name] = info.get_default(call_default_factory=True)
        assumed.append(AssumedParam(
            path=name, value=values[name],
            why=_WHY.get(name, "not stated, so the default is used")))

    return StrategySpec(**values), assumed


def _vocabulary_defects(draft: StrategyDraft) -> list[dict]:
    """Stated values that are not in the vocabulary at all.

    Runs before `to_spec`, because these are `Literal` fields on `StrategySpec`
    and constructing it would raise on the first one -- which is exactly the
    one-defect-at-a-time behaviour this pipeline exists to avoid.
    """
    out: list[dict] = []
    if draft.model is not None and draft.model not in MODEL_SPECS:
        out.append(_err("unknown_model",
                        f"There is no model {draft.model!r}. Available: "
                        f"{', '.join(sorted(MODEL_SPECS))}.", "model"))
    if draft.handler is not None and draft.handler not in HANDLERS:
        out.append(_err("unknown_handler",
                        f"There is no handler {draft.handler!r}. Available: "
                        f"{', '.join(HANDLERS)}.", "handler"))
    if draft.feature_mode is not None and draft.feature_mode not in ("extend", "replace"):
        out.append(_err("unknown_feature_mode",
                        f"There is no feature mode {draft.feature_mode!r}. "
                        f"Available: extend, replace.", "feature_mode"))
    if draft.data_store is not None and marketdata.store_for(draft.data_store) is None:
        out.append(_err("unknown_store",
                        f"There is no data store {draft.data_store!r}. Available: "
                        f"{', '.join(s['key'] for s in marketdata.data_stores())}.",
                        "data_store"))
    return out


def _resolution_defects(spec: StrategySpec) -> list[dict]:
    """Values that are in the vocabulary but do not resolve on this machine.

    Every one of these currently surfaces minutes into a run, or not at all:
    an uninstalled model backend, a store that was never built, a universe with
    no instrument file, a benchmark that is not in the store the run will open.
    """
    out: list[dict] = []

    if spec.model not in {m["id"] for m in available_models()}:
        out.append(_err(
            "model_unavailable",
            f"The {spec.model!r} backend is not installed, so a run would fail "
            "after training starts. qlib skips a missing backend silently.",
            "model"))

    store = marketdata.store_for(spec.data_store)
    if store is None:  # already reported by _vocabulary_defects when stated
        return out
    if not store["exists"]:
        out.append(_err(
            "store_not_built",
            f"The {spec.data_store!r} store has not been built yet "
            f"({store['provider_uri']}).", "data_store"))
        return out  # nothing else in an empty store can resolve

    if spec.universe not in store["universes"]:
        out.append(_err(
            "unknown_universe",
            f"The {spec.data_store!r} store has no universe {spec.universe!r}. "
            f"Available: {', '.join(store['universes'])}.", "universe"))

    if spec.benchmark not in set(marketdata.store_symbols(spec.data_store, "all")):
        out.append(_err(
            "unknown_benchmark",
            f"{spec.benchmark!r} is not in the {spec.data_store!r} store, so "
            "there is nothing to compare returns against.", "benchmark"))

    return out


#: The four window problems that are genuinely fatal, and the field each is
#: about. `validate_windows` returns a fifth string -- the calendar clamp -- and
#: its absence here is deliberate: see `_clamp_test_end`.
_WINDOW_PATHS = {
    "Train end is before train start.": "train_end",
    "Validation overlaps training — the model would be scored on data it saw.": "valid_start",
    "Test overlaps validation — results would be optimistic.": "test_start",
    "Test end is before test start.": "test_end",
}


def _clamp_test_end(spec: StrategySpec, assumed: list[AssumedParam]) -> None:
    """Pull `test_end` back to the last safely backtestable day, and say so.

    `validate_windows` returns one string that is not an error: the calendar
    clamp, whose own text is "the run will end <date> instead". It is an
    announcement that `build_workflow_config` is about to shorten the backtest
    by a few sessions to avoid qlib's final-bar `IndexError` -- the run proceeds.

    Treating it as a defect made every curated template on this machine
    unrunnable the moment its hardcoded `test_end` fell behind an ingest: 31 of
    32 templates reported ``runnable: false`` with a message describing a run
    that would have worked. A date a few sessions past the end of the data is
    exactly the kind of thing a draft is expected not to know, which is what
    `assumed` is for -- so it is filled in and recorded, not refused.

    Recorded *before* the window check runs, so the clamped date is what gets
    validated and the string never reaches `_WINDOW_PATHS` to be misfiled as an
    ordering error. Genuine ordering problems are untouched: a test window that
    starts after it ends is still fatal, clamp or no clamp.
    """
    safe_end = marketdata.store_calendar_end(spec.data_store)
    if not safe_end or spec.test_end <= safe_end:
        return

    asked = spec.test_end
    spec.test_end = safe_end
    why = (f"{asked} is past the last day this store can safely backtest; "
           f"pulled back to {safe_end}")

    # Amend the existing row rather than adding a second one. A draft that left
    # `test_end` unstated already has a `test_end` row from the default fill,
    # and appending here would leave the first one quoting a value the spec no
    # longer holds -- an "assumed" list whose job is to be checkable against the
    # spec must not contain a row that fails that check.
    for row in assumed:
        if row.path == "test_end":
            row.value = safe_end
            row.why = f"{row.why}, then {why}"
            return

    assumed.append(AssumedParam(path="test_end", value=safe_end, why=why))


def lower_draft(draft: StrategyDraft | dict) -> LoweredDraft:
    """Draft -> the spec, the config and the exact YAML ``qrun`` would get.

    Raises `DraftError` carrying every defect the failing stage found. Stages
    are sequential where they have to be -- there is no spec to window-check if
    the draft did not parse -- so "every defect at once" means every defect
    *within* the stage that failed, which is where the aggregation actually buys
    something: an unknown universe and an overlapping window arrive together.

    Not pure: it resolves the store, the universes and the benchmark against the
    filesystem, because that is the whole point of resolving them here rather
    than discovering them mid-run. `to_spec` is the pure half.
    """
    if isinstance(draft, dict):
        try:
            draft = StrategyDraft.model_validate(draft)
        except ValidationError as exc:
            raise DraftError([
                _err("draft_shape", e["msg"], _loc_to_path(e["loc"]))
                for e in exc.errors()
            ]) from None

    defects = _vocabulary_defects(draft)
    if defects:
        raise DraftError(defects)

    try:
        spec, assumed = to_spec(draft)
    except ValidationError as exc:
        raise DraftError([
            _err("spec_shape", e["msg"], _loc_to_path(e["loc"]))
            for e in exc.errors()
        ]) from None

    assumed = [*draft.assumed, *assumed]

    defects = _resolution_defects(spec)
    # Only once the store resolves: the clamp is read out of that store's own
    # calendar, and there is nothing to clamp against when the store is missing.
    if not defects:
        _clamp_test_end(spec, assumed)
    defects += [_err("window_order", p, _WINDOW_PATHS.get(p))
                for p in spec.validate_windows()]
    if defects:
        raise DraftError(defects)

    warnings: list[str] = []
    if spec.limit_threshold is not None:
        warnings.append(
            "limit_threshold is set. It models China's daily price limits; on "
            "these stores it will block ordinary moves.")

    store = marketdata.store_for(spec.data_store)
    provider_uri, region = store["provider_uri"], store["region"]
    return LoweredDraft(
        spec=spec,
        assumed=assumed,
        warnings=warnings,
        config=build_workflow_config(spec, provider_uri, region),
        yaml=render_yaml(spec, provider_uri, region),
    )
