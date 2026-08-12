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


class TestOrphanReconciliation:
    """A run.json left at `running` by a dead process must not stay `running`."""

    def _write_meta(self, runs_dir, run_id, status):
        import json

        directory = runs_dir / run_id
        directory.mkdir(parents=True)
        (directory / "run.json").write_text(json.dumps({
            "id": run_id, "name": "orphan", "kind": "backtest",
            "strategy_id": None, "status": status, "phase": "Training model",
            "created_at": "2026-08-11T00:00:00+00:00",
            "started_at": "2026-08-11T00:00:01+00:00", "finished_at": None,
            "exit_code": None, "error": None,
        }))

    def test_orphaned_running_run_is_failed_on_load(self, tmp_path):
        import json

        runs_dir = tmp_path / "runs"
        self._write_meta(runs_dir, "abc123", "running")
        manager = RunManager(runs_dir, tmp_path, venv_python=tmp_path / "python")

        rows = manager.list()
        assert len(rows) == 1
        assert rows[0]["status"] == "failed"
        assert "restart" in (rows[0]["error"] or "")
        assert rows[0]["finished_at"] is not None
        # The verdict is persisted, not just in-memory.
        on_disk = json.loads((runs_dir / "abc123" / "run.json").read_text())
        assert on_disk["status"] == "failed"

    def test_orphaned_queued_run_is_failed_too(self, tmp_path):
        runs_dir = tmp_path / "runs"
        self._write_meta(runs_dir, "def456", "queued")
        manager = RunManager(runs_dir, tmp_path, venv_python=tmp_path / "python")
        assert manager.get("def456").meta["status"] == "failed"

    def test_terminal_runs_load_untouched(self, tmp_path):
        runs_dir = tmp_path / "runs"
        self._write_meta(runs_dir, "aaa111", "succeeded")
        manager = RunManager(runs_dir, tmp_path, venv_python=tmp_path / "python")
        meta = manager.get("aaa111").meta
        assert meta["status"] == "succeeded"
        assert meta["error"] is None


class TestDelete:
    """Deleting a run removes its directory -- and refuses while it can still write."""

    def _write_meta(self, runs_dir, run_id, status):
        import json

        directory = runs_dir / run_id
        directory.mkdir(parents=True)
        (directory / "run.json").write_text(json.dumps({
            "id": run_id, "name": "done", "kind": "backtest",
            "strategy_id": None, "status": status, "phase": "Finished",
            "created_at": "2026-08-11T00:00:00+00:00",
            "started_at": "2026-08-11T00:00:01+00:00",
            "finished_at": "2026-08-11T00:05:00+00:00",
            "exit_code": 0, "error": None,
        }))
        (directory / "run.log").write_text("done\n")
        return directory

    def test_finished_run_is_removed(self, tmp_path):
        runs_dir = tmp_path / "runs"
        directory = self._write_meta(runs_dir, "aaa111", "succeeded")
        manager = RunManager(runs_dir, tmp_path, venv_python=tmp_path / "python")

        assert manager.delete("aaa111") is True
        assert not directory.exists()
        assert manager.get("aaa111") is None
        assert manager.list() == []

    def test_running_run_refuses(self, tmp_path):
        runs_dir = tmp_path / "runs"
        self._write_meta(runs_dir, "bbb222", "succeeded")
        manager = RunManager(runs_dir, tmp_path, venv_python=tmp_path / "python")
        # Reconciliation fails anything found on disk as running, so put it back
        # into flight in memory -- which is the state the endpoint must refuse.
        manager.get("bbb222").update(status="running")

        with pytest.raises(runner.RunBusy):
            manager.delete("bbb222")
        assert (runs_dir / "bbb222").exists()

    def test_missing_run_is_false_not_an_error(self, tmp_path):
        manager = RunManager(tmp_path / "runs", tmp_path, venv_python=tmp_path / "python")
        assert manager.delete("nosuchrun") is False

    def test_a_traversing_id_is_refused(self, tmp_path):
        """`get` validates the id, so `delete` can never rmtree outside runs_dir."""
        outside = tmp_path / "precious"
        outside.mkdir()
        manager = RunManager(tmp_path / "runs", tmp_path, venv_python=tmp_path / "python")

        assert manager.delete("../precious") is False
        assert outside.exists()
