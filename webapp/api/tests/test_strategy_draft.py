"""A draft must never promise something the engine will refuse.

Two failure modes are worth this much test surface. The first is drift: any
hand-written copy of the strategy vocabulary goes stale, and `chat_tools.py`'s
`run_backtest` schema is the standing proof -- it is six fields behind
`StrategySpec` and nobody noticed, because nothing compared them. Several tests
here are that comparison.

The second is the lie of a plausible default. A strategy that inherits `SPY` as
its benchmark and `crypto_365` as its store looks entirely reasonable and cannot
run, and today that is discovered minutes into training. The prepass tests pin
that it is discovered at lowering time instead, together with every other defect
rather than one at a time.

Nothing here touches the real store: the stores are monkeypatched, so the suite
answers the same on a machine that has never built one.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from webapp.api import marketdata
from webapp.api.main import app
from webapp.api.strategies import HANDLERS, MODEL_SPECS, StrategySpec, build_workflow_config
from webapp.api.strategy_gen import draft as draft_mod
from webapp.api.strategy_gen.draft import (
    UNSUPPORTED_SCHEMA_KEYWORDS,
    DraftError,
    StrategyDraft,
    draft_json_schema,
    lower_draft,
    to_spec,
)
from webapp.api.tests.helpers import import_check, walk_schema

pytestmark = pytest.mark.usefixtures("fake_stores")


def _draft(**overrides) -> dict:
    return {"name": "Test strategy", **overrides}


# --------------------------------------------------------------------------
# The schema cannot drift, and cannot offer the unavailable
# --------------------------------------------------------------------------
def test_schema_is_strict_mode_clean():
    """Strict structured output rejects an unsupported keyword outright, so the
    builder must be unable to emit one -- and every property must be `required`,
    with optionality carried by the type."""
    schema = draft_json_schema()
    for keyword, pointer, value in walk_schema(schema):
        if keyword == "__object__":
            assert value.get("additionalProperties") is False, \
                f"{pointer} allows extra properties"
            assert set(value.get("required", [])) == set(value.get("properties", {})), \
                f"{pointer} does not require every property"
        else:
            assert keyword not in UNSUPPORTED_SCHEMA_KEYWORDS, \
                f"{pointer} emits unsupported keyword {keyword!r}"


def test_schema_covers_every_strategy_spec_field():
    """The test that `chat_tools.py`'s hand-written schema never had.

    Adding a field to `StrategySpec` without wiring the draft fails here, which
    is the only reason the two stay in step.
    """
    schema = draft_json_schema()
    assert set(schema["properties"]) == set(StrategySpec.model_fields) | {"assumed"}


def test_unstated_is_representable_for_every_optional_field():
    """`None` is the whole design: a spec cannot say "nobody asked for this"."""
    schema = draft_json_schema()
    for name, prop in schema["properties"].items():
        if name in ("name", "assumed"):
            continue
        assert "null" in prop["type"], f"{name} cannot be left unstated"
        if "enum" in prop:
            assert None in prop["enum"], f"{name}'s enum forbids the null its type allows"


def test_schema_enums_come_from_the_live_registries(fake_stores):
    """Built at call time, not at import: a store gaining a universe is visible
    without restarting the process."""
    before = draft_json_schema()["properties"]["universe"]["enum"]
    assert "brand_new" not in before

    fake_stores[0]["universes"].append("brand_new")
    after = draft_json_schema()["properties"]["universe"]["enum"]
    assert "brand_new" in after


def test_schema_offers_only_importable_models(monkeypatch):
    """qlib skips an uninstalled backend silently, so offering one is offering a
    run that dies after training starts."""
    monkeypatch.setattr(draft_mod, "available_models",
                        lambda: [{"id": "lightgbm", "label": "LightGBM", "class": "LGBModel"}])
    enum = draft_json_schema()["properties"]["model"]["enum"]
    assert enum == ["lightgbm", None]
    assert "xgboost" in MODEL_SPECS, "the point is that a *declared* model can still be absent"


def test_schema_handler_enum_is_not_a_re_typed_literal():
    assert draft_json_schema()["properties"]["handler"]["enum"] == [*HANDLERS, None]


def test_schema_narrows_to_one_store_when_it_is_known():
    """The union is the honest answer before the store is chosen; after it, the
    schema can say what that store actually holds."""
    crypto = draft_json_schema("crypto_365")["properties"]
    # `all` is one of them: the crypto store ships all.txt alongside the two
    # curated lists, and `data_stores` filters out only `benchmarks`.
    assert set(crypto["universe"]["enum"]) == {"all", "crypto", "crypto_top100", None}
    # The crypto store has no curated benchmark list, so there is nothing to
    # offer and the schema declines to invent one.
    assert "enum" not in crypto["benchmark"]


def test_every_schema_property_parses_into_the_draft():
    """The reverse direction, so schema and model are pinned as a pair without
    either being derived from the other."""
    schema = draft_json_schema()
    instance = {}
    for name, prop in schema["properties"].items():
        if name == "assumed":
            instance[name] = [{"path": "topk", "value": 30, "why": "round number"}]
        elif name == "features":
            instance[name] = [{"name": "MOM_RATIO",
                               "expression": "Mean($close,5)/$close - 1"}]
        elif "enum" in prop:
            instance[name] = prop["enum"][0]
        elif "integer" in prop["type"]:
            instance[name] = 7
        elif "number" in prop["type"]:
            instance[name] = 0.01
        else:
            instance[name] = "2020-01-01"
    parsed = StrategyDraft.model_validate(instance)
    assert parsed.name == "2020-01-01"  # the string branch; it is the only required field


# --------------------------------------------------------------------------
# What was chosen, and what was merely inherited
# --------------------------------------------------------------------------
def test_defaults_come_from_strategy_spec_not_literals(monkeypatch):
    """A second copy of a default is the drift this module exists to remove."""
    monkeypatch.setattr(StrategySpec.model_fields["topk"], "default", 99)
    spec, assumed = to_spec(StrategyDraft(name="x"))
    assert spec.topk == 99
    assert next(a for a in assumed if a.path == "topk").value == 99


def test_one_assumed_row_per_unstated_field():
    spec, assumed = to_spec(StrategyDraft(name="x", topk=30, model="xgboost"))
    paths = {a.path for a in assumed}
    assert "topk" not in paths and "model" not in paths
    assert paths == set(StrategySpec.model_fields) - {"name", "topk", "model"}
    assert all(a.why for a in assumed), "an assumption without a reason is not honest"


def test_a_fully_stated_draft_assumes_nothing():
    stated = {name: info.get_default() for name, info in StrategySpec.model_fields.items()
              if not info.is_required()}
    _, assumed = to_spec(StrategyDraft(name="x", **stated))
    # Two fields have `None` as their own default, so the draft cannot tell
    # "you asked for no price limit / no custom factors" from "you said nothing"
    # -- see the test below. Every other field must come back unassumed.
    assert {a.path for a in assumed} <= {"limit_threshold", "features"}


def test_no_price_limit_is_always_recorded_as_an_assumption():
    """The one field where "unstated" and the stated value coincide.

    `limit_threshold=None` means "no price limit", and None is also how the
    draft says nothing was stated. Rather than invent a sentinel for a field
    whose two readings have identical effect, the row is always emitted -- which
    is the useful direction to be wrong in, since "no price limit" is a real
    decision a reader should get to see.
    """
    _, assumed = to_spec(StrategyDraft(name="x", limit_threshold=None))
    row = next(a for a in assumed if a.path == "limit_threshold")
    assert row.value is None and "no price limit" in row.why

    _, stated = to_spec(StrategyDraft(name="x", limit_threshold=0.095))
    assert not [a for a in stated if a.path == "limit_threshold"]


def test_the_authors_own_assumptions_survive_lowering():
    lowered = lower_draft(_draft(topk=30, assumed=[
        {"path": "topk", "value": 30, "why": "you said a concentrated book"}]))
    mine = [a for a in lowered.assumed if a.path == "topk"]
    assert len(mine) == 1 and mine[0].why == "you said a concentrated book"


def test_to_spec_is_pure(monkeypatch):
    """The pure half stays pure: no store, no registry, no filesystem."""
    monkeypatch.setattr(marketdata, "data_stores",
                        lambda: (_ for _ in ()).throw(AssertionError("touched the stores")))
    spec, _ = to_spec(StrategyDraft(name="x"))
    assert spec.name == "x"


# --------------------------------------------------------------------------
# Lowering: every defect at once, in the draft's own vocabulary
# --------------------------------------------------------------------------
def test_lower_draft_aggregates_every_defect():
    with pytest.raises(DraftError) as exc:
        lower_draft(_draft(universe="top1000", benchmark="NOPE",
                           valid_start="2009-01-01", test_start="2009-06-01"))
    codes = [e["code"] for e in exc.value.errors]
    assert sorted(codes) == ["unknown_benchmark", "unknown_universe",
                             "window_order", "window_order"]


def test_defect_paths_are_draft_coordinates():
    """A model reading its own mistakes back must see the name it used."""
    with pytest.raises(DraftError) as exc:
        lower_draft(_draft(universe="top1000", valid_start="2009-01-01"))
    by_path = {e["path"]: e["code"] for e in exc.value.errors}
    assert by_path == {"universe": "unknown_universe", "valid_start": "window_order"}
    assert set(by_path) <= set(StrategyDraft.model_fields)


def test_unknown_universe_is_a_defect():
    with pytest.raises(DraftError) as exc:
        lower_draft(_draft(universe="top1000"))
    assert exc.value.errors[0]["code"] == "unknown_universe"
    assert "top500" in exc.value.errors[0]["message"], "say what is available"


def test_a_universe_from_the_other_store_is_still_a_defect():
    """Membership is per store, because qrun inits against one of them."""
    with pytest.raises(DraftError) as exc:
        lower_draft(_draft(data_store="crypto_365", universe="top500",
                           benchmark="BTC-USD"))
    assert [e["code"] for e in exc.value.errors] == ["unknown_universe"]


def test_the_default_benchmark_is_refused_on_the_crypto_store():
    """The failure this whole prepass is worth having: every field is plausible,
    the strategy is unrunnable, and today nothing says so until the run."""
    with pytest.raises(DraftError) as exc:
        lower_draft(_draft(data_store="crypto_365", universe="crypto_top100"))
    assert [e["code"] for e in exc.value.errors] == ["unknown_benchmark"]
    assert "SPY" in exc.value.errors[0]["message"]


def test_unbuilt_store_is_a_defect(fake_stores):
    fake_stores[1]["exists"] = False
    with pytest.raises(DraftError) as exc:
        lower_draft(_draft(data_store="crypto_365"))
    assert [e["code"] for e in exc.value.errors] == ["store_not_built"]


def test_unknown_store_is_a_defect():
    with pytest.raises(DraftError) as exc:
        lower_draft(_draft(data_store="mars"))
    assert exc.value.errors[0]["code"] == "unknown_store"


def test_uninstalled_model_is_a_defect(monkeypatch):
    monkeypatch.setattr(draft_mod, "available_models",
                        lambda: [{"id": "lightgbm", "label": "LightGBM", "class": "LGBModel"}])
    with pytest.raises(DraftError) as exc:
        lower_draft(_draft(model="xgboost"))
    assert [e["code"] for e in exc.value.errors] == ["model_unavailable"]


def test_unknown_model_is_reported_before_the_spec_refuses_to_build():
    """`model` is a Literal on the spec, so constructing it would raise on the
    first bad value; the vocabulary pass exists so the message is ours."""
    with pytest.raises(DraftError) as exc:
        lower_draft(_draft(model="gpt"))
    assert exc.value.errors[0]["code"] == "unknown_model"
    assert exc.value.errors[0]["path"] == "model"


def test_window_overlap_is_blocking():
    """`create_strategy` and `start_run` already refuse these; `preview` calls
    them warnings. Lowering follows the paths that actually run."""
    with pytest.raises(DraftError) as exc:
        lower_draft(_draft(train_start="2020-01-01", train_end="2019-01-01",
                           valid_start="2018-01-01", valid_end="2017-01-01",
                           test_start="2016-01-01", test_end="2015-01-01"))
    assert len(exc.value.errors) == 4
    assert {e["code"] for e in exc.value.errors} == {"window_order"}


def test_a_malformed_draft_reports_every_field_at_once():
    with pytest.raises(DraftError) as exc:
        lower_draft({"name": "", "topk": "many", "assumed": "nope"})
    assert {e["code"] for e in exc.value.errors} == {"draft_shape"}
    assert {e["path"] for e in exc.value.errors} == {"name", "topk", "assumed"}


def test_an_unknown_field_is_refused_rather_than_ignored():
    with pytest.raises(DraftError) as exc:
        lower_draft(_draft(sharpe_target=2.0))
    assert exc.value.errors[0]["path"] == "sharpe_target"


def test_out_of_range_values_are_reported_in_draft_coordinates():
    """`topk` is bounded on the spec, not in the schema -- strict mode cannot
    carry `maximum` -- so the bound has to survive lowering."""
    with pytest.raises(DraftError) as exc:
        lower_draft(_draft(topk=9999))
    assert exc.value.errors[0]["code"] == "spec_shape"
    assert exc.value.errors[0]["path"] == "topk"


# --------------------------------------------------------------------------
# What comes out is what would run
# --------------------------------------------------------------------------
def test_config_equals_build_workflow_config_of_the_spec():
    lowered = lower_draft(_draft(topk=30))
    store = marketdata.store_for(lowered.spec.data_store)
    assert lowered.config == build_workflow_config(
        lowered.spec, store["provider_uri"], store["region"])


def test_the_yaml_is_the_config():
    import yaml as pyyaml
    lowered = lower_draft(_draft())
    assert pyyaml.safe_load(lowered.yaml) == lowered.config


def test_lowering_is_deterministic():
    a, b = lower_draft(_draft(topk=30)), lower_draft(_draft(topk=30))
    assert a.spec == b.spec and a.config == b.config and a.yaml == b.yaml
    assert a.assumed == b.assumed


def test_limit_threshold_warns_without_blocking():
    lowered = lower_draft(_draft(limit_threshold=0.095))
    assert lowered.warnings and "limit_threshold" in lowered.warnings[0]
    assert lowered.spec.limit_threshold == 0.095


def test_a_clean_draft_warns_about_nothing():
    assert lower_draft(_draft()).warnings == []


# --------------------------------------------------------------------------
# The dependency runs one way
# --------------------------------------------------------------------------
def test_draft_imports_no_llm_client():
    """Phase 1 is the deterministic floor. It stays testable offline only for as
    long as importing it cannot reach a client."""
    result = import_check("webapp.api.strategy_gen.draft", "openai")
    assert result.returncode == 0, result.stderr


def test_strategies_does_not_import_strategy_gen():
    """`strategies` is on the run path. Generation must be absent from a process
    that only runs backtests."""
    result = import_check("webapp.api.strategies", "webapp.api.strategy_gen")
    assert result.returncode == 0, result.stderr


# --------------------------------------------------------------------------
# The endpoint
# --------------------------------------------------------------------------
def test_from_draft_returns_spec_yaml_and_assumed():
    client = TestClient(app)
    response = client.post("/api/strategies/from-draft",
                           json={"name": "RSI test", "topk": 30})
    assert response.status_code == 200
    body = response.json()

    assert body["spec"]["topk"] == 30
    assert body["yaml"].startswith("qlib_init:")
    paths = {a["path"] for a in body["assumed"]}
    assert "topk" not in paths, "a stated value is not an assumption"
    assert {"model", "handler", "universe", "benchmark", "account"} <= paths
    assert all(a["why"] for a in body["assumed"])


def test_from_draft_422_carries_the_full_error_list():
    client = TestClient(app)
    response = client.post("/api/strategies/from-draft",
                           json={"name": "x", "universe": "top1000",
                                 "valid_start": "2009-01-01"})
    assert response.status_code == 422
    errors = response.json()["detail"]["errors"]
    assert {e["code"] for e in errors} == {"unknown_universe", "window_order"}
    assert all("path" in e for e in errors)


def test_from_draft_neither_stores_nor_runs_anything():
    """Lowering is not launching."""
    client = TestClient(app)
    before = client.get("/api/strategies").json()["strategies"]
    client.post("/api/strategies/from-draft", json={"name": "ephemeral"})
    assert client.get("/api/strategies").json()["strategies"] == before
    assert client.get("/api/runs").json()["runs"] == \
        client.get("/api/runs").json()["runs"]


def test_models_endpoint_survives_the_extraction():
    """`available_models` moved out of the router; the answer must not have."""
    from webapp.api.strategies import available_models

    body = TestClient(app).get("/api/models").json()
    assert body["models"] == available_models()
    assert body["handlers"] == list(HANDLERS)
