"""Queueing, progress reporting and failure diagnosis.

None of this is about whether a backtest is correct — it is about what the
person waiting for one is told while they wait, and what they are told when it
does not work.
"""
from __future__ import annotations

import re
import threading
import time

import pytest

from webapp.api import runner
from webapp.api.runner import RunManager, _diagnose, _phase_advances, _phase_for


@pytest.fixture
def manager(tmp_path):
    return RunManager(tmp_path / "runs", tmp_path, venv_python=tmp_path / "python")


class TestQueue:
    """`queued` used to be written and ignored in the same breath."""

    def test_a_second_run_waits_for_the_first(self, manager, monkeypatch):
        started = threading.Event()
        release = threading.Event()
        concurrent = []
        live = 0
        guard = threading.Lock()

        def fake_subprocess(run):
            nonlocal live
            with guard:
                live += 1
                concurrent.append(live)
            started.set()
            release.wait(timeout=5)
            with guard:
                live -= 1

        monkeypatch.setattr(RunManager, "_run_subprocess",
                            lambda self, run: fake_subprocess(run))

        first = manager.start(name="first", config={})
        assert started.wait(timeout=5)
        second = manager.start(name="second", config={})

        # The second must not be running while the first holds the slot.
        time.sleep(0.2)
        assert manager.get(second.id).meta["status"] == "queued"
        assert manager.get(second.id).meta["phase"] == "Waiting for the running backtest"

        release.set()
        time.sleep(0.5)
        assert max(concurrent) == 1, f"ran {max(concurrent)} backtests at once"
        assert first.id != second.id

    def test_cancelling_while_queued_never_starts_the_subprocess(self, manager, monkeypatch):
        started = threading.Event()
        release = threading.Event()
        ran = []

        def fake_subprocess(self, run):
            ran.append(run.id)
            started.set()
            release.wait(timeout=5)

        monkeypatch.setattr(RunManager, "_run_subprocess", fake_subprocess)

        manager.start(name="first", config={})
        assert started.wait(timeout=5)
        second = manager.start(name="second", config={})
        time.sleep(0.2)

        assert manager.cancel(second.id) is True
        release.set()
        time.sleep(0.5)

        assert second.id not in ran, "a cancelled run still started"
        assert manager.get(second.id).meta["status"] == "cancelled"


class TestPhase:
    """The phase word is the only progress signal a waiting user gets."""

    def test_a_line_naming_two_stages_resolves_to_the_later_one(self):
        # qrun logs backtest segment names; under first-match-wins the `train\b`
        # pattern claimed this line and progress jumped backwards.
        assert _phase_for("backtest loop over train segment") == "Running backtest"

    def test_progress_only_moves_forwards(self):
        assert _phase_advances("Loading data", "Training model") is True
        assert _phase_advances("Running backtest", "Training model") is False
        assert _phase_advances("Training model", "Training model") is False

    def test_starting_ranks_below_everything(self):
        """`Starting` and the queue phases are not in the table."""
        assert _phase_advances("Starting", "Loading data") is True
        assert _phase_advances(None, "Loading data") is True
        assert _phase_advances("Waiting for the running backtest", "Loading data") is True

    def test_every_pattern_is_reachable(self):
        """A phase nothing can match would be a silent gap in the sequence."""
        for pattern, phase in runner._PHASE_PATTERNS:
            assert _phase_for(pattern.pattern.split("|")[0].replace(r"\b", "")) is not None, phase


class TestDiagnosis:
    """The codebase already understood these; only the comments did."""

    @pytest.mark.parametrize("needle", [
        "Empty data from dataset, please check your dataset config",
        "ImportError: cannot import name 'GRU'",
        "IndexError: index 4174 is out of bounds for axis 0 with size 4174",
        "MemoryError",
    ])
    def test_known_failures_get_a_sentence(self, needle):
        message = _diagnose(f"Traceback (most recent call last):\n  {needle}\n")
        assert message and not message.startswith("Traceback")
        # A sentence, not a pattern dump.
        assert message[0].isupper() and message.rstrip().endswith(".")

    def test_an_unknown_failure_falls_through(self):
        assert _diagnose("Traceback: something nobody has seen before") is None

    def test_a_linear_model_refusing_a_non_finite_value_gets_a_sentence(self):
        """Taken verbatim from a real sweep — scipy's wording, not ours.

        A model sweep runs `linear` beside `lightgbm` as its first comparison,
        so this is the failure it produces most, and without an entry here the
        user is handed twelve frames of scipy internals.
        """
        message = _diagnose(
            "  File \"scipy/_lib/_util.py\", line 468, in _asarray_validated\n"
            "ValueError: array must not contain infs or NaNs\n")
        assert message
        assert "tree" in message, "the reader needs to know what to do instead"

    def test_sklearns_own_wording_for_the_same_failure_is_recognised(self):
        assert _diagnose("ValueError: Input X contains NaN.") is not None
        assert _diagnose("ValueError: Input contains infinity or a value too "
                         "large for dtype('float64').") is not None

    def test_the_empty_dataset_message_names_the_actual_cause(self):
        message = _diagnose("ValueError: Empty data from dataset")
        assert "all-NaN" in message or "empty column" in message

    def test_patterns_are_case_insensitive(self):
        assert _diagnose("empty data FROM DATASET") is not None

    def test_first_match_wins_so_specific_beats_generic(self):
        """An ImportError inside a run that also mentions memory stays an ImportError."""
        order = [p.pattern for p, _ in runner._DIAGNOSES]
        assert order.index(r"Empty data from dataset") < len(order) - 1
        assert re.search(r"MemoryError", order[-1])
