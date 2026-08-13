"""Specs that run to exit 0 and mean nothing, and reports that say so.

The pair exists because of one real run. A backtest named "ETH Breakout" was
launched against `crypto` -- the store's whole ~1,900-ticker instrument list, not
ETH -- holding the single highest-scoring coin each day with nothing capping a
daily move. qlib ran it, exited 0, and reported an annualised excess return of
75,327 (7.5 million percent) off a single day that returned +23,149,206%.

Nothing anywhere objected. `validate_windows` had no opinion, the runner saw exit
0, and the ledger printed the number. These two layers are the objection:
`validate_execution` before the run, `_sanity` after it.

The store-dependent branch is monkeypatched rather than read off this machine, so
the assertions are about the rule and not about which instrument files happen to
be built here.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from webapp.api import strategies as S
from webapp.api.main import app
from webapp.api.results import _sanity
from webapp.api.strategies import StrategySpec

pytestmark = pytest.mark.usefixtures("fake_stores")

client = TestClient(app)


#: The run that prompted all of this, as it was actually launched.
ETH_BREAKOUT = dict(
    name="ETH Breakout",
    data_store="crypto_365",
    universe="crypto",
    benchmark="BTC-USD",
    topk=1,
    n_drop=0,
    features=[{"name": "DON_HI20", "expression": "Ref($close,20)/$close - 1"}],
    feature_mode="replace",
)

#: Its risk block, verbatim from `port_analysis_1day.pkl`.
ETH_EXCESS = {
    "annualized_return": 75327.527354,
    "information_ratio": 0.571135,
    "max_drawdown": -3.762962,
    "std": 8549.226193,
}


@pytest.fixture
def curated(monkeypatch):
    """A crypto store carrying both the full list and a curated one."""
    monkeypatch.setattr(S, "store_for", lambda key: (
        {"universes": ["crypto", "crypto_top100", "all"]}
        if key.startswith("crypto") else {"universes": ["top500", "all"]}))
    monkeypatch.setattr(S, "store_symbols", lambda store, universe: (
        ["x"] * 1913 if universe == "crypto" else ["x"] * 100))


def test_the_eth_breakout_spec_is_objected_to_on_all_three_counts(curated):
    problems = StrategySpec(**ETH_BREAKOUT).validate_execution()
    assert len(problems) == 3
    assert problems[0].startswith("Universe 'crypto' is 1913 names")
    assert "crypto_top100" in problems[0]
    assert problems[1].startswith("Holding one name")
    assert problems[2].startswith("Nothing caps a daily move")


def test_the_corrected_spec_is_silent(curated):
    """The guards have to be quiet on a reasonable spec, or they are noise."""
    fixed = StrategySpec(**{**ETH_BREAKOUT, "universe": "crypto_top100",
                            "topk": 20, "n_drop": 5, "limit_threshold": 0.5})
    assert fixed.validate_execution() == []


def test_an_ordinary_us_spec_is_silent(curated):
    assert StrategySpec(name="Broad baseline").validate_execution() == []


def test_a_universe_with_no_curated_sibling_is_not_second_guessed(curated):
    """`top500` has no `top500_top100`, so there is nothing to suggest."""
    spec = StrategySpec(name="x", universe="top500")
    assert not [p for p in spec.validate_execution() if p.startswith("Universe")]


def test_n_drop_is_only_mentioned_when_it_makes_the_bet_permanent(curated):
    """topk 1 is a bet either way; n_drop 0 is what stops it being revisited."""
    stuck = StrategySpec(name="x", topk=1, n_drop=0).validate_execution()
    assert any("never rotates out" in p for p in stuck)
    rotating = StrategySpec(name="x", topk=1, n_drop=1).validate_execution()
    assert any(p.startswith("Holding one name") for p in rotating)
    assert not any("never rotates out" in p for p in rotating)


def test_the_fill_guard_warning_is_about_the_store_not_the_universe(curated):
    """A crypto store with no limit_threshold, however tidy the rest of the spec."""
    spec = StrategySpec(name="x", data_store="crypto_365",
                        universe="crypto_top100", benchmark="BTC-USD", topk=20)
    assert [p for p in spec.validate_execution()
            if p.startswith("Nothing caps a daily move")]

    guarded = spec.model_copy(update={"limit_threshold": 0.5})
    assert guarded.validate_execution() == []

    # US equities are the case the field's own docstring is about: a price limit
    # there would block ordinary moves, so its absence is not a warning.
    assert StrategySpec(name="x", topk=20).validate_execution() == []


def test_execution_warnings_reach_the_preview_without_blocking_it(curated):
    """The load-bearing separation, at the layer where it could be got wrong.

    Three routes validate a spec before acting and *raise* on what
    `validate_windows` and `validate_features` return. `validate_execution` is
    deliberately absent from all three: a one-name bet on an unfiltered universe
    is a legitimate thing to ask a backtest for, and refusing it would be wrong.
    So it appears in the one place that reports rather than refuses -- from which
    the canvas routes it to a stage badge.
    """
    response = client.post("/api/strategies/preview", json=ETH_BREAKOUT)
    assert response.status_code == 200, response.text

    warnings = response.json()["warnings"]
    assert any(w.startswith("Universe 'crypto' is") for w in warnings)
    assert any(w.startswith("Holding one name") for w in warnings)
    assert any(w.startswith("Nothing caps a daily move") for w in warnings)


class TestSanity:
    def test_the_eth_breakout_numbers_are_refused(self):
        verdict = _sanity(ETH_EXCESS)
        assert verdict["implausible"] is True
        # Return first: it is the number on the card, and the one a reader is
        # looking at when they decide the run was good.
        assert verdict["reasons"][0].startswith("An annualised excess return of")
        assert "7,532,753%" in verdict["reasons"][0]
        assert len(verdict["reasons"]) == 3

    def test_a_real_result_passes(self):
        assert _sanity({"annualized_return": 0.124, "information_ratio": 0.87,
                        "max_drawdown": -0.31, "std": 0.18}) == {
            "implausible": False, "reasons": []}

    def test_a_bad_but_believable_result_passes(self):
        """Losing money is not implausible. These thresholds are not a quality bar."""
        verdict = _sanity({"annualized_return": -0.62, "information_ratio": -1.4,
                           "max_drawdown": -0.88, "std": 0.9})
        assert verdict["implausible"] is False

    def test_nothing_recorded_is_not_implausible(self):
        """Absent is not wrong. `_clean` already turned NaN and inf into None,
        and an empty risk block means the report had nothing to judge."""
        assert _sanity({})["implausible"] is False
        assert _sanity({"annualized_return": None, "max_drawdown": None,
                        "std": None})["implausible"] is False

    def test_a_drawdown_worse_than_the_whole_account_is_refused(self):
        assert _sanity({"max_drawdown": -1.4})["implausible"] is True
        # -100% exactly is survivable arithmetic, and the boundary is not a fault.
        assert _sanity({"max_drawdown": -1.0})["implausible"] is False

    def test_each_reason_names_the_fault_and_not_the_threshold(self):
        for reason in _sanity(ETH_EXCESS)["reasons"]:
            assert "_MAX" not in reason
            assert "threshold" not in reason.lower()


class TestSnapshotFallback:
    """Metrics survive `examples/mlruns` being cleared.

    Until now that directory was the only copy: `run.json` held no metrics, every
    render re-read MLflow, and deleting it turned every historical run's numbers
    into em dashes with nothing to fall back on. `RunManager.delete` already
    refuses to touch `mlruns` for the mirror-image reason.

    Exercised by monkeypatching `build_report` to None rather than by moving a
    real directory, so the test says what it means and does not depend on this
    machine's store.
    """

    SNAPSHOT = {
        "risk": {"excess_return_with_cost": {"annualized_return": 0.117,
                                             "information_ratio": 0.83,
                                             "max_drawdown": -0.28}},
        "metrics": {"IC": 0.031},
        "sanity": {"implausible": False, "reasons": []},
        "period": {"start": "2024-01-01", "end": "2025-12-31", "days": 500},
        "indicators": {},
        "captured_at": "2026-08-12T13:03:45+00:00",
    }

    @pytest.fixture
    def unreadable_mlruns(self, monkeypatch):
        from webapp.api.routers import runs as R

        monkeypatch.setattr(R.results, "build_report", lambda name: None)
        monkeypatch.setattr(R.qlib_session, "require_qlib", lambda: None)
        return R

    def _run(self, meta_extra: dict):
        class FakeRun:
            meta = {"id": "abc123", "status": "succeeded",
                    "experiment_name": "aion-abc123", **meta_extra}
        return FakeRun()

    def test_the_snapshot_is_served_when_mlflow_cannot_be_read(
            self, unreadable_mlruns, monkeypatch):
        R = unreadable_mlruns
        monkeypatch.setattr(R._runs, "get",
                            lambda principal, rid: self._run({"metrics": self.SNAPSHOT}))

        report = R.run_report("abc123")
        assert report["from_snapshot"] is True
        assert report["risk"]["excess_return_with_cost"]["annualized_return"] == 0.117
        assert report["sanity"] == {"implausible": False, "reasons": []}
        assert report["period"]["days"] == 500
        # The curves are large and re-derivable, so they are not snapshotted. A
        # cleared mlruns costs a chart, not every number the run reported.
        assert report["curves"] == {}

    def test_a_run_with_no_snapshot_still_404s(self, unreadable_mlruns, monkeypatch):
        """Runs that finished before snapshots existed. Absent is not invented."""
        from fastapi import HTTPException

        R = unreadable_mlruns
        monkeypatch.setattr(R._runs, "get", lambda principal, rid: self._run({}))

        with pytest.raises(HTTPException) as raised:
            R.run_report("abc123")
        assert raised.value.status_code == 404

    def test_live_mlflow_wins_when_it_is_readable(self, monkeypatch):
        """The snapshot is a fallback, not a cache: live carries the curves."""
        from webapp.api.routers import runs as R

        live = {"risk": {"excess_return_with_cost": {"annualized_return": 0.99}},
                "metrics": {}, "curves": {"strategy": [{"t": "2024-01-01", "value": 0.0}]}}
        monkeypatch.setattr(R.results, "build_report", lambda name: dict(live))
        monkeypatch.setattr(R.qlib_session, "require_qlib", lambda: None)
        monkeypatch.setattr(R._runs, "get",
                            lambda principal, rid: self._run({"metrics": self.SNAPSHOT}))

        report = R.run_report("abc123")
        assert report.get("from_snapshot") is None
        assert report["risk"]["excess_return_with_cost"]["annualized_return"] == 0.99
        assert report["curves"]["strategy"]
