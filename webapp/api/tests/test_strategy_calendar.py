"""The store's calendar bounds a backtest, and the report's curves are geometric.

Two conventions live here because both are load-bearing and neither is visible
in the output when it breaks. A backtest that ends one day too late raises an
IndexError only when a trade decision lands on the final bar -- so it fails
intermittently, on some strategies and not others, with an error that names
qlib internals. And a cumulative curve read as arithmetic instead of geometric
produces monthly returns that look plausible for one month and are badly wrong
over three years.
"""
from __future__ import annotations

import pandas as pd
import pytest

from webapp.api import marketdata
from webapp.api.strategies import StrategySpec, build_workflow_config

pytestmark = pytest.mark.usefixtures("fake_stores")

SAFE_END = "2026-07-31"
#: The store's true final bar — what a spec must never be handed to qrun with.
LAST_BAR = "2026-08-07"


@pytest.fixture
def calendar(monkeypatch):
    """A store whose last safely-backtestable day is known."""
    monkeypatch.setattr(marketdata, "store_calendar_end",
                        lambda key, buffer_sessions=5: SAFE_END)
    # `strategies` imported the name directly, so patching the module attribute
    # it read at import time is what actually takes effect.
    monkeypatch.setattr("webapp.api.strategies.store_calendar_end",
                        lambda key, buffer_sessions=5: SAFE_END)


def config_for(spec: StrategySpec) -> dict:
    return build_workflow_config(spec, "/tmp/store-us", "us")


def end_dates(config: dict) -> set[str]:
    """Every place an end date reaches qrun."""
    dataset = config["task"]["dataset"]["kwargs"]
    return {
        config["data_handler_config"]["end_time"],
        config["port_analysis_config"]["backtest"]["end_time"],
        dataset["handler"]["kwargs"]["end_time"],
        dataset["segments"]["test"][1],
    }


class TestCalendarClamp:
    def test_end_on_the_final_bar_is_pulled_back(self, calendar):
        spec = StrategySpec(name="t", test_end=LAST_BAR)
        assert end_dates(config_for(spec)) == {SAFE_END}

    def test_every_end_date_in_the_config_agrees(self, calendar):
        """One clamped spec, not four clamped call sites.

        `_custom_handler` never sees the store, so a per-site fix would have
        missed it and produced a config whose handler and backtest disagreed.
        """
        spec = StrategySpec(name="t", test_end=LAST_BAR,
                            features=[{"name": "F1", "expression": "$close"}])
        assert len(end_dates(config_for(spec))) == 1

    def test_an_earlier_end_is_left_alone(self, calendar):
        spec = StrategySpec(name="t", test_end="2024-06-30")
        assert end_dates(config_for(spec)) == {"2024-06-30"}

    def test_the_saved_spec_is_not_rewritten(self, calendar):
        """The user's declared intent survives; only what qrun gets is bounded."""
        spec = StrategySpec(name="t", test_end=LAST_BAR)
        config_for(spec)
        assert spec.test_end == LAST_BAR

    def test_an_unavailable_calendar_is_a_shrug(self, monkeypatch):
        monkeypatch.setattr("webapp.api.strategies.store_calendar_end",
                            lambda key, buffer_sessions=5: None)
        spec = StrategySpec(name="t", test_end=LAST_BAR)
        assert end_dates(config_for(spec)) == {LAST_BAR}

    def test_the_clamp_is_said_out_loud(self, calendar):
        spec = StrategySpec(name="t", test_end=LAST_BAR)
        problems = spec.validate_windows()
        assert any(SAFE_END in p and LAST_BAR in p for p in problems), problems

    def test_no_warning_when_nothing_is_clamped(self, calendar):
        spec = StrategySpec(name="t", test_end="2024-06-30")
        assert not [p for p in spec.validate_windows() if "safely backtest" in p]


class TestSafeEnd:
    """`_safe_end` leaves a buffer, because qlib reads `calendar[i + 1]`."""

    def test_leaves_the_buffer(self):
        days = [f"2026-01-{d:02d}" for d in range(1, 21)]
        assert marketdata._safe_end(days, buffer_sessions=5) == "2026-01-15"

    def test_short_calendar_clamps_rather_than_raising(self):
        assert marketdata._safe_end(["2026-01-01", "2026-01-02"], 5) == "2026-01-01"

    def test_empty_calendar_is_none(self):
        assert marketdata._safe_end([]) is None


class TestCurveConvention:
    """The frontend de-cumulates these; it must not have to guess how.

    `ui/src/lib/monthlyReturns.ts` computes a month as
    `(1 + c_end) / (1 + c_prev) - 1` because these curves are `cumprod`. If this
    ever becomes a `cumsum`, that de-cumulation silently starts lying and its
    own unit tests keep passing — so the convention is asserted here, at the
    source, as well as there.
    """

    def test_curves_are_geometric(self):
        from webapp.api.results import _series_points

        returns = pd.Series(
            [0.1, 0.1, 0.1],
            index=pd.to_datetime(["2026-01-31", "2026-02-28", "2026-03-31"]),
        )
        points = _series_points((1 + returns).cumprod() - 1)
        values = [p["value"] for p in points]

        # Geometric: 0.10, 0.21, 0.331. Arithmetic would give 0.10, 0.20, 0.30.
        assert values == pytest.approx([0.1, 0.21, 0.331], abs=1e-9)
        assert values[1] != pytest.approx(0.2, abs=1e-3)

    def test_build_report_uses_cumprod(self):
        """Guards the four `cumprod` call sites in `build_report` by source.

        A behavioural test would need a full MLflow recorder; what matters is
        only that nobody swaps the operator, so the operator is what is checked.
        """
        import inspect

        from webapp.api import results

        source = inspect.getsource(results.build_report)
        assert "cumsum" not in source
        assert source.count(".cumprod()") == 4


class TestPositionHistory:
    """position_history turns qlib's position snapshots into a chart API."""

    def test_multiindex_positions_are_normalised(self, monkeypatch):
        from webapp.api import results

        class FakeRecorder:
            def load_object(self, name: str):
                if name != "portfolio_analysis/positions_normal_1day.pkl":
                    raise FileNotFoundError(name)
                dates = pd.to_datetime(["2024-01-02", "2024-01-02", "2024-01-03", "2024-01-03"])
                instruments = ["A", "B", "A", "B"]
                return pd.DataFrame({
                    "weight": [0.5, 0.3, 0.4, 0.4],
                }, index=pd.MultiIndex.from_arrays([dates, instruments], names=["datetime", "instrument"]))

        monkeypatch.setattr(results, "find_recorder", lambda name: FakeRecorder())
        history = results.position_history("any")

        assert history is not None
        assert history["start"] == "2024-01-02"
        assert history["end"] == "2024-01-03"
        assert len(history["daily"]) == 2
        assert history["daily"][0]["position_count"] == 2
        assert history["daily"][0]["long_exposure"] == pytest.approx(0.8)
        assert history["daily"][0]["gross_exposure"] == pytest.approx(0.8)
        assert len(history["trades"]) == 4  # two opens, two adjustments
        opens = [t for t in history["trades"] if t["direction"] == "open"]
        assert len(opens) == 2
        assert history["latest"]["date"] == "2024-01-03"
        assert history["latest"]["top"][0]["instrument"] == "A"
        assert history["latest"]["top"][0]["weight"] == pytest.approx(0.4)

    def test_stacked_positions_are_normalised(self, monkeypatch):
        from webapp.api import results

        class FakeRecorder:
            def load_object(self, name: str):
                return pd.DataFrame({
                    "A": [0.5, 0.4],
                    "B": [0.3, 0.4],
                }, index=pd.to_datetime(["2024-01-02", "2024-01-03"]))

        monkeypatch.setattr(results, "find_recorder", lambda name: FakeRecorder())
        history = results.position_history("any")

        assert history is not None
        assert history["daily"][0]["position_count"] == 2
        assert history["daily"][0]["long_exposure"] == pytest.approx(0.8)

    def test_dict_of_position_objects_are_normalised(self, monkeypatch):
        from webapp.api import results

        class FakePosition:
            def __init__(self, weights):
                self.position = {k: {"weight": v} for k, v in weights.items()}

        class FakeRecorder:
            def load_object(self, name: str):
                return {
                    pd.Timestamp("2024-01-02"): FakePosition({"A": 0.5, "B": 0.3}),
                    pd.Timestamp("2024-01-03"): FakePosition({"A": 0.4, "B": 0.4}),
                }

        monkeypatch.setattr(results, "find_recorder", lambda name: FakeRecorder())
        history = results.position_history("any")

        assert history is not None
        assert history["daily"][0]["position_count"] == 2
        assert history["daily"][0]["long_exposure"] == pytest.approx(0.8)
        assert len(history["trades"]) == 4
