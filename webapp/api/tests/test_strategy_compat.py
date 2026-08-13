"""The one pipeline, and the run it would have saved.

``webapp/data/runs/e59f918b7ff5`` is the reason this module exists: a spec with
``data_store: crypto_365`` and ``benchmark: SPY``, accepted by ``POST /runs``,
which trained a model for four minutes fifty-one seconds and then died in
qlib's ``Account`` with "The benchmark ['SPY'] does not exist". The check that
catches it had been written already -- it lived on the draft pipeline, which
that endpoint did not call.

So the load-bearing test here is `test_the_benchmark_that_burned_five_minutes`.
Everything else guards the two ways the fix could rot: `warnings` quietly
changing meaning, and a defect naming a field that does not exist.
"""
from __future__ import annotations

import types

import pytest
from fastapi.testclient import TestClient

from webapp.api import marketdata
from webapp.api.main import app
from webapp.api.routers import runs as runs_router
from webapp.api.strategies import StrategySpec
from webapp.api.strategy_gen import compat

pytestmark = pytest.mark.usefixtures("fake_stores")

client = TestClient(app)

SAFE_END = "2026-07-31"

#: The failed run's spec, as far as it matters. `crypto_365` holds BTC-USD and
#: ETH-USD; SPY is in the other store.
BURNED = {"name": "Crypto momentum", "data_store": "crypto_365",
          "universe": "crypto_top100", "benchmark": "SPY",
          "test_end": "2026-07-31"}


@pytest.fixture(autouse=True)
def pinned_calendar(monkeypatch):
    """Both names the clamp is read through -- `strategies` holds its own binding."""
    for target in ("webapp.api.marketdata.store_calendar_end",
                   "webapp.api.strategies.store_calendar_end"):
        monkeypatch.setattr(target, lambda key, buffer_sessions=5: SAFE_END)


@pytest.fixture
def no_subprocess(monkeypatch):
    """Let a run be accepted without one actually starting."""
    started: list[dict] = []

    # `principal` is positional now: a run is owned by whoever asked for it.
    def fake_start(principal, **kwargs):
        started.append(kwargs)
        return types.SimpleNamespace(meta={"id": "fake", "status": "queued"})

    monkeypatch.setattr(runs_router._runs, "start", fake_start)
    return started


# --------------------------------------------------------------------------
# The one that matters
# --------------------------------------------------------------------------
def test_the_benchmark_that_burned_five_minutes_is_refused_before_anything_runs(
        no_subprocess):
    """`POST /runs` used to run two of the four checks, and skipped this one."""
    response = client.post("/api/runs", json={"spec": BURNED})

    assert response.status_code == 400, response.text
    assert "SPY" in response.json()["detail"]
    assert "crypto_365" in response.json()["detail"]
    assert no_subprocess == [], "nothing may be launched for a refused spec"


def test_the_same_spec_runs_once_the_benchmark_is_one_the_store_holds(no_subprocess):
    """The refusal has to be about the benchmark, not about crypto in general."""
    ok = {**BURNED, "benchmark": "BTC-USD", "limit_threshold": 0.5}
    response = client.post("/api/runs", json={"spec": ok})

    assert response.status_code == 200, response.text
    assert len(no_subprocess) == 1


def test_an_unknown_universe_is_refused_too(no_subprocess):
    response = client.post("/api/runs", json={"spec": {**BURNED, "benchmark": "BTC-USD",
                                                       "universe": "top500"}})
    assert response.status_code == 400, response.text
    assert "top500" in response.json()["detail"]


def test_an_advisory_defect_does_not_block_a_run(no_subprocess):
    """A one-name book on an unguarded store is a legitimate thing to ask for.

    It is also exactly the shape of spec that made metrics look enormous and
    mean nothing, so it must still be *reported* -- see the preview assertions.
    """
    thin = {**BURNED, "benchmark": "BTC-USD", "universe": "crypto", "topk": 1,
            "n_drop": 0}
    response = client.post("/api/runs", json={"spec": thin})

    assert response.status_code == 200, response.text
    assert len(no_subprocess) == 1

    defects = client.post("/api/strategies/preview", json=thin).json()["defects"]
    assert {d["code"] for d in defects} >= {"broad_universe", "thin_book",
                                            "no_price_limit"}
    assert all(d["severity"] == "advisory" for d in defects
               if d["code"] in {"broad_universe", "thin_book", "no_price_limit"})


# --------------------------------------------------------------------------
# The wire
# --------------------------------------------------------------------------
def test_preview_warnings_still_mean_what_they_meant():
    """`warnings` predates `defects` and something still reads it.

    It is now derived by subtracting the resolution codes from one `check_spec`
    pass rather than by re-running three checks, which is a change of mechanism
    and must not be a change of content.
    """
    body = {**BURNED, "benchmark": "BTC-USD", "universe": "crypto", "topk": 1}
    spec = StrategySpec(**body)
    provider_uri, _ = marketdata.resolve_store(spec.data_store)

    served = client.post("/api/strategies/preview", json=body).json()["warnings"]
    assert served == (spec.validate_windows()
                      + spec.validate_features(provider_uri)
                      + spec.validate_execution())


def test_the_unknown_benchmark_reaches_defects_but_not_warnings():
    """The whole point of the new field: news the old one cannot carry."""
    served = client.post("/api/strategies/preview", json=BURNED).json()

    assert [d for d in served["defects"] if d["code"] == "unknown_benchmark"]
    assert not [w for w in served["warnings"] if "SPY" in w]


def test_every_defect_path_names_a_real_spec_field():
    """A path the builder cannot resolve is a message that lands nowhere.

    The same guard `stages.test.ts` applies to the stage `owns` map, from the
    other end. `features[2].name` counts: the field is the leading segment.
    """
    messy = {**BURNED, "topk": 1, "universe": "crypto", "valid_start": "2009-01-01",
             "features": [{"name": "MA5", "expression": "Ref($close,-3)"}]}
    defects = client.post("/api/strategies/preview", json=messy).json()["defects"]

    assert defects, "this spec is wrong in several ways; say so"
    for defect in defects:
        field = defect["path"].split(".")[0].split("[")[0]
        assert field in StrategySpec.model_fields, f"{defect['path']} is not a field"
        assert defect["severity"] in ("blocking", "advisory")


def test_preview_carries_options_for_every_choosable_field():
    served = client.post("/api/strategies/preview", json=BURNED).json()
    assert set(served["options"]) >= {"model", "handler", "data_store", "universe",
                                      "benchmark", "feature_mode", "topk", "test_end"}


# --------------------------------------------------------------------------
# Options
# --------------------------------------------------------------------------
def options(field: str, **kw) -> dict:
    spec = StrategySpec(**{"name": "Options", **kw})
    return compat.field_options(spec)[field]


def test_spy_is_offered_on_the_crypto_store_but_disabled_with_a_way_out():
    """Not filtered out: an option you can see and cannot pick teaches the rule.

    And the reason alone is only half of it -- "SPY is not in this store" is a
    fact, "switch to the us store" is what the reader wanted to know.
    """
    field = options("benchmark", data_store="crypto_365",
                    universe="crypto_top100", benchmark="SPY")
    spy = next(o for o in field["options"] if o["value"] == "SPY")

    assert spy["enabled"] is False
    assert "crypto_365" in spy["reason"]
    assert spy["fix"] == {"path": "data_store", "value": "us",
                          "label": "Switch to the us store"}


def test_a_store_with_no_benchmark_list_still_offers_real_symbols():
    """`crypto_365` ships no benchmarks.txt.

    A membership rule with nothing to match against would disable every option
    and make the store unbuildable, which is worse than the bug it fixes. The
    fallback is the store's smallest curated universe, and the note says the
    offer is narrower than the truth.
    """
    field = options("benchmark", data_store="crypto_365",
                    universe="crypto_top100", benchmark="BTC-USD")

    assert [o["value"] for o in field["options"] if o["enabled"]] == ["BTC-USD",
                                                                     "ETH-USD"]
    assert "no benchmark list" in field["note"]


def test_a_colliding_column_disables_the_handler_that_owns_it():
    """`MA5` is Alpha158's. Extending would replace it and log nothing.

    Which names collide depends on the handler, so this is genuinely a question
    between two fields rather than a property of either -- and it is why the
    handler list cannot be a static enum.
    """
    field = options("handler", handler="Alpha360",
                    features=[{"name": "MA5", "expression": "$close"}])
    by_value = {o["value"]: o for o in field["options"]}

    assert by_value["Alpha360"]["enabled"] is True
    assert by_value["Alpha158"]["enabled"] is False
    assert "`MA5`" in by_value["Alpha158"]["reason"]
    assert by_value["Alpha158"]["fix"]["path"] == "feature_mode"


def test_the_same_column_collides_with_neither_handler_under_replace():
    """Replace loads none of the handler's own columns, so nothing can clash."""
    field = options("handler", handler="Alpha360", feature_mode="replace",
                    features=[{"name": "MA5", "expression": "$close"}])
    assert all(o["enabled"] for o in field["options"])


def test_replace_is_disabled_until_there_is_something_to_replace_with():
    without = options("feature_mode")
    assert next(o for o in without["options"]
                if o["value"] == "replace")["enabled"] is False

    with_columns = options("feature_mode",
                           features=[{"name": "MOM", "expression": "$close"}])
    assert all(o["enabled"] for o in with_columns["options"])


def test_an_unbuilt_store_is_offered_and_disabled(fake_stores):
    fake_stores[1]["exists"] = False
    field = options("data_store")
    crypto = next(o for o in field["options"] if o["value"] == "crypto_365")

    assert crypto["enabled"] is False
    assert "Not built" in crypto["reason"]


def test_a_model_without_its_backend_is_offered_and_disabled(monkeypatch):
    monkeypatch.setattr(compat, "available_models",
                        lambda: [{"id": "lightgbm", "label": "LightGBM",
                                  "class": "LGBModel"}])
    by_value = {o["value"]: o for o in options("model")["options"]}

    assert by_value["lightgbm"]["enabled"] is True
    assert by_value["xgboost"]["enabled"] is False
    assert "not installed" in by_value["xgboost"]["reason"]


def test_bounds_are_read_off_the_model_rather_than_retyped():
    """`PortfolioInspector` hardcodes 1-500 and 0-100 to mirror pydantic.

    Two copies of a bound is how a form comes to accept a value the model then
    422s, so the form is told instead of guessing.
    """
    assert options("topk")["bounds"] == {"min": 1, "max": 500}
    assert options("n_drop")["bounds"] == {"min": 0, "max": 100}
    assert options("account")["bounds"] == {"exclusive_min": 0}


def test_test_end_carries_the_calendar_ceiling_as_a_bound():
    field = options("test_end")
    assert field["bounds"] == {"max": SAFE_END}
    assert SAFE_END in field["note"]


# --------------------------------------------------------------------------
# Import
# --------------------------------------------------------------------------
FILE = """
name: Broad baseline
model: lightgbm
handler: Alpha158
data_store: us
universe: top500
benchmark: SPY
train_start: '2010-01-04'
train_end: '2019-12-31'
valid_start: '2020-01-01'
valid_end: '2021-12-31'
test_start: '2022-01-01'
test_end: '2026-07-31'
topk: 50
features:
- name: MOM5
  expression: Ref($close,5)/$close - 1
feature_mode: extend
id: demo-baseline
created_at: '2026-08-10T15:12:08.390792+00:00'
"""


def imported(text: str, expect: int = 200) -> dict:
    response = client.post("/api/strategies/import", json={"text": text})
    assert response.status_code == expect, response.text
    return response.json()


def test_a_strategy_file_round_trips_into_a_spec():
    body = imported(FILE)

    assert body["spec"]["name"] == "Broad baseline"
    assert body["spec"]["universe"] == "top500"
    assert body["spec"]["features"] == [{"name": "MOM5",
                                         "expression": "Ref($close,5)/$close - 1"}]
    assert body["rejected"] == []
    assert not [d for d in body["defects"] if d["severity"] == "blocking"]


def test_an_imported_file_loses_its_identity():
    """It becomes an unsaved draft. Keeping the id would make the next Save
    overwrite whatever that id points at now."""
    body = imported(FILE)
    assert "id" not in body["spec"]
    assert "created_at" not in body["spec"]
    assert body["unknown_fields"] == []


def test_json_is_accepted_because_json_is_yaml():
    body = imported('{"name": "From JSON", "topk": 7}')
    assert body["spec"]["name"] == "From JSON"
    assert body["spec"]["topk"] == 7


def test_a_field_that_will_not_hold_is_dropped_and_named_rather_than_fatal():
    """Refusing the whole file over one bad field is how people end up editing
    YAML by hand. Nothing is silently corrected: the refused value comes back."""
    body = imported(FILE.replace("topk: 50", "topk: 9999"))

    assert body["spec"]["name"] == "Broad baseline", "the rest survived"
    assert body["spec"]["topk"] == StrategySpec.model_fields["topk"].default
    assert [r["path"] for r in body["rejected"]] == ["topk"]
    assert body["rejected"][0]["value"] == 9999


def test_a_key_that_is_not_part_of_a_strategy_is_reported_not_swallowed():
    body = imported(FILE + "\nsharpe_target: 2.0\n")
    assert body["unknown_fields"] == ["sharpe_target"]


def test_an_incompatible_file_loads_and_is_quarantined_rather_than_refused():
    """The chosen import behaviour: load as-is, mark the field, offer the ways out."""
    body = imported(FILE.replace("data_store: us", "data_store: crypto_365")
                        .replace("universe: top500", "universe: crypto_top100"))

    assert body["spec"]["benchmark"] == "SPY", "not silently rewritten"
    quarantined = [d for d in body["defects"] if d["severity"] == "blocking"]
    assert [d["path"] for d in quarantined] == ["benchmark"]

    spy = next(o for o in body["options"]["benchmark"]["options"]
               if o["value"] == "SPY")
    assert spy["enabled"] is False and spy["fix"]["value"] == "us"


def test_a_file_that_is_not_a_mapping_is_refused():
    assert "mapping" in imported("- one\n- two", expect=400)["detail"]


def test_a_file_that_is_not_yaml_at_all_is_refused():
    imported("name: [unclosed", expect=400)
