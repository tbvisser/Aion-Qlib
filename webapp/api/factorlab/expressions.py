"""Compile a factor expression, and refuse the ones that would lie.

Until now nothing checked a user's expression before running it. The canvas told
people "a negative Ref in a feature is lookahead, which the backend validator
refuses" and no such validator existed anywhere. So ``POST /api/factors/evaluate``
would happily score ``Ref($close,-5)/$close - 1`` and report a magnificent IC for
an expression that reads next week's prices.

That was survivable while an expression could only be *measured*. It stops being
survivable the moment one can be trained on, because a backtest is a claim about
money and a lookahead feature makes that claim fraudulent while looking flawless.

**qlib already knows the answer.** Every ``Expression`` implements
``get_extended_window_size() -> (back, forward)``; a positive ``forward`` is
exactly "this reads days it should not have". Compiling costs about 160 µs, needs
no store and no ``qlib.init()``, and it catches the cases a regex cannot::

    Ref($close,-5)/$close - 1               (0, 5)   plain
    If($close>$open, Ref($close,-1), $low)  (0, 1)   nested inside a condition
    Ref(Ref($close,3),-5)                   (3, 5)   looks cancelled; is not
    Ref($close, -2)/Ref($close, -1) - 1     (0, 2)   REQUIRED -- this is a label

That last line is why this is not a ban on minus signs. A label must read the
future; a feature must not. One implementation, checked in both directions.

The compilation namespace is deliberately ``operators.offered()`` rather than
qlib's own ``Operators`` global (which is empty until ``qlib.init()`` and logs
fifty override warnings if you register into it). That turns the judgement table
in ``operators.py`` from advisory into enforced: ``Mask``, ``TResample``, bare
``Rolling`` and ``$$roe`` are refused by construction, each with the reason the
registry already publishes.
"""
from __future__ import annotations

import ast
import math
import re
from dataclasses import dataclass
from functools import lru_cache
from types import SimpleNamespace
from typing import Literal

from qlib.data.base import Expression
from qlib.data.ops import OpsList, PairRolling, Rolling
from qlib.utils import parse_field

from .operators import JUDGEMENT, SERIES_PARAMS, offered

Role = Literal["feature", "label"]

_FIELD = re.compile(r"\$+([A-Za-z_][A-Za-z0-9_]*)")


def fields_read(expression: str) -> set[str]:
    """The store columns an expression names, without the `$`.

    Textual on purpose: this has to answer for an expression that does not
    compile, which is most of them while one is being typed.
    """
    return set(_FIELD.findall(expression))

# `parse_field` produces exactly one shape: attribute access on `Operators`,
# calls, literals and arithmetic. Anything else in there did not come from a
# factor expression.
#
# This matters because the last step is `eval`. A restricted globals dict is not
# a sandbox -- `$close.__class__` evaluates perfectly well through one -- and the
# existing evaluate endpoint hands its raw string to `D.features`, which evals it
# with full builtins. Whitelisting the tree before evaluating is what closes that,
# and it costs one pass.
_ALLOWED_NODES = (
    ast.Expression, ast.Call, ast.Attribute, ast.Name, ast.Load, ast.Constant,
    ast.BinOp, ast.UnaryOp, ast.Compare,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow,
    ast.USub, ast.UAdd, ast.BitAnd, ast.BitOr,
    ast.Gt, ast.GtE, ast.Lt, ast.LtE, ast.Eq, ast.NotEq,
)
_NAMESPACE = "Operators"


class ExpressionError(ValueError):
    """The expression could not be compiled at all."""


@dataclass(frozen=True)
class ExpressionDefect:
    """One thing wrong with an expression, in the caller's coordinates."""

    code: str
    message: str
    path: str | None = None

    def as_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "path": self.path}


@lru_cache(maxsize=1)
def _namespace() -> SimpleNamespace:
    """The operator vocabulary `eval` is allowed to see.

    ``Feature`` is admitted explicitly even though the registry refuses it --
    the refusal means "the canvas draws this as a field card, not an operator",
    and `parse_field` rewrites every ``$close`` into a ``Feature`` call, so the
    class has to be reachable. ``PFeature`` is deliberately left out, which is
    what makes ``$$roe`` fail with a name we can explain.
    """
    allowed = set(offered()) | {"Feature"}
    return SimpleNamespace(**{c.__name__: c for c in OpsList if c.__name__ in allowed})


def _check_tree(source: str, compiled_source: str) -> None:
    try:
        tree = ast.parse(compiled_source, mode="eval")
    except SyntaxError as exc:
        # `parse_field` rewrites every `name(` into `Operators.name(` with a
        # regex, so it can turn valid-looking Python into nonsense -- a list
        # comprehension becomes `[x for x Operators.in (1,2)]`. Without this the
        # SyntaxError escapes as a 500 rather than a refusal.
        raise ExpressionError(
            f"This is not a factor expression. Got: {source}") from exc
    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise ExpressionError(
                f"`{type(node).__name__}` is not something a factor expression can "
                f"contain. Got: {source}")
        if isinstance(node, ast.Attribute):
            if not (isinstance(node.value, ast.Name) and node.value.id == _NAMESPACE):
                raise ExpressionError(f"Attribute access is not allowed. Got: {source}")
        if isinstance(node, ast.Name) and node.id != _NAMESPACE:
            raise ExpressionError(
                f"`{node.id}` is not an operator or a field. Fields are written "
                f"`$close`. Got: {source}")


def explain(exc: Exception, expression: str) -> str:
    """Turn a compile failure into something a human -- or a model -- can act on.

    qlib compiles with ``eval`` over operator objects, so a leading unary minus
    raises "bad operand type for unary -: 'Sub'": accurate, and useless. Naming
    the repair turns a dead end into a one-line correction.

    Lives here rather than in the router so the message the canvas gets, the
    message the IC endpoint gets and the message a rejected draft gets are the
    same sentence.
    """
    message = str(exc)
    if "bad operand type for unary -" in message:
        return (
            f"qlib cannot apply a leading minus to an expression. Write "
            f"`-1 * (...)` or `0 - (...)` instead of `-(...)`. Got: {expression}")

    # An operator the registry refuses arrives as an AttributeError on our own
    # namespace. Answer with the reason the registry already publishes rather
    # than leaking a SimpleNamespace into the user's face.
    missing = re.search(r"has no attribute '(\w+)'", message)
    if missing:
        name = missing.group(1)
        if name == "PFeature":
            return (
                f"Point-in-time fields (`$$name`) need data no store here holds. "
                f"Got: {expression}")
        judgement = JUDGEMENT.get(name)
        if judgement is not None and judgement.refused:
            return f"`{name}` cannot be used here. {judgement.refused} Got: {expression}"
        return f"There is no operator called `{name}`. Got: {expression}"

    return f"Expression failed: {message}"


def compile_expression(expression: str) -> Expression:
    """A qlib ``Expression``, or ``ExpressionError`` with a readable reason."""
    text = (expression or "").strip()
    if not text:
        raise ExpressionError("An expression cannot be empty.")
    try:
        compiled_source = parse_field(text)
    except Exception as exc:  # noqa: BLE001 -- parse_field's failures are opaque
        raise ExpressionError(explain(exc, text)) from exc

    _check_tree(text, compiled_source)

    try:
        node = eval(compiled_source, {"Operators": _namespace(), "__builtins__": {}}, {})
    except Exception as exc:  # noqa: BLE001 -- eval raises whatever qlib raises
        raise ExpressionError(explain(exc, text)) from exc

    if not isinstance(node, Expression):
        # A bare number compiles fine and is not a factor.
        raise ExpressionError(
            f"`{text}` is a constant, not an expression over the data. It would be "
            f"the same value for every instrument on every day.")
    return node


def walk(node: Expression):
    """Every node in a compiled expression, parents first."""
    yield node
    for param in SERIES_PARAMS:
        child = getattr(node, param, None)
        if isinstance(child, Expression):
            yield from walk(child)


def _reads_ahead(node: Expression) -> int:
    return int(node.get_extended_window_size()[1])


def _offenders(root: Expression) -> list[str]:
    """The smallest sub-expressions responsible for reading ahead.

    Reporting the whole expression back would be useless on anything nested --
    the point is to name `Ref($close,-1)` inside a three-branch `If`, not to
    repeat what the user already typed. qlib's own `__str__` round-trips, so the
    rendered node is something they can search for.
    """
    guilty = [n for n in walk(root) if _reads_ahead(n) > 0]
    minimal = [
        n for n in guilty
        if not any(child is not n and _reads_ahead(child) > 0 for child in walk(n))
    ]
    return sorted({str(n) for n in (minimal or guilty)})


def _negative_windows(root: Expression) -> list[str]:
    """Rolling operators given a negative window.

    Not caught by ``get_extended_window_size`` -- ``Mean($close,-5)`` reports
    ``(0, 0)`` and then dies minutes into a run with
    ``min_periods 1 must be <= window -5``. ``Ref`` is excluded because a
    negative offset is its whole purpose.
    """
    out = []
    for node in walk(root):
        if not isinstance(node, (Rolling, PairRolling)) or type(node).__name__ == "Ref":
            continue
        window = getattr(node, "N", None)
        if isinstance(window, (int, float)) and window < 0:
            out.append(str(node))
    return sorted(set(out))


def inspect_expression(expression: str, *, role: Role = "feature",
                       path: str | None = None,
                       available_fields: set[str] | None = None) -> list[ExpressionDefect]:
    """Every reason this expression should not be run, in one pass.

    Aggregated rather than raised one at a time, so a model repairing a draft
    sees all of it at once instead of playing whack-a-mole across six turns.
    """
    def defect(code: str, message: str) -> ExpressionDefect:
        return ExpressionDefect(code, message, path)

    try:
        node = compile_expression(expression)
    except ExpressionError as exc:
        return [defect("invalid", str(exc))]

    defects: list[ExpressionDefect] = []
    ahead = _reads_ahead(node)

    if role == "feature" and ahead > 0:
        defects.append(defect("lookahead", (
            f"This reads {ahead} day{'s' if ahead != 1 else ''} into the future, so "
            f"a backtest using it would be measuring hindsight rather than skill. "
            f"The part that reads ahead is {', '.join(_offenders(node))}. "
            f"A negative Ref belongs in a label, never in a feature.")))
    elif role == "label" and ahead == 0:
        # The same fraud pointing the other way, and the reason this is not a
        # ban on minus signs: a label that reads no future is today's value, so
        # the model would be trained to predict what it already knows.
        defects.append(defect("no_lookahead_in_label", (
            "A label has to read forward -- it is the future return the model is "
            "trained to predict. This one reads no future, so it describes the "
            "present and any score against it is meaningless.")))

    for offender in _negative_windows(node):
        defects.append(defect("negative_window", (
            f"{offender} has a negative window. qlib accepts it here and then "
            f"fails part-way through the run with `min_periods 1 must be <= "
            f"window`. Only Ref takes a negative number, and only in a label.")))

    if math.isinf(node.get_longest_back_rolling()):
        defects.append(defect("unbounded_history", (
            "This needs unbounded history -- a window of 0 expands over everything "
            "before it -- so its value depends on where the query starts and it "
            "means something different in a preview than in a run.")))

    if available_fields is not None:
        unknown = sorted(fields_read(expression) - available_fields)
        if unknown:
            columns = ", ".join(f"${u}" for u in unknown)
            defects.append(defect("unknown_field", (
                f"This store has no {columns} column. qlib returns an empty series "
                f"for a missing column rather than failing, so the expression would "
                f"be NaN on every row with no error anywhere.")))

    return defects


def inspect_features(features, *, handler: str = "Alpha158", mode: str = "extend",
                     available_fields: set[str] | None = None) -> list[ExpressionDefect]:
    """A whole custom feature set: each expression, and the set as a whole.

    The collision check is the one that could not be discovered by using the
    app. qlib's ``NestedDataLoader.load`` drops the *accumulated* frame's
    duplicate columns before merging the next loader, so a custom column named
    ``MA5`` replaces Alpha158's ``MA5`` and the handler comes back with 158
    columns instead of 159. Nothing logs. Nothing warns. The model trains on a
    feature set the user believes contains both.
    """
    from .indicators import handler_columns

    defects: list[ExpressionDefect] = []
    features = list(features or [])

    if mode == "replace" and not features:
        return [ExpressionDefect("empty_feature_set", (
            "Replacing the handler's features needs at least one of your own, or "
            "there is nothing for the model to look at."), "features")]

    seen: dict[str, int] = {}
    base = handler_columns(handler) if mode == "extend" else {}

    for i, feature in enumerate(features):
        name = getattr(feature, "name", None) or feature["name"]
        expression = getattr(feature, "expression", None) or feature["expression"]
        path = f"features[{i}]"

        defects += inspect_expression(expression, role="feature",
                                      path=f"{path}.expression",
                                      available_fields=available_fields)

        if name in seen:
            defects.append(ExpressionDefect("duplicate_name", (
                f"Two columns are both called `{name}`. Names become pandas "
                f"columns, so the second would overwrite the first."),
                f"{path}.name"))
        elif name in base:
            defects.append(ExpressionDefect("collision", (
                f"`{name}` is already a column in {handler}. Extending would "
                f"replace {handler}'s `{name}` with yours and no error would be "
                f"raised anywhere -- qlib's loader keeps the later column and "
                f"drops the earlier one, so the handler would come back the same "
                f"size and the model would never see the original. Rename it, or "
                f"switch to replace."), f"{path}.name"))
        seen[name] = i

    return defects
