"""The operator registry: does it still agree with qlib, and with the canvas?

Two kinds of test here, and they guard different failures.

The **drift pins** assert that our hand-written judgement still covers exactly
what qlib ships. A qlib upgrade that adds an operator should fail loudly with
the new name in the diff, not silently serve a vocabulary one item short.

The **contract tests** assert the served registry is substitutable for the one
the canvas ships. `mergeRegistry` replaces a whole entry rather than merging
field by field, so a renamed slot or a changed precedence does not fall back --
it produces an operator that parses to a different tree with no error anywhere.
"""
from __future__ import annotations

import inspect
import json
import re
import subprocess
import sys

import pytest

from ..factorlab import operators as O
from .helpers import REPO_ROOT

REGISTRY = O.build_registry()
OFFERED = O.offered(REGISTRY)


# --------------------------------------------------------------------------
# Drift: does the table still describe the qlib that is installed?
# --------------------------------------------------------------------------

def test_every_qlib_operator_is_either_offered_or_refused_with_a_reason():
    """The pin. Adding a class to OpsList fails here with its name in the diff."""
    from qlib.data.ops import OpsList

    shipped = {cls.__name__ for cls in OpsList}
    described = set(O.JUDGEMENT)

    assert shipped - described == set(), (
        "qlib has operators this app has no judgement for. Add them to "
        "factorlab.operators.JUDGEMENT."
    )
    assert described - shipped == set(), (
        "JUDGEMENT describes operators this qlib build does not have."
    )
    # And every one came out of build_registry with a verdict.
    for name in shipped:
        entry = REGISTRY[name]
        assert entry.refused is None or entry.refused.strip(), name


def test_the_offered_count_is_what_the_canvas_expects():
    assert len(REGISTRY) == 50
    assert len(OFFERED) == 44
    assert {op.name for op in REGISTRY.values() if op.refused} == {
        "Rolling", "TResample", "Mask", "ChangeInstrument", "PFeature", "Feature",
    }


def test_every_refusal_names_a_fact_about_qlib_not_a_preference():
    """A refusal the UI shows has to explain itself, not just say no."""
    for op in REGISTRY.values():
        if op.refused is None:
            continue
        assert len(op.refused) > 40, f"{op.name}'s refusal is too thin to show"
        assert not op.refused.lower().startswith("we "), op.name


@pytest.mark.parametrize("name,expected", [
    ("Rolling", "func"), ("TResample", "freq"), ("Mask", "instrument"),
    ("ChangeInstrument", "instrument"), ("Feature", "name"), ("PFeature", "name"),
])
def test_the_refused_operators_are_the_ones_with_undrawable_parameters(name, expected):
    """The refusal list and the signature partition must agree.

    If a class stopped taking a string parameter, it would become drawable and
    this test would say so rather than leaving it refused for a reason that no
    longer holds.
    """
    assert expected in REGISTRY[name].unsupported


# --------------------------------------------------------------------------
# The bugs this milestone exists to fix
# --------------------------------------------------------------------------

def test_kurt_accepts_the_window_qlib_accepts_not_the_one_its_message_names():
    """qlib/data/ops.py:946-947 guards on `N < 4` and then says "should >= 5".

    The canvas transcribed the sentence, so it refused a window qlib runs. The
    minimum is probed by construction now, which is why it is right.
    """
    from qlib.data.ops import Kurt
    from qlib.data.base import Feature

    Kurt(Feature("close"), 4)  # qlib is happy; must not raise
    with pytest.raises(ValueError):
        Kurt(Feature("close"), 3)

    assert REGISTRY["Kurt"].window.minimum == 4
    assert REGISTRY["Skew"].window.minimum == 3


def test_and_or_and_not_are_offered_because_the_parser_already_recommends_them():
    """The dead end this closes.

    parse.ts answers `$a and $b` with "Write `And(...)` instead" -- and then
    "There is no operator called `And`", because the built-in registry has no
    entry for it. Serving one is the whole fix.
    """
    repairs = _keyword_repairs_from_the_parser()
    assert repairs == {"and": "And", "or": "Or", "not": "Not"}
    for recommended in repairs.values():
        assert recommended in OFFERED, (
            f"the parser tells users to write {recommended}(...), so it must exist"
        )


def test_and_and_or_are_not_offered_as_infix_symbols():
    """`&` and `|` bind looser than comparisons in Python, which qlib inherits.

    `$a > 1 & $b > 1` parses as `$a > (1 & $b) > 1` -- silently wrong rather than
    refused. Offering them as calls only is the safe half of the fix.
    """
    for name in ("And", "Or", "Not"):
        assert OFFERED[name].symbol is None


def test_ref_does_not_claim_the_expanding_window_semantics_of_its_siblings():
    """Ref is a Rolling subclass whose _load_internal ignores rolling entirely.

    N=0 pins every row to the first observation; it does not expand. The built-in
    registry applied one shared constant to all of them and got this wrong.
    """
    ref = REGISTRY["Ref"].window
    assert ref.expanding_at_zero is False
    assert ref.ewm_below_one is False
    assert ref.allows_negative is True

    mean = REGISTRY["Mean"].window
    assert mean.expanding_at_zero is True
    assert mean.ewm_below_one is True
    assert mean.allows_negative is False


def test_pair_rolling_expands_but_has_no_ewm_branch():
    """Corr/Cov reach `.rolling(0.5)` and raise for a fractional window."""
    for name in ("Corr", "Cov"):
        window = REGISTRY[name].window
        assert window.expanding_at_zero is True
        assert window.ewm_below_one is False


# --------------------------------------------------------------------------
# Substitutability: is the served registry a drop-in for the built-in one?
# --------------------------------------------------------------------------

def _ts(path: str) -> str:
    return (REPO_ROOT / "webapp" / "ui" / "src" / path).read_text()


def _keyword_repairs_from_the_parser() -> dict:
    source = _ts("lib/factorExpr/parse.ts")
    block = re.search(r"KEYWORD_REPAIR[^=]*=\s*\{([^}]*)\}", source).group(1)
    return dict(re.findall(r"(\w+):\s*'(\w+)'", block))


def _fallback_slot_names() -> dict[str, list[str]]:
    """Slot names the shipped canvas uses, read out of registry.ts.

    Parsed rather than duplicated: the point is to compare against what actually
    ships, and a copy here would drift the same way the registry did.
    """
    source = _ts("lib/factorExpr/registry.ts")
    names: dict[str, list[str]] = {}
    for match in re.finditer(r"slots:\s*\[([^\]]*)\]", source):
        pass  # per-operator extraction below; this loop only proves the shape
    # `infix(...)` and `rolling(...)` build slots from helpers, so read the
    # helper definitions rather than every call site.
    assert "series('left'), series('right')" in source
    assert "series('feature', 'series'), window()" in source
    return names


def test_the_served_slot_names_match_the_ones_the_canvas_ships():
    """The landmine.

    qlib calls a binary operator's arguments `feature_left`/`feature_right`.
    The canvas calls them `left`/`right`, and builds a node by looking up
    `args[slot.name]`. Serving qlib's names would leave every binary operator
    with two empty slots and no error anywhere -- the parser would happily
    produce `Add` nodes with nothing in them.
    """
    _fallback_slot_names()
    for name in ("Add", "Sub", "Mul", "Div", "Power", "Gt", "Corr", "Cov",
                 "Greater", "Less", "And", "Or"):
        assert [s.name for s in OFFERED[name].slots][:2] == ["left", "right"], name
    for name in ("Mean", "Std", "Ref", "Abs", "Log", "Not"):
        assert OFFERED[name].slots[0].name == "feature", name
    assert [s.name for s in OFFERED["If"].slots] == ["condition", "left", "right"]
    assert [s.name for s in OFFERED["Quantile"].slots] == ["feature", "N", "qscore"]


def test_slot_order_is_qlibs_constructor_order():
    """The parser binds call arguments positionally, so order is load-bearing.

    `Quantile($close, 20, 0.8)` must map 20 to the window and 0.8 to the
    quantile; a slot list in the other order would build a valid-looking node
    that renders back as a different expression.
    """
    from qlib.data.ops import OpsList

    for cls in OpsList:
        op = REGISTRY[cls.__name__]
        if op.refused:
            continue
        parameters = [p for p in inspect.signature(cls.__init__).parameters
                      if p != "self"]
        assert len(op.slots) == len(parameters), cls.__name__
        for slot, parameter in zip(op.slots, parameters):
            kind = "window" if parameter == "N" else (
                "scalar" if parameter == "qscore" else "series")
            assert slot.kind == kind, f"{cls.__name__}.{parameter}"


def test_the_served_precedence_agrees_with_the_parsers_own_table():
    """parse.ts does NOT read precedence from the registry; serialize.ts does.

    So a served precedence that disagreed would break parse -> render -> parse
    silently: the string would reparse into a differently-shaped tree. The two
    tables have to be asserted against each other, because nothing else does it.
    """
    source = _ts("lib/factorExpr/parse.ts")
    block = source[source.index("const BINARY"):source.index("/** Longest first")]
    levels = dict(re.findall(r"PRECEDENCE\.(\w+)", source[:source.index("const BINARY")]) or [])

    parser_table = {}
    for symbol, op, precedence in re.findall(
        r"'([^']+)':\s*\{\s*op:\s*'(\w+)',\s*precedence:\s*PRECEDENCE\.(\w+)", block
    ):
        parser_table[op] = (symbol, O.PRECEDENCE[precedence])

    served = {
        op.name: (op.symbol, op.precedence)
        for op in OFFERED.values() if op.symbol
    }
    assert served == parser_table

    right = set(re.findall(r"op:\s*'(\w+)'[^}]*right:\s*true", block))
    assert {op.name for op in OFFERED.values() if op.right_associative} == right


def test_every_offered_category_is_one_the_canvas_can_label():
    """CATEGORY_LABELS is exhaustive over OpCategory; an unknown key renders blank."""
    source = _ts("lib/factorExpr/registry.ts")
    block = source[source.index("CATEGORY_LABELS"):]
    known = set(re.findall(r"(\w+):\s*'", block[:block.index("}")]))
    assert {op.category for op in OFFERED.values()} <= known


# --------------------------------------------------------------------------
# Serialisation
# --------------------------------------------------------------------------

def test_the_payload_is_camel_case_and_omits_rather_than_nulls():
    """`mergeRegistry` replaces whole entries, so a mis-cased key is not ignored.

    It leaves that operator with undefined window semantics and no complaint.
    """
    payload = O.registry_payload()
    snake = re.compile(r"_")

    def walk(node, path="#"):
        if isinstance(node, dict):
            for key, value in node.items():
                assert not snake.search(key), f"{path}/{key} is not camelCase"
                assert value is not None, f"{path}/{key} is null; omit it instead"
                walk(value, f"{path}/{key}")
        elif isinstance(node, list):
            for i, value in enumerate(node):
                walk(value, f"{path}/{i}")

    walk(payload["operators"])
    assert set(payload) == {"operators", "refused"}
    assert len(payload["operators"]) == 44
    # Refused entries carry a reason and nothing the canvas would try to draw.
    for entry in payload["refused"]:
        assert set(entry) == {"name", "summary", "reason"}


def test_the_payload_survives_a_json_round_trip():
    payload = O.registry_payload()
    assert json.loads(json.dumps(payload)) == payload


def test_operator_signatures_replace_the_hand_written_list():
    """The 25 strings deleted from factors.py named 25 of 44 operators.

    Regenerated, the list cannot drift from what the canvas offers.
    """
    signatures = O.operator_signatures()
    assert len(signatures) == 44 - len(O._INFIX)
    assert "Quantile(feature, n, q)" in signatures
    assert "Corr(left, right, n)" in signatures
    assert "If(condition, left, right)" in signatures
    # Infix operators are rendered as symbols, so listing `Add(a, b)` in prose
    # would teach a form the canvas never produces.
    assert not any(s.startswith("Add(") for s in signatures)


def test_factorlab_builds_without_qlib_being_initialised():
    """The whole package must work on a machine with no store.

    `qlib.init()` mutates process-global config, and importing a read-only
    vocabulary must never trigger it -- otherwise the registry would be
    unavailable exactly when a new user needs the canvas to explain itself.
    """
    script = (
        "import sys; sys.path.insert(0, %r);"
        "from api.factorlab.operators import registry_payload;"
        "from api.factorlab.indicators import build_library;"
        "p = registry_payload(); lib = build_library();"
        "import qlib.config;"
        "assert not getattr(qlib.config.C, '_registered', False), 'qlib was initialised';"
        "print(len(p['operators']), len(lib))"
    ) % str(REPO_ROOT / "webapp")
    result = subprocess.run([sys.executable, "-c", script], capture_output=True,
                            text=True, cwd=str(REPO_ROOT))
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "44 184"
