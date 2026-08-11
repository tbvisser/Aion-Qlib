"""The operator registry, introspected from ``qlib.data.ops.OpsList``.

The canvas needs three things about every operator that a hand-written table
kept getting wrong: how many arguments it takes and in what order, which of them
are series versus windows, and what a window actually means.

All three are now *read out of qlib*:

* **Arity and order** come from ``inspect.signature``. This matters more than it
  looks -- the parser binds call arguments positionally, so a slot list in the
  wrong order silently builds a different expression than the one written.
* **Slot kind** is a clean partition of the parameter names qlib uses. There are
  only six across all fifty classes, and the four that are not ``feature*`` or
  ``N``/``qscore`` mark a class the canvas cannot draw at all.
* **Window semantics** are read from the class hierarchy, and the minimum window
  is *probed* by construction rather than declared. That is what gets ``Kurt``
  right: its guard is ``N < 4`` but the message it raises says 5, so every
  transcription of it has been off by one.

What is *not* in qlib is judgement -- whether an operator is worth offering, what
category it belongs to, and how to describe it in a sentence. That is the one
hand-written table below, pinned by a drift test asserting its keys equal
``OpsList``'s in both directions, so a qlib upgrade that adds a class fails
loudly with the new name in the diff rather than quietly dropping it.
"""
from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Literal

from qlib.data.base import Feature
from qlib.data.ops import OpsList, PairRolling, Rolling

SlotKind = Literal["series", "window", "scalar"]

# The parameter names qlib's operators actually use, mapped to what the canvas
# calls them. `feature_left`/`feature_right` are renamed to `left`/`right`
# because the frontend's slot names are a rendered label and a port key, and
# `mergeRegistry` replaces a whole entry -- a served `feature_left` where the
# canvas expects `left` would leave every binary operator with two empty slots
# and no error anywhere. The names below ARE the fallback registry's names, and
# a test asserts they still are.
_SERIES_SLOTS: dict[str, tuple[str, str | None]] = {
    "feature": ("feature", "series"),
    "feature_left": ("left", None),
    "feature_right": ("right", None),
    "condition": ("condition", None),
}
_NUMERIC_SLOTS: dict[str, tuple[str, SlotKind, str]] = {
    "N": ("N", "window", "window"),
    "qscore": ("qscore", "scalar", "quantile"),
}

#: qlib's own names for the arguments that hold another expression.
#:
#: Exported because walking a compiled tree needs them, and a second hand-written
#: list of child attribute names is exactly the drift this module exists to
#: remove. qlib stores every constructor argument under its parameter name, so
#: `getattr(node, param)` is the whole traversal.
SERIES_PARAMS = tuple(_SERIES_SLOTS)

# Where the generic name reads badly on a card. `If`'s two branches are `left`
# and `right` to qlib and to the parser, which binds positionally -- but a card
# labelled "left"/"right" on a conditional tells the reader nothing. The slot
# *name* is the contract; the label is only what is drawn beside it.
_SLOT_LABELS: dict[str, dict[str, str]] = {
    "If": {"left": "then", "right": "else"},
    "Ref": {"N": "days back"},
}


@dataclass(frozen=True)
class Judgement:
    """What we think of an operator. The only hand-written part of the registry."""

    category: str
    summary: str
    refused: str | None = None


# Infix rendering. qlib's own `__str__` is always `Name(a,b)`, so the symbol and
# its binding power are ours -- they come from Python's grammar, because that is
# what qlib's eval-based parser actually obeys.
#
# This table is asserted against the frontend parser's own BINARY table, which
# does not read precedence from the registry. A served precedence that disagreed
# would break parse-render-parse silently rather than loudly.
PRECEDENCE = {"compare": 1, "additive": 2, "multiplicative": 3, "power": 4}

_INFIX: dict[str, tuple[str, int, bool]] = {
    "Add": ("+", PRECEDENCE["additive"], False),
    "Sub": ("-", PRECEDENCE["additive"], False),
    "Mul": ("*", PRECEDENCE["multiplicative"], False),
    "Div": ("/", PRECEDENCE["multiplicative"], False),
    "Power": ("**", PRECEDENCE["power"], True),
    "Gt": (">", PRECEDENCE["compare"], False),
    "Ge": (">=", PRECEDENCE["compare"], False),
    "Lt": ("<", PRECEDENCE["compare"], False),
    "Le": ("<=", PRECEDENCE["compare"], False),
    "Eq": ("==", PRECEDENCE["compare"], False),
    "Ne": ("!=", PRECEDENCE["compare"], False),
}

# `And` and `Or` map to Python's `&` and `|`, which bind LOOSER than comparisons
# -- so `$a > 1 & $b > 1` parses as `$a > (1 & $b) > 1` and is silently wrong.
# They are offered as calls only. The parser already tells anyone who writes
# `and` to write `And(...)`, and until now there was no `And` for it to find.
_CALL_ONLY_LOGIC = {"And", "Or", "Not"}

JUDGEMENT: dict[str, Judgement] = {
    # -- arithmetic ---------------------------------------------------------
    "Add": Judgement("arithmetic", "Add two series."),
    "Sub": Judgement("arithmetic", "Subtract the right from the left."),
    "Mul": Judgement("arithmetic", "Multiply two series."),
    "Div": Judgement("arithmetic", "Divide the left by the right."),
    "Power": Judgement("arithmetic", "Raise the left to the right."),
    # -- comparisons --------------------------------------------------------
    "Gt": Judgement("compare", "True where the left exceeds the right."),
    "Ge": Judgement("compare", "True where the left is at least the right."),
    "Lt": Judgement("compare", "True where the left is under the right."),
    "Le": Judgement("compare", "True where the left is at most the right."),
    "Eq": Judgement("compare", "True where the two are equal."),
    "Ne": Judgement("compare", "True where the two differ."),
    # -- element by element -------------------------------------------------
    "Abs": Judgement("elementwise", "Absolute value."),
    "Log": Judgement("elementwise", "Natural logarithm."),
    "Sign": Judgement("elementwise", "Sign: -1, 0 or 1."),
    "Greater": Judgement("elementwise", "The larger of two series, element by element."),
    "Less": Judgement("elementwise", "The smaller of two series, element by element."),
    # -- logic --------------------------------------------------------------
    "If": Judgement("logic", "Pick from two series according to a condition."),
    "And": Judgement("logic", "True where both sides are true."),
    "Or": Judgement("logic", "True where either side is true."),
    "Not": Judgement("logic", "Flip a true/false series."),
    # -- rolling ------------------------------------------------------------
    "Ref": Judgement("rolling", "The series as it was N days ago."),
    "Mean": Judgement("rolling", "Rolling mean over N days."),
    "Sum": Judgement("rolling", "Rolling sum over N days."),
    "Std": Judgement("rolling", "Rolling standard deviation over N days."),
    "Var": Judgement("rolling", "Rolling variance over N days."),
    "Max": Judgement("rolling", "Rolling maximum over N days."),
    "Min": Judgement("rolling", "Rolling minimum over N days."),
    "Med": Judgement("rolling", "Rolling median over N days."),
    "Mad": Judgement("rolling", "Rolling mean absolute deviation over N days."),
    "Rank": Judgement("rolling", "Where today's value sits in the last N days, 0 to 1."),
    "Delta": Judgement("rolling", "Change over N days: today minus N days ago."),
    "Slope": Judgement("rolling", "Slope of a line fitted through the last N days."),
    "Rsquare": Judgement("rolling", "Fit quality of that line, 0 to 1."),
    "Resi": Judgement("rolling", "Residual from that line."),
    # Both summaries used to say "how many days ago", which is backwards. qlib
    # computes `argmax() + 1` over the window, counting from its *oldest* end --
    # so a high made today returns N, not 0. Anyone building an Aroon-style
    # indicator from the old wording built it inverted.
    "IdxMax": Judgement("rolling", "Where the N-day maximum sits in the window: "
                                   "1 for the oldest bar, N for today."),
    "IdxMin": Judgement("rolling", "Where the N-day minimum sits in the window: "
                                   "1 for the oldest bar, N for today."),
    "EMA": Judgement("rolling", "Exponentially weighted mean over N days."),
    "WMA": Judgement("rolling", "Linearly weighted mean over N days."),
    "Count": Judgement("rolling", "How many non-missing values in the last N days."),
    "Skew": Judgement("rolling", "Rolling skewness: how lopsided the last N days were."),
    "Kurt": Judgement("rolling", "Rolling kurtosis: how fat the tails of the last N days were."),
    "Quantile": Judgement("rolling", "Rolling quantile over N days."),
    # -- two-series windows -------------------------------------------------
    "Corr": Judgement("pair", "Rolling correlation of two series."),
    "Cov": Judgement("pair", "Rolling covariance of two series."),
    # -- refused ------------------------------------------------------------
    # Each of these is refused for a fact about qlib, not a preference. The
    # reason is served to the UI so a palette can say why rather than just
    # omitting something the docs mention.
    "Rolling": Judgement(
        "rolling",
        "The generic rolling operator every other one is built on.",
        refused="Its `func` argument names the statistic, and qlib's own __str__ "
        "drops it -- Rolling($close,5,\"mean\") renders as Rolling($close,5), "
        "which cannot be read back. Use the named operator instead.",
    ),
    "TResample": Judgement(
        "rolling",
        "Resample to another frequency.",
        refused="Renders as TResample($close,1d) -- both the unquoted frequency "
        "and the dropped `func` make it unreadable, and these stores are daily.",
    ),
    "Mask": Judgement(
        "elementwise",
        "Read a feature from one named instrument.",
        refused="Renders the instrument unquoted and lower-cased, so Mask($close,"
        "'SH600000') reads back as a NameError rather than an expression.",
    ),
    "ChangeInstrument": Judgement(
        "elementwise",
        "Evaluate a feature against a different instrument.",
        refused="Takes a quoted instrument name, and the canvas has no slot kind "
        "for a string -- every slot is a series, a window or a number.",
    ),
    "PFeature": Judgement(
        "elementwise",
        "A point-in-time field, written $$name.",
        refused="Needs point-in-time data that no store on this machine holds.",
    ),
    "Feature": Judgement(
        "elementwise",
        "A raw column, written $name.",
        refused="This is the leaf itself. The canvas draws it as a field card, "
        "not as an operator.",
    ),
}


@dataclass(frozen=True)
class Slot:
    name: str
    kind: SlotKind
    label: str | None = None


@dataclass(frozen=True)
class WindowSemantics:
    """What the integer in the window box means. Three operators, three answers."""

    expanding_at_zero: bool
    ewm_below_one: bool
    minimum: int | None = None
    allows_negative: bool = False
    note: str | None = None


@dataclass(frozen=True)
class Operator:
    name: str
    category: str
    summary: str
    slots: list[Slot]
    symbol: str | None = None
    precedence: int | None = None
    right_associative: bool = False
    window: WindowSemantics | None = None
    refused: str | None = None
    unsupported: list[str] = field(default_factory=list)


def _slots(cls: type) -> tuple[list[Slot], list[str]]:
    """Partition a constructor signature into canvas slots.

    Returns the slots and the parameters that could not be turned into one; a
    non-empty second element means the class is undrawable whatever we think of
    it, which is why the refusal reasons and this check must agree.
    """
    parameters = [p for p in inspect.signature(cls.__init__).parameters if p != "self"]
    overrides = _SLOT_LABELS.get(cls.__name__, {})
    slots: list[Slot] = []
    unsupported: list[str] = []
    for name in parameters:
        if name in _SERIES_SLOTS:
            slot_name, label = _SERIES_SLOTS[name]
            slots.append(Slot(slot_name, "series", overrides.get(slot_name, label)))
        elif name in _NUMERIC_SLOTS:
            slot_name, kind, label = _NUMERIC_SLOTS[name]
            slots.append(Slot(slot_name, kind, overrides.get(slot_name, label)))
        else:
            unsupported.append(name)
    return slots, unsupported


def _probe_minimum_window(cls: type, slots: list[Slot]) -> int | None:
    """The smallest window the constructor actually accepts.

    Probed rather than declared. ``Kurt`` guards on ``N < 4`` while raising a
    message that says 5 (qlib/data/ops.py:946-947), so any registry that copies
    the sentence refuses a window qlib is happy to run. Constructing is free --
    no data is touched until ``load``.
    """
    probe = Feature("close")

    def build(n: int):
        args = []
        for slot in slots:
            if slot.kind == "series":
                args.append(probe)
            elif slot.kind == "window":
                args.append(n)
            else:
                args.append(0.5)
        return cls(*args)

    for candidate in range(1, 16):
        try:
            build(candidate)
        except Exception:
            continue
        return candidate if candidate > 1 else None
    return None


def _window_semantics(cls: type, slots: list[Slot]) -> WindowSemantics | None:
    """Read the meaning of N off the class hierarchy.

    Three genuinely different answers, which a single shared constant cannot
    carry:

    ``Ref``        overrides ``_load_internal`` entirely. N=0 is not expanding --
                   it pins every day to the first observation -- and a fractional
                   N is not an EWM alpha, it is a shift by a fraction of a row.
                   It is also the only operator that accepts a negative N.
    ``PairRolling`` expands at 0 but has no EWM branch, so a fractional window
                   reaches ``.rolling(0.5)`` and raises.
    ``Rolling``    expands at 0, and 0 < N < 1 is an EWM alpha -- but the EWM
                   branch is hard-coded to ``.mean()`` and ignores ``func``, so a
                   fractional window silently turns Std into a mean.
    """
    if not any(s.kind == "window" for s in slots):
        return None

    minimum = _probe_minimum_window(cls, slots)

    if cls.__name__ == "Ref":
        return WindowSemantics(
            expanding_at_zero=False,
            ewm_below_one=False,
            minimum=minimum,
            allows_negative=True,
            note="N=0 repeats the first observation. A negative N reads the "
            "future -- correct in a label, lookahead in a feature.",
        )
    if issubclass(cls, PairRolling):
        return WindowSemantics(
            expanding_at_zero=True, ewm_below_one=False, minimum=minimum
        )
    if issubclass(cls, Rolling):
        return WindowSemantics(
            expanding_at_zero=True,
            ewm_below_one=True,
            minimum=minimum,
            note="A window below 1 is an EWM alpha, and qlib's EWM branch always "
            "takes a mean -- it ignores which statistic this operator names.",
        )
    return WindowSemantics(expanding_at_zero=False, ewm_below_one=False, minimum=minimum)


def build_registry() -> dict[str, Operator]:
    """Every class in ``OpsList``, offered or refused with a reason."""
    registry: dict[str, Operator] = {}
    for cls in OpsList:
        name = cls.__name__
        judgement = JUDGEMENT.get(name)
        if judgement is None:
            # The drift test names this; at runtime an unknown class is refused
            # rather than guessed at, so a qlib upgrade cannot quietly widen the
            # vocabulary the canvas offers.
            registry[name] = Operator(
                name=name,
                category="elementwise",
                summary=f"{name} is new in this qlib build.",
                slots=[],
                refused="This build of qlib has an operator the app has no "
                "description for. Add it to factorlab.operators.JUDGEMENT.",
            )
            continue

        slots, unsupported = _slots(cls)
        refused = judgement.refused
        if unsupported and refused is None:
            refused = (
                f"Takes {', '.join(unsupported)}, which the canvas has no slot "
                f"kind for."
            )

        symbol, precedence, right = _INFIX.get(name, (None, None, False))
        registry[name] = Operator(
            name=name,
            category=judgement.category,
            summary=judgement.summary,
            slots=slots,
            symbol=symbol,
            precedence=precedence,
            right_associative=right,
            window=_window_semantics(cls, slots) if refused is None else None,
            refused=refused,
            unsupported=unsupported,
        )
    return registry


def offered(registry: dict[str, Operator] | None = None) -> dict[str, Operator]:
    registry = registry if registry is not None else build_registry()
    return {k: v for k, v in registry.items() if v.refused is None}


def _window_payload(w: WindowSemantics) -> dict:
    payload: dict = {
        "expandingAtZero": w.expanding_at_zero,
        "ewmBelowOne": w.ewm_below_one,
    }
    if w.minimum is not None:
        payload["min"] = w.minimum
    if w.allows_negative:
        payload["allowsNegative"] = True
    if w.note:
        payload["note"] = w.note
    return payload


def to_payload(op: Operator) -> dict:
    """Serialise one operator for the canvas.

    camelCase, and optional keys are *omitted* rather than sent as null.
    ``mergeRegistry`` replaces a whole entry rather than merging field by field,
    so a mis-cased or null-valued key does not fall back to the built-in value --
    it blanks that operator's semantics with no error anywhere.
    """
    payload: dict = {
        "name": op.name,
        "category": op.category,
        "summary": op.summary,
        "slots": [
            {"name": s.name, "kind": s.kind, **({"label": s.label} if s.label else {})}
            for s in op.slots
        ],
    }
    if op.symbol:
        payload["symbol"] = op.symbol
        payload["precedence"] = op.precedence
        if op.right_associative:
            payload["rightAssociative"] = True
    if op.window is not None:
        payload["window"] = _window_payload(op.window)
    return payload


def registry_payload() -> dict:
    """``GET /api/operators``: the offered vocabulary, plus what was refused."""
    registry = build_registry()
    return {
        "operators": {
            name: to_payload(op)
            for name, op in registry.items()
            if op.refused is None
        },
        "refused": [
            {"name": op.name, "summary": op.summary, "reason": op.refused}
            for op in registry.values()
            if op.refused is not None
        ],
    }


def expression_language_block(fields: list[str] | None = None) -> str:
    """The factor-language briefing both chat prompts share.

    Generated, because the hand-written version in each prompt named 14 of the
    44 operators -- so the model was told `Kurt` and `WMA` did not exist, and
    quietly avoided them. Written once because the two copies had already begun
    to differ in wording.
    """
    columns = " ".join(f"${f}" for f in (fields or ["open", "high", "low", "close", "volume"]))
    return (
        "Factor expression language:\n"
        f"- Fields: {columns}\n"
        f"- Operators: {' '.join(operator_signatures())}\n"
        "- Infix: + - * / ** and the comparisons. `and`/`or`/`not` are Python "
        "keywords qlib evaluates wrongly — write And(a,b), Or(a,b), Not(a).\n"
        "- A leading minus on an expression fails; write -1 * (...) instead.\n"
        "- Ref(x,n) looks BACK n days; Ref(x,-n) looks FORWARD (labels only).\n"
        "- $close is back-adjusted and rebased, so $close/$factor is the real "
        "traded price."
    )


def operator_signatures() -> list[str]:
    """One-line call signatures, for prose surfaces like the chat prompt.

    Regenerated from the registry so the strings cannot drift from the operators
    the canvas actually offers, which is what happened to the hand-written list
    this replaces.
    """
    lines = []
    for op in offered().values():
        if op.name in _INFIX:
            continue
        args = ", ".join(
            "n" if s.kind == "window" else "q" if s.kind == "scalar" else s.name
            for s in op.slots
        )
        lines.append(f"{op.name}({args})")
    return sorted(lines)
