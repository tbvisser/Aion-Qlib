"""The builder assistant proposes. It must not be able to act.

That guarantee is worth testing rather than trusting, because the difference
between "the prompt says not to" and "there is no handler to dispatch to" is the
difference between a model that usually behaves and one that structurally
cannot. `chat.py` looks a tool up in whatever `build_registry` returned, so the
absence of `run_backtest` from the builder profile is the whole enforcement.

The second thing defended here is the meaning of `assumed`. When the user says
"make it more conservative", every field carried over from the strategy on
screen was *decided by them*, and calling it an assumption would corrupt the one
honest artifact the pipeline produces. Inherited and assumed are separate lists
and these tests keep them separate.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from webapp.api.auth import Principal
from webapp.api import chat_tools
from webapp.api.chat_tools import (
    PROFILES, BuilderContext, build_registry, render_context, system_prompt,
    tool_schemas,
)
from webapp.api.main import app
from webapp.api.strategies import StrategySpec
from webapp.api.strategy_gen.draft import UNSUPPORTED_SCHEMA_KEYWORDS, draft_json_schema
from webapp.api.tests.helpers import walk_schema

pytestmark = pytest.mark.usefixtures("fake_stores")

PROFILE_NAMES = sorted(PROFILES)


class ExplodingRunManager:
    """Every way a run could start, wired to fail the test instead."""

    def start(self, *a, **k):  # noqa: ANN002, ANN003
        raise AssertionError("the builder assistant started a run")

    def get(self, *a, **k):
        raise AssertionError("the builder assistant read a run")

    def list(self, *a, **k):
        raise AssertionError("the builder assistant listed runs")


#: Who the assistant is acting for. Every strategy it saves and every run it
#: starts is owned by this account -- an agent is a way of doing your own work,
#: not a shared login. These tests only need the identity to exist.
FAKE_PRINCIPAL = Principal(
    user_id="00000000-0000-0000-0000-000000000001",
    email="tests@example.invalid",
    org_id="00000000-0000-0000-0000-000000000002",
    org_role="owner",
)


def builder(context: BuilderContext | None = None):
    return build_registry(ExplodingRunManager(), FAKE_PRINCIPAL,
                          profile="builder", context=context)


# --------------------------------------------------------------------------
# The guarantee
# --------------------------------------------------------------------------
def test_the_builder_cannot_run_anything():
    registry = builder()
    assert "run_backtest" not in registry
    assert "run_backtest" not in [t["function"]["name"] for t in tool_schemas("builder")]


def test_no_builder_tool_touches_the_run_manager():
    """Not "it did not this time" — the double raises on any contact."""
    registry = builder()
    registry["list_templates"]()
    registry["propose_strategy"](name="Anything")


def test_the_general_profile_keeps_everything_it_had():
    """The builder is an addition, not a downgrade of the existing Chat page."""
    names = {t["function"]["name"] for t in tool_schemas("general")}
    assert names == {"get_data_status", "search_instruments", "get_price_summary",
                     "evaluate_factor", "run_backtest", "get_run_status", "list_runs",
                     "start_scalability_analysis", "get_scalability_report",
                     "book_venue_consultation"}


def test_the_scalability_tools_are_general_only():
    """Booking shares user data with a venue; the builder assistants, which
    only propose, have no business holding that handler."""
    scalability = {"start_scalability_analysis", "get_scalability_report",
                   "book_venue_consultation"}
    general = build_registry(ExplodingRunManager(), FAKE_PRINCIPAL, profile="general")
    assert scalability <= set(general)
    for profile in ("builder",):
        registry = build_registry(ExplodingRunManager(), FAKE_PRINCIPAL, profile=profile)
        schemas = {t["function"]["name"] for t in tool_schemas(profile)}
        assert not (scalability & set(registry))
        assert not (scalability & schemas)


@pytest.mark.parametrize("profile", PROFILE_NAMES)
def test_every_schema_has_a_handler_and_every_handler_a_schema(profile):
    """Two hand-keyed structures; this is the cheap structural fix.

    A schema with no handler reaches the model as an offer `chat.py` answers
    with "Unknown tool"; a handler with no schema is dead code.
    """
    schemas = {t["function"]["name"] for t in tool_schemas(profile)}
    handlers = set(build_registry(ExplodingRunManager(), FAKE_PRINCIPAL, profile=profile))
    assert schemas == handlers


def test_an_unknown_profile_is_a_404():
    assert TestClient(app).get("/api/chat/config?profile=nope").status_code == 404


def test_chat_config_reports_the_profile_it_was_asked_about():
    client = TestClient(app)
    general = client.get("/api/chat/config").json()
    builder_cfg = client.get("/api/chat/config?profile=builder").json()
    assert general["profile"] == "general"
    assert "run_backtest" in general["tools"]
    assert builder_cfg["profile"] == "builder"
    assert "propose_strategy" in builder_cfg["tools"]
    assert "run_backtest" not in builder_cfg["tools"]


# --------------------------------------------------------------------------
# The generated schema
# --------------------------------------------------------------------------
def _propose_schema() -> dict:
    tool = next(t for t in tool_schemas("builder")
                if t["function"]["name"] == "propose_strategy")
    return tool["function"]["parameters"]


def test_propose_strategy_parameters_are_the_generated_schema():
    """Not a hand-written copy — that is the drift this whole path removes."""
    params = _propose_schema()
    assert set(params["properties"]) == set(draft_json_schema()["properties"]) | {
        "start_from", "template_id"}


def test_the_propose_schema_is_still_strict_mode_clean():
    for keyword, pointer, value in walk_schema(_propose_schema()):
        if keyword == "__object__":
            assert value.get("additionalProperties") is False, pointer
            assert set(value.get("required", [])) == set(value.get("properties", {})), pointer
        else:
            assert keyword not in UNSUPPORTED_SCHEMA_KEYWORDS, f"{pointer}: {keyword}"


def test_the_propose_schema_is_built_at_call_time(fake_stores):
    """A schema frozen at import would freeze the universe list with it."""
    assert "brand_new" not in _propose_schema()["properties"]["universe"]["enum"]
    fake_stores[0]["universes"].append("brand_new")
    assert "brand_new" in _propose_schema()["properties"]["universe"]["enum"]


# --------------------------------------------------------------------------
# Proposing
# --------------------------------------------------------------------------
def test_a_proposal_from_defaults_assumes_everything_it_was_not_told():
    result = builder()["propose_strategy"](name="Fresh", model="xgboost")
    assert result["source"] == "defaults"
    assert result["inherited"] == []
    assert result["spec"]["model"] == "xgboost"
    assert {a["path"] for a in result["assumed"]} >= {"topk", "universe", "benchmark"}
    assert "yaml" not in result, "the model never reads it and the panel regenerates it"


def test_start_from_current_inherits_and_does_not_call_it_an_assumption():
    """The distinction the whole merge exists to preserve."""
    context = BuilderContext(spec=StrategySpec(name="On screen", topk=25, universe="macro50"))
    result = builder(context)["propose_strategy"](name="Fewer names", topk=100)

    assert result["source"] == "current"
    assert result["spec"]["topk"] == 100, "a stated field wins over the inherited one"
    assert result["spec"]["universe"] == "macro50", "an unstated field is carried over"

    inherited = {i["path"] for i in result["inherited"]}
    assumed = {a["path"] for a in result["assumed"]}
    assert "universe" in inherited and "universe" not in assumed
    assert "topk" not in inherited and "topk" not in assumed
    assert not (inherited & assumed), "a field cannot be both"


def test_start_from_defaults_ignores_what_is_on_screen():
    """Otherwise 'something new' silently inherits the old store and benchmark."""
    context = BuilderContext(spec=StrategySpec(name="Crypto", data_store="crypto_365",
                                               universe="crypto_top100", benchmark="BTC-USD"))
    result = builder(context)["propose_strategy"](name="Equities", start_from="defaults")
    assert result["source"] == "defaults"
    assert result["spec"]["data_store"] == "us"


def test_start_from_a_template_carries_what_the_template_decided():
    result = builder()["propose_strategy"](
        name="Crypto but smaller", start_from="template",
        template_id="crypto-365", topk=5)
    assert result["source"] == "template:crypto-365"
    assert result["spec"]["data_store"] == "crypto_365"
    assert result["spec"]["benchmark"] == "BTC-USD"
    assert result["spec"]["topk"] == 5


def test_no_start_from_means_current_when_there_is_one():
    context = BuilderContext(spec=StrategySpec(name="On screen", universe="macro50"))
    assert builder(context)["propose_strategy"](name="x")["source"] == "current"
    assert builder()["propose_strategy"](name="x")["source"] == "defaults"


def test_a_bad_draft_comes_back_as_errors_not_an_exception():
    """Raising would let chat.py flatten the list into one string and lose the
    per-field paths the model repairs from."""
    result = builder()["propose_strategy"](
        name="Bad", universe="top1000", valid_start="2009-01-01")
    assert "spec" not in result
    assert {e["code"] for e in result["errors"]} == {"unknown_universe", "window_order"}
    assert all("path" in e for e in result["errors"])


def test_an_unknown_template_is_an_error_the_model_can_act_on():
    result = builder()["propose_strategy"](
        name="x", start_from="template", template_id="nope")
    assert result["errors"][0]["code"] == "unknown_template"
    assert "list_templates" in result["errors"][0]["message"]


def test_list_templates_omits_what_cannot_run(fake_stores):
    """Proposing a template the engine would refuse is worse than proposing none."""
    assert any(t["id"] == "crypto-365" for t in builder()["list_templates"]()["templates"])
    fake_stores[1]["exists"] = False
    assert not any(t["id"] == "crypto-365" for t in builder()["list_templates"]()["templates"])


def test_list_templates_says_what_each_one_already_decides():
    first = builder()["list_templates"]()["templates"][0]
    assert {"id", "title", "rationale", "good_for", "bad_for", "sets"} <= set(first)
    assert "model" in first["sets"]
    assert "spec" not in first, "the lowered spec is tokens the model does not need"


# --------------------------------------------------------------------------
# Context
# --------------------------------------------------------------------------
def test_the_context_message_is_rebuilt_not_replayed():
    """It never enters the transcript, so history cannot carry a stale spec."""
    context = BuilderContext(spec=StrategySpec(name="On screen", topk=25))
    rendered = render_context(context)
    assert "topk" in rendered and "25" in rendered
    assert render_context(None) is None
    assert render_context(BuilderContext()) is None


def test_the_canvas_expression_is_offered_as_both_measurable_and_insertable():
    """This used to say the opposite, and it was right to.

    A canvas expression could only be measured until `StrategySpec.features`
    existed. Now it can become a column, and a context that still said "you
    cannot put it into the strategy" would make the assistant refuse the one
    thing the user just gained.
    """
    rendered = render_context(BuilderContext(expression="Ref($close,20)/$close - 1"))
    assert "evaluate_factor" in rendered
    assert "features" in rendered
    assert "cannot put it into the strategy" not in rendered


def test_the_builder_prompt_states_the_two_rules_the_server_enforces():
    """A refusal the model does not understand becomes an argument with the user."""
    prompt = system_prompt("builder")
    assert "must not repeat one of the handler's own names" in prompt
    assert "must not read the future" in prompt
    # And it should steer towards extending a real baseline rather than
    # replacing 158 factors with one.
    assert "prefer extend" in prompt.lower()


def test_the_builder_prompt_refuses_to_claim_it_ran_anything():
    prompt = system_prompt("builder")
    assert "you do not apply it" in prompt.lower()
    assert "never say you have started, saved or run anything" in prompt.lower()
    assert "no entry or exit rule" in prompt.lower()


def test_the_two_profiles_do_not_share_a_prompt():
    assert system_prompt("builder") != system_prompt("general")
    assert chat_tools.SYSTEM_PROMPT == system_prompt("general")
