"""What this machine can run, and why a given spec cannot run on it.

The builder asks two questions on every keystroke, and they are one question
from opposite ends:

    check_spec(spec)     what is wrong with this spec?
    field_options(spec)  what may each field be changed to, given the rest?

They used to be answered by two pipelines that never met. `POST
/strategies/preview` and `POST /runs` ran the window and feature checks and
flattened them into one untyped ``list[str]``; `lower_draft` ran a structured
pipeline that *also* did four **resolution** checks -- is this model installed,
is this store built, is this universe in it, is this benchmark in it -- and was
reachable only from ``/strategies/from-draft`` and ``/templates``. The builder
consumes the first, so it could not learn that a benchmark was not in the store.

``webapp/data/runs/e59f918b7ff5`` is what that cost: ``crypto_365`` with
benchmark ``SPY``, which trained for four minutes fifty-one seconds and then
died in qlib's ``Account`` with "The benchmark ['SPY'] does not exist". The
check that catches it had existed the whole time, on the other pipeline. This
module is the one pipeline both now use.

Two things deliberately *not* here:

*   **Model x handler.** There is no such constraint in this app. All five
    entries in `MODEL_SPECS` are tabular and take any column count; the torch
    benchmarks that would care about ``d_feat`` were excluded because the ``rl``
    extras are not installed. Inventing the rule would disable options for a
    reason that is not true.
*   **The linear/vwap trap.** ``linear`` + ``Alpha360`` on a store whose vwap is
    a proxy is a real hazard, and `coverage_report` already computes the census
    it needs and reports ``dead_columns``/``proxy_columns`` from it. Saying it
    again here would mean a second census per preview and the same news twice --
    which is the thing `lib/blockers.ts` exists to prevent.

Nothing here is pure: it resolves against the filesystem and the installed
packages, which is the whole point of resolving it here rather than discovering
it mid-run. The registries it reads do their own caching.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .. import marketdata
from ..strategies import (
    HANDLERS,
    MODEL_SPECS,
    SpecDefect,
    StrategySpec,
    available_models,
)

#: The longest option list worth putting on the wire. A store's `all` set runs
#: to a few thousand names; a dropdown of those is not a choice, it is a search
#: box someone forgot to build. Past this the list is cut and `FieldOptions.note`
#: says so, because a silently truncated list reads as "these are the only ones".
MAX_OPTIONS = 200

#: An instrument file whose name marks it as a curated subset, e.g. `crypto_top100`.
_CURATED = re.compile(r"_top(\d+)$")


def _err(code: str, message: str, path: str | None = None) -> dict:
    """A defect as `DraftError` carries it. Lives here so `draft` can import it
    without this module importing `draft` back."""
    out = {"code": code, "message": message}
    if path is not None:
        out["path"] = path
    return out


# --------------------------------------------------------------------------
# Resolution
# --------------------------------------------------------------------------
#: The codes `resolution_defects` can emit.
#:
#: Named as a set because `preview_strategy` has to subtract exactly these to
#: rebuild its legacy `warnings` list: that field predates the resolution checks
#: and something on the wire still reads it, so it must keep meaning what it
#: meant. Subtracting by code beats re-running the other three checks, which
#: would mean a second store census on every keystroke.
RESOLUTION_CODES = frozenset({
    "model_unavailable", "store_not_built", "unknown_universe", "unknown_benchmark",
})


def resolution_defects(spec: StrategySpec) -> list[SpecDefect]:
    """Values that are in the vocabulary but do not resolve on this machine.

    Every one of these otherwise surfaces minutes into a run, or not at all: an
    uninstalled model backend, a store that was never built, a universe with no
    instrument file, a benchmark that is not in the store the run will open.

    Was `draft._resolution_defects`, reachable only from the draft pipeline.
    Moved here so `POST /runs` can call it too -- that is the fix for the run
    that trained for five minutes before discovering SPY was not in the crypto
    store.
    """
    out: list[SpecDefect] = []

    if spec.model not in {m["id"] for m in available_models()}:
        out.append(SpecDefect(
            "model_unavailable",
            f"The {spec.model!r} backend is not installed, so a run would fail "
            "after training starts. qlib skips a missing backend silently.",
            "model"))

    store = marketdata.store_for(spec.data_store)
    if store is None:  # a `Literal` on the spec; only a draft can state this
        return out
    if not store["exists"]:
        out.append(SpecDefect(
            "store_not_built",
            f"The {spec.data_store!r} store has not been built yet "
            f"({store['provider_uri']}).", "data_store"))
        return out  # nothing else in an empty store can resolve

    if spec.universe not in store["universes"]:
        out.append(SpecDefect(
            "unknown_universe",
            f"The {spec.data_store!r} store has no universe {spec.universe!r}. "
            f"Available: {', '.join(store['universes'])}.", "universe"))

    if spec.benchmark not in set(marketdata.store_symbols(spec.data_store, "all")):
        out.append(SpecDefect(
            "unknown_benchmark",
            f"{spec.benchmark!r} is not in the {spec.data_store!r} store, so "
            "there is nothing to compare returns against.", "benchmark"))

    return out


def check_spec(spec: StrategySpec, provider_uri: str | None = None) -> list[SpecDefect]:
    """Everything wrong with `spec`, blocking and advisory together, in one list.

    One call, so no caller can accidentally run three of the four checks -- which
    is exactly how `POST /runs` came to skip the resolution pass. Severity rides
    on each defect rather than being inferred from its wording, so a reworded
    message cannot change whether a strategy counts as runnable.

    `provider_uri` lets the feature check see the store's real columns. Without
    it a column reading a field the store does not carry is not caught here;
    with it, it is refused before anything runs.
    """
    out: list[SpecDefect] = []
    out += spec.window_defects()
    out += resolution_defects(spec)
    # `ExpressionDefect.path` is already spec coordinates (`features[2].name`),
    # and is kept whole: it is what lets a message point at one custom column.
    out += [SpecDefect(d.code, d.message, d.path or "features", "blocking")
            for d in spec.feature_defects(provider_uri)]
    out += spec.execution_defects()
    return out


def blocking(defects: list[SpecDefect]) -> list[SpecDefect]:
    """The defects that must stop a run, as opposed to merely explain one."""
    return [d for d in defects if d.severity == "blocking"]


# --------------------------------------------------------------------------
# Vocabulary
# --------------------------------------------------------------------------
def store_keys() -> list[str]:
    stores = marketdata.data_stores()
    built = [s["key"] for s in stores if s["exists"]]
    # An empty enum is not a legal schema. If nothing is built, offer everything
    # and let the prepass deliver the real news.
    return built or [s["key"] for s in stores]


def vocabulary(data_store: str | None = None) -> dict[str, list]:
    """The bare set of values each field admits, with no spec to judge against.

    Union across every built store when `data_store` is None -- a universe that
    exists in one store and not the other is a real distinction this cannot
    draw, which is why `field_options` exists and this is only its raw material.

    `draft_json_schema` and `field_options` both read from here so the strict
    schema handed to a generator and the lists offered in the builder cannot
    come to disagree about what exists. They still differ in one deliberate way:
    a schema enum is a hard constraint, so it lists only *installed* models,
    while the builder lists every model and greys out the ones without a
    backend -- an option you can see and cannot pick teaches more than one that
    was never there.
    """
    keys = [data_store] if data_store else store_keys()

    universes: list[str] = []
    benchmarks: list[str] = []
    for key in keys:
        store = marketdata.store_for(key)
        if store is None:
            continue
        universes += store["universes"]
        benchmarks += marketdata.store_symbols(key, "benchmarks")

    return {
        "model": [m["id"] for m in available_models()],
        "handler": list(HANDLERS),
        "data_store": store_keys(),
        "universe": sorted(set(universes)),
        "benchmark": sorted(set(benchmarks)),
        "feature_mode": ["extend", "replace"],
    }


# --------------------------------------------------------------------------
# Options
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class Fix:
    """A one-click way out of an incompatible choice.

    Applying it sets one other field, which is what makes the constraint
    legible: "SPY is not in the crypto store" is a fact, "switch to the us
    store" is the thing the reader actually wanted to know.
    """

    path: str
    value: Any
    label: str

    def as_dict(self) -> dict:
        return {"path": self.path, "value": self.value, "label": self.label}


@dataclass(frozen=True)
class Option:
    """One value a field may take, and whether it may take it *here*.

    A disabled option is still sent. Filtering incompatible values out of the
    list would hide the shape of the system from the reader and turn an early
    pick into a dead end; greying one out with its reason teaches the constraint
    instead.
    """

    value: Any
    label: str
    enabled: bool = True
    reason: str | None = None
    fix: Fix | None = None

    def as_dict(self) -> dict:
        return {"value": self.value, "label": self.label, "enabled": self.enabled,
                "reason": self.reason, "fix": self.fix.as_dict() if self.fix else None}


@dataclass(frozen=True)
class FieldOptions:
    """Everything a control needs to render itself honestly."""

    options: list[Option] = field(default_factory=list)
    #: `{min, max, exclusive_min, exclusive_max}`, read off the pydantic field.
    bounds: dict | None = None
    #: Prose for the whole field, when the option list alone would mislead.
    note: str | None = None

    def as_dict(self) -> dict:
        return {"options": [o.as_dict() for o in self.options],
                "bounds": self.bounds, "note": self.note}


def _bounds(name: str) -> dict | None:
    """A field's numeric bounds, read out of `StrategySpec` rather than retyped.

    `PortfolioInspector` currently hardcodes 1-500 and 0-100 to mirror the
    pydantic constraints. Two copies of a bound is how a form comes to accept a
    value the model then 422s, so the form should be told.
    """
    spec_field = StrategySpec.model_fields.get(name)
    if spec_field is None:
        return None
    out: dict[str, Any] = {}
    for meta in spec_field.metadata:
        for attr, key in (("ge", "min"), ("gt", "exclusive_min"),
                          ("le", "max"), ("lt", "exclusive_max")):
            value = getattr(meta, attr, None)
            if value is not None:
                out[key] = value
    return out or None


def _selectable_universes(store: dict) -> list[str]:
    """`benchmarks` is an instrument file, not a tradable universe."""
    return [u for u in (store.get("universes") or []) if u != "benchmarks"]


def _store_holding_universe(name: str, exclude: str) -> dict | None:
    for other in marketdata.data_stores():
        if other["key"] == exclude or not other["exists"]:
            continue
        if name in _selectable_universes(other):
            return other
    return None


def _store_holding_symbol(symbol: str, exclude: str) -> dict | None:
    for other in marketdata.data_stores():
        if other["key"] == exclude or not other["exists"]:
            continue
        if symbol in set(marketdata.store_symbols(other["key"], "all")):
            return other
    return None


def _benchmark_candidates(store: dict) -> tuple[list[str], str | None]:
    """What to offer for `benchmark`, and what to say about the offer.

    A store normally ships ``instruments/benchmarks.txt`` and that is the list.
    ``crypto_365`` ships none, and a membership rule with nothing to match
    against would disable every option and make the store unbuildable -- so fall
    back to its smallest curated universe, which is a real list of real symbols,
    and say that the offer is narrower than the truth. Validity is still decided
    against the store's whole `all` set, exactly as `resolution_defects` does it.
    """
    named = store.get("benchmarks") or []
    if named:
        return list(named), None

    curated = sorted(
        ((int(m.group(1)), u) for u in _selectable_universes(store)
         if (m := _CURATED.search(u))),
    )
    if not curated:
        return [], ("This store ships no benchmark list. Any symbol in it is a "
                    "valid benchmark.")

    pick = curated[0][1]
    return list(marketdata.store_symbols(store["key"], pick)), (
        f"This store ships no benchmark list, so these are the {pick} names. "
        f"Any symbol in the store is a valid benchmark.")


def _capped(values: list[str], note: str | None) -> tuple[list[str], str | None]:
    if len(values) <= MAX_OPTIONS:
        return values, note
    cut = f"Showing the first {MAX_OPTIONS} of {len(values)}."
    return values[:MAX_OPTIONS], f"{note} {cut}" if note else cut


def _model_options(spec: StrategySpec) -> FieldOptions:
    installed = {m["id"] for m in available_models()}
    return FieldOptions([
        Option(key, entry["label"], key in installed,
               None if key in installed else
               (f"The {entry['class']} backend is not installed. qlib skips a "
                f"missing backend silently, so a run would fail after training "
                f"starts."))
        for key, entry in MODEL_SPECS.items()
    ])


def _handler_options(spec: StrategySpec) -> FieldOptions:
    """Alpha158 or Alpha360, and whether the custom columns can live beside it.

    The one real constraint: in `extend` mode a custom column named `MA5`
    silently *replaces* Alpha158's `MA5`, because qlib's `NestedDataLoader.load`
    drops the accumulated frame's duplicates and logs nothing. Which names
    collide depends on the handler, so this is genuinely a compatibility
    question between two fields rather than a property of either.
    """
    names = [f.name for f in (spec.features or [])]
    out: list[Option] = []
    for name in HANDLERS:
        clashes: list[str] = []
        if names and spec.feature_mode == "extend":
            try:
                from ..factorlab.indicators import handler_columns

                base = handler_columns(name)
            except Exception:
                base = {}  # qlib unavailable: not a reason to disable a handler
            clashes = [n for n in names if n in base]
        if clashes:
            shown = ", ".join(f"`{c}`" for c in clashes[:3])
            more = f" and {len(clashes) - 3} more" if len(clashes) > 3 else ""
            out.append(Option(
                name, name, False,
                f"{shown}{more} would collide with {name}'s own columns. "
                f"Extending would replace {name}'s version with yours and "
                f"nothing would be raised anywhere.",
                Fix("feature_mode", "replace",
                    "Replace the handler's features instead")))
        else:
            out.append(Option(name, name))
    return FieldOptions(out)


def _store_options(spec: StrategySpec) -> FieldOptions:
    return FieldOptions([
        Option(s["key"], s["key"], bool(s["exists"]),
               None if s["exists"] else
               f"Not built on this machine ({s['provider_uri']}).")
        for s in marketdata.data_stores()
    ])


def _universe_options(spec: StrategySpec, store: dict | None) -> FieldOptions:
    if store is None or not store["exists"]:
        return FieldOptions([Option(spec.universe, spec.universe)])

    here = _selectable_universes(store)
    out = [Option(u, u) for u in here]
    if spec.universe and spec.universe not in here:
        elsewhere = _store_holding_universe(spec.universe, store["key"])
        out.insert(0, Option(
            spec.universe, spec.universe, False,
            f"Not in the {store['key']} store.",
            Fix("data_store", elsewhere["key"],
                f"Switch to the {elsewhere['key']} store") if elsewhere else None))
    return FieldOptions(out)


def _benchmark_options(spec: StrategySpec, store: dict | None) -> FieldOptions:
    if store is None or not store["exists"]:
        return FieldOptions([Option(spec.benchmark, spec.benchmark)])

    candidates, note = _benchmark_candidates(store)
    candidates, note = _capped(candidates, note)
    out = [Option(b, b) for b in candidates]

    # The current value always appears, enabled iff it is really in the store --
    # the same test `resolution_defects` applies. Without this a spec carrying a
    # benchmark outside the offered subset renders a blank select and reads as
    # though nothing was chosen.
    if spec.benchmark and spec.benchmark not in candidates:
        member = spec.benchmark in set(marketdata.store_symbols(store["key"], "all"))
        elsewhere = None if member else _store_holding_symbol(spec.benchmark, store["key"])
        out.insert(0, Option(
            spec.benchmark, spec.benchmark, member,
            None if member else f"Not in the {store['key']} store, so there is "
                                f"nothing to compare returns against.",
            Fix("data_store", elsewhere["key"],
                f"Switch to the {elsewhere['key']} store") if elsewhere else None))
    return FieldOptions(out, note=note)


def _feature_mode_options(spec: StrategySpec) -> FieldOptions:
    has = bool(spec.features)
    return FieldOptions([
        Option("extend", "Extend"),
        Option("replace", "Replace", has,
               None if has else "Replacing the handler's features needs at "
                                "least one column of your own, or there is "
                                "nothing for the model to look at."),
    ])


#: Fields whose only constraint is a numeric range.
_BOUNDED = ("topk", "n_drop", "open_cost", "close_cost", "min_cost", "account",
            "limit_threshold")


def field_options(spec: StrategySpec) -> dict[str, dict]:
    """Every field's admissible values, judged against the rest of `spec`.

    Enablement is computed *against the current spec* -- that is what makes this
    a compatibility engine rather than a list of enums. `SPY` is a fine
    benchmark until `data_store` is `crypto_365`, and `Alpha158` is a fine
    handler until a custom column is called `MA5`.
    """
    store = marketdata.store_for(spec.data_store)

    out: dict[str, FieldOptions] = {
        "model": _model_options(spec),
        "handler": _handler_options(spec),
        "data_store": _store_options(spec),
        "universe": _universe_options(spec, store),
        "benchmark": _benchmark_options(spec, store),
        "feature_mode": _feature_mode_options(spec),
    }
    for name in _BOUNDED:
        out[name] = FieldOptions(bounds=_bounds(name))

    # The ceiling qlib's final-bar `IndexError` puts on a backtest. Expressed as
    # a bound so the date input can refuse it, rather than only as the advisory
    # `calendar_clamp` that explains it after the fact.
    safe_end = marketdata.store_calendar_end(spec.data_store)
    out["test_end"] = FieldOptions(
        bounds={"max": safe_end} if safe_end else None,
        note=(f"{safe_end} is the last day this store can safely backtest."
              if safe_end else None))

    return {name: value.as_dict() for name, value in out.items()}
