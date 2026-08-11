"""What the builder is told about a spec, beyond the YAML.

Three additions, and each closes a question the UI could not previously answer:

  the label          what is actually being predicted. Nowhere on screen before.
  the calendar       the range the target store covers, and where a run will
                     really stop once the end-date clamp applies.
  store membership   who is in `top500`, answered *per store* rather than
                     against whichever store this process happens to have
                     mounted.

The clamp assertion is the load-bearing one. `preview` reports an
`effective_test_end` and `build_workflow_config` applies the real clamp, and if
those two ever disagree the builder draws a promise the run does not keep. The
test compares them rather than restating the rule in a second place.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from webapp.api import strategy_explain
from webapp.api.main import app
from webapp.api.strategies import StrategySpec, build_workflow_config

pytestmark = pytest.mark.usefixtures("fake_stores")

client = TestClient(app)

SAFE_END = "2026-07-31"


@pytest.fixture
def clamped(monkeypatch):
    """Pin the safe end on both names the clamp is read through.

    `strategies` did `from .marketdata import store_calendar_end`, so it holds
    its own binding — patching only `marketdata` would leave the config
    unclamped while the preview reported a clamp, which is precisely the split
    `test_effective_test_end_agrees_with_the_config_the_run_gets` exists to
    catch. Same two-name patch as `test_strategy_calendar`.
    """
    for target in ("webapp.api.marketdata.store_calendar_end",
                   "webapp.api.strategies.store_calendar_end"):
        monkeypatch.setattr(target, lambda key, buffer_sessions=5: SAFE_END)


def preview(**kw) -> dict:
    body = {"name": "Explain", **kw}
    response = client.post("/api/strategies/preview", json=body)
    assert response.status_code == 200, response.text
    return response.json()


# --------------------------------------------------------------------------
# The label
# --------------------------------------------------------------------------

def test_the_label_is_read_out_of_qlib_with_both_numbers():
    """`Ref($close,-2)/Ref($close,-1)-1` is not a two-day return.

    It is the return from tomorrow's close to the next close: observed two days
    ahead, held for one session. The common shorthand collapses those into one
    number, and a builder that says "2-day return" states something the config
    does not do.
    """
    label = strategy_explain.label_summary("Alpha158")

    assert label is not None
    assert "Ref($close, -2)" in label["expression"]
    assert label["horizon_days"] == 2, "how far ahead the last observation sits"
    assert label["holding_days"] == 1, "how long the position is actually exposed"


def test_alpha360_shares_alpha158s_label():
    assert (strategy_explain.label_summary("Alpha360")
            == strategy_explain.label_summary("Alpha158"))


def test_an_unanswerable_label_is_none_rather_than_a_guess(monkeypatch):
    """A preview must render on a machine where qlib will not import.

    Returning a plausible default here would put a confident sentence about the
    prediction target under a spec nobody could verify.
    """
    import webapp.api.factorlab.indicators as indicators

    def boom(handler="Alpha158"):
        raise RuntimeError("qlib is not importable here")

    monkeypatch.setattr(indicators, "handler_label", boom)
    assert strategy_explain.label_summary("Alpha158") is None


def test_an_unknown_handler_does_not_raise():
    assert strategy_explain.label_summary("Alpha42") is None


def test_the_preview_carries_the_label():
    assert preview()["explain"]["label"]["horizon_days"] == 2


# --------------------------------------------------------------------------
# The calendar, and the clamp
# --------------------------------------------------------------------------

def test_the_preview_reports_the_stores_range(clamped):
    explain = preview()["explain"]
    assert explain["calendar_start"] == "2010-01-04"
    assert explain["calendar_end"] == SAFE_END


def test_effective_test_end_agrees_with_the_config_the_run_gets(clamped):
    """The whole point: what the builder draws is where the run stops.

    Compared against `build_workflow_config`, not against the clamp rule written
    out a second time — a restatement would keep passing while the two drifted.
    """
    spec = StrategySpec(name="Past the end", test_end="2026-12-31")
    config = build_workflow_config(spec, "/tmp/store-us", "us")

    explain = preview(test_end="2026-12-31")["explain"]

    assert explain["effective_test_end"] == SAFE_END
    assert explain["effective_test_end"] == config["data_handler_config"]["end_time"]
    assert (explain["effective_test_end"]
            == config["port_analysis_config"]["backtest"]["end_time"])


def test_a_test_end_inside_the_calendar_is_left_alone(clamped):
    explain = preview(test_end="2024-06-28")["explain"]
    assert explain["effective_test_end"] == "2024-06-28"


def test_the_clamp_is_also_said_in_words(clamped):
    """The banner and the timeline must not be the only place it appears.

    The sentence is what the Run button's tooltip shows, so it has to survive.
    """
    warnings = preview(test_end="2026-12-31")["warnings"]
    assert any(SAFE_END in w for w in warnings)


# --------------------------------------------------------------------------
# Store-scoped membership
# --------------------------------------------------------------------------

def test_a_universe_is_answered_for_the_store_that_was_asked_about():
    """`D.instruments` resolves against the *mounted* store, whatever was asked.

    So a crypto strategy asking about its own universe used to get the US
    store's copy — a different set of names, returned as the answer.
    """
    response = client.get("/api/instruments", params={"universe": "all", "store": "crypto_365"})
    assert response.status_code == 200

    symbols = {i["symbol"] for i in response.json()["instruments"]}
    assert symbols == {"BTC-USD", "ETH-USD"}
    assert "SPY" not in symbols, "that is the us store's answer"


def test_the_us_store_answers_for_itself():
    response = client.get("/api/instruments", params={"universe": "all", "store": "us"})
    assert "SPY" in {i["symbol"] for i in response.json()["instruments"]}


def test_a_universe_missing_from_the_named_store_is_a_404():
    response = client.get("/api/instruments",
                          params={"universe": "top500", "store": "crypto_365"})
    assert response.status_code == 404
    assert "crypto_365" in response.json()["detail"]


def test_search_still_filters_within_a_store_scoped_universe():
    response = client.get("/api/instruments",
                          params={"universe": "all", "store": "us", "search": "spy"})
    assert [i["symbol"] for i in response.json()["instruments"]] == ["SPY"]

    # Substring, not prefix: "sp" reaches GSPC too, and the picker's result
    # count has to mean the same thing the list shows.
    loose = client.get("/api/instruments",
                       params={"universe": "all", "store": "us", "search": "sp"}).json()
    assert [i["symbol"] for i in loose["instruments"]] == ["GSPC", "SPY"]
    assert loose["total"] == 2


# --------------------------------------------------------------------------
# The universes endpoint
# --------------------------------------------------------------------------

def test_every_universe_is_counted_and_sampled():
    body = client.get("/api/data-stores/us/universes").json()
    by_name = {u["name"]: u for u in body["universes"]}

    assert body["store"] == "us"
    assert by_name["all"]["count"] == 10
    assert "SPY" in by_name["all"]["sample"]
    # `benchmarks` is not offered as a universe to backtest against.
    assert "benchmarks" not in by_name


def test_the_sample_is_capped():
    body = client.get("/api/data-stores/us/universes", params={"sample": 2}).json()
    assert all(len(u["sample"]) <= 2 for u in body["universes"])


def test_a_universe_file_that_is_missing_reports_zero_rather_than_vanishing():
    """An empty universe is a real state, and the picker has to say so.

    Dropping the row would make a store that lost a file look like a store that
    never had it.
    """
    body = client.get("/api/data-stores/us/universes").json()
    by_name = {u["name"]: u for u in body["universes"]}
    assert by_name["macro50"]["count"] == 0
    assert by_name["macro50"]["sample"] == []


def test_an_unknown_store_is_a_404():
    assert client.get("/api/data-stores/nope/universes").status_code == 404
