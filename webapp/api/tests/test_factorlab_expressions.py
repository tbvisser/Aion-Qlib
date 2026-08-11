"""The guard that stops an expression from lying about the future.

Until this existed, the canvas told people "a negative Ref in a feature is
lookahead, which the backend validator refuses" and no such validator was
anywhere in the app. `POST /api/factors/evaluate` would score
`Ref($close,-5)/$close - 1` and report a magnificent IC for an expression that
reads next week's prices.

The tests that matter most here are the ones that justify *compiling* rather
than pattern-matching, and the one that keeps this from becoming a ban on minus
signs -- a label must read forward, and the same implementation has to say so.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from webapp.api.factorlab import expressions as E
from webapp.api.factorlab.operators import offered
from webapp.api.main import app

pytestmark = pytest.mark.usefixtures("fake_stores")


def codes(expression: str, **kw) -> set[str]:
    return {d.code for d in E.inspect_expression(expression, **kw)}


# --------------------------------------------------------------------------
# Lookahead -- the reason this module exists
# --------------------------------------------------------------------------

@pytest.mark.parametrize("expression,days", [
    ("Ref($close,-5)/$close - 1", 5),
    ("If($close>$open, Ref($close,-1), $low)", 1),
    ("Ref(Ref($close,3),-5)", 5),
    ("Mean(Ref($close,-3),5)", 3),
    ("Corr($close, Ref($volume,-2), 20)", 2),
])
def test_a_feature_that_reads_the_future_is_refused(expression, days):
    defects = E.inspect_expression(expression, role="feature")
    assert [d.code for d in defects] == ["lookahead"]
    assert f"{days} day" in defects[0].message


@pytest.mark.parametrize("expression", [
    "Mean($close,5)/Mean($close,20) - 1",
    "Corr($close,$volume,20)",
    "Std($close/Ref($close,1)-1,20)",
    "($close-Min($low,20))/(Max($high,20)-Min($low,20)+1e-12)",
    "-1 * ($close/Ref($close,5) - 1)",
])
def test_an_ordinary_backward_feature_is_accepted(expression):
    """The guard must not be a minus-sign ban.

    Every one of these contains a minus, a Ref, or both, and every one is
    perfectly sound.
    """
    assert codes(expression) == set()


def test_a_regex_would_get_these_wrong():
    """Why this compiles instead of pattern-matching. Written down as a test.

    A naive `Ref\\([^)]*-` refuses the first two, which are clean. Tightening it
    to catch `,-` then misses the third, because a space is legal.
    """
    assert codes("Ref($close, 5) - 1") == set()
    assert codes("Ref($close-$open, 5)") == set()
    assert codes("Ref($close , -5)") == {"lookahead"}


def test_the_offending_sub_expression_is_named_not_the_whole_thing():
    """On a nested expression, repeating what the user typed helps nobody."""
    defects = E.inspect_expression("If($close>$open, Ref($close,-1), $low)")
    assert "Ref($close,-1)" in defects[0].message
    assert "If(" not in defects[0].message


def test_a_lookahead_label_is_required_not_refused():
    """The same fraud, pointing the other way -- one implementation, both ways.

    This is what keeps the guard honest: `Ref($close,-2)/Ref($close,-1) - 1` is
    qlib's own default label and must pass as one, while failing as a feature.
    """
    label = "Ref($close, -2)/Ref($close, -1) - 1"
    assert codes(label, role="label") == set()
    assert codes(label, role="feature") == {"lookahead"}


def test_a_label_that_reads_no_future_is_itself_a_defect():
    """A label describing the present trains the model to predict what it knows."""
    assert codes("Mean($close,5)", role="label") == {"no_lookahead_in_label"}


# --------------------------------------------------------------------------
# The failures qlib does not report as lookahead
# --------------------------------------------------------------------------

def test_a_negative_rolling_window_is_refused():
    """`get_extended_window_size()` says (0, 0) for this.

    It dies minutes into a run with `min_periods 1 must be <= window -5`, so it
    needs its own structural check rather than riding on the lookahead oracle.
    """
    assert E.inspect_expression("Mean($close,-5)")[0].code == "negative_window"
    assert codes("Std($close,-3)") == {"negative_window"}
    # Ref is exempt: a negative offset is the entire point of it.
    assert "negative_window" not in codes("Ref($close,-5)", role="label")


def test_an_unbounded_window_is_reported():
    """N=0 expands over all history, so the value depends on where you start."""
    assert "unbounded_history" in codes("Ref($close,0)")
    assert "unbounded_history" in codes("Mean($close,0)")


def test_an_unknown_column_is_reported_only_when_a_store_is_given():
    fields = {"open", "high", "low", "close", "volume"}
    assert codes("$vwap/$close", available_fields=fields) == {"unknown_field"}
    assert codes("$close/$open", available_fields=fields) == set()
    # Without a field list there is nothing to check against, so nothing is claimed.
    assert codes("$vwap/$close") == set()


def test_defects_are_aggregated_not_raised_one_at_a_time():
    """A model repairing a draft should see all of it, not play whack-a-mole."""
    found = codes("Mean(Ref($close,-3),0)")
    assert {"lookahead", "unbounded_history"} <= found


# --------------------------------------------------------------------------
# Compiling
# --------------------------------------------------------------------------

def test_a_refused_operator_is_refused_with_the_registry_s_own_reason():
    """The judgement table becomes enforcement rather than advice."""
    for expression, name in [("Mask($close,'SH600000')", "Mask"),
                             ("TResample($close,'1d','mean')", "TResample"),
                             ("Rolling($close,5,'mean')", "Rolling")]:
        defects = E.inspect_expression(expression)
        assert [d.code for d in defects] == ["invalid"]
        assert name in defects[0].message
        # The message is the reason the operator registry already publishes.
        assert len(defects[0].message) > 60


def test_point_in_time_fields_are_refused_by_name():
    assert "Point-in-time" in E.inspect_expression("$$roe")[0].message


def test_an_unknown_operator_says_so():
    assert "no operator called `Momentum`" in E.inspect_expression("Momentum($close,5)")[0].message


def test_a_leading_minus_names_its_repair():
    """qlib raises "bad operand type for unary -: 'Sub'", which helps nobody."""
    message = E.inspect_expression("-($close - $open)")[0].message
    assert "-1 * (...)" in message


def test_a_constant_is_not_an_expression():
    assert E.inspect_expression("5")[0].code == "invalid"
    assert "constant" in E.inspect_expression("5")[0].message


def test_an_empty_expression_is_refused():
    assert E.inspect_expression("   ")[0].code == "invalid"


def test_every_offered_operator_can_actually_be_compiled():
    """The namespace and the registry must agree, or the palette offers a lie."""
    samples = {
        "series": "$close", "window": "5", "scalar": "0.5",
    }
    for name, spec in offered().items():
        if spec.symbol:
            continue  # infix forms are exercised by the catalog round trip
        args = ", ".join(samples[slot.kind] for slot in spec.slots)
        expression = f"{name}({args})"
        try:
            E.compile_expression(expression)
        except E.ExpressionError as exc:  # pragma: no cover - failure detail
            pytest.fail(f"{expression} is offered but does not compile: {exc}")


# --------------------------------------------------------------------------
# eval hardening
# --------------------------------------------------------------------------

@pytest.mark.parametrize("attack", [
    "$close.__class__",
    "$close.__class__.__mro__",
    "__import__('os')",
    "(lambda: 1)()",
    "[x for x in (1,2)]",
    "$close[0]",
    "open('/etc/passwd')",
])
def test_the_compiler_refuses_things_that_are_not_factor_expressions(attack):
    """The last step is `eval`, and a restricted globals dict is not a sandbox.

    `D.features` evals the raw string inside qlib's own module globals with full
    builtins, so validating first is what stands between a text box and
    arbitrary execution. Localhost-only with no auth is a small blast radius,
    not an absent one.
    """
    with pytest.raises(E.ExpressionError):
        E.compile_expression(attack)


# --------------------------------------------------------------------------
# Over HTTP
# --------------------------------------------------------------------------

def test_evaluate_refuses_a_lookahead_expression_rather_than_scoring_it():
    """A beautiful IC with a caption under it is a number people screenshot."""
    with TestClient(app) as client:
        response = client.post("/api/factors/evaluate", json={
            "expression": "Ref($close,-5)/$close - 1", "universe": "top500"})
    assert response.status_code == 422
    body = response.json()["detail"]
    assert body["errors"][0]["code"] == "lookahead"


def test_validate_reports_what_an_expression_reads():
    with TestClient(app) as client:
        clean = client.post("/api/factors/validate", json={
            "expression": "Mean($close,5)/Mean($close,20) - 1"}).json()
        ahead = client.post("/api/factors/validate", json={
            "expression": "Ref($close,-5)/$close - 1"}).json()

    assert clean["ok"] is True
    assert clean["reads_ahead_days"] == 0
    assert clean["longest_back_rolling"] == 19

    assert ahead["ok"] is False
    assert ahead["reads_ahead_days"] == 5
    assert ahead["defects"][0]["code"] == "lookahead"


def test_validate_needs_no_store_and_no_initialised_qlib():
    """It is a compile, not a query. That is what lets the canvas call it live."""
    with TestClient(app) as client:
        response = client.post("/api/factors/validate", json={"expression": "$close/$open"})
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_validate_checks_columns_when_a_store_is_named():
    with TestClient(app) as client:
        unknown = client.post("/api/factors/validate", json={
            "expression": "$vwap/$close", "store": "nope"})
    assert unknown.status_code == 404


def test_validate_accepts_a_label_that_reads_forward():
    with TestClient(app) as client:
        response = client.post("/api/factors/validate", json={
            "expression": "Ref($close, -2)/Ref($close, -1) - 1", "role": "label"})
    assert response.json()["ok"] is True
