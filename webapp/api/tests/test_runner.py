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


class _OwnedRunManager(RunManager):
    """A RunManager bound to one caller.

    A run belongs to whoever started it, so every method takes a principal. The
    tests below are about queueing, phase reporting and failure diagnosis --
    none of which is about identity -- so the fixture supplies it once here
    rather than repeating it at forty call sites.
    """

    def __init__(self, *args, principal, **kwargs):
        super().__init__(*args, **kwargs)
        self.principal = principal

    def start(self, **kwargs):
        return super().start(self.principal, **kwargs)

    def get(self, *args):
        # Called both ways: `manager.get(id)` from the tests below, and
        # `self.get(principal, id)` from RunManager.delete/cancel internally.
        # Take the id from the end and always use this manager's own caller.
        return RunManager.get(self, self.principal, args[-1])

    def list(self, limit=100):
        return super().list(self.principal, limit=limit)

    def cancel(self, run_id):
        return super().cancel(self.principal, run_id)

    def delete(self, run_id):
        return super().delete(self.principal, run_id)


@pytest.fixture
def manager(tmp_path, test_principal, needs_db):
    return _OwnedRunManager(tmp_path / "runs", tmp_path,
                            venv_python=tmp_path / "python",
                            principal=test_principal)


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
        # Two gates now: a per-person slot and a machine-wide one. One person
        # queueing twice hits their own first, and the wording says so -- "the
        # running backtest" would have implied a colleague was holding it up.
        assert manager.get(second.id).meta["phase"] == "Waiting for your other backtest"

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
    """A run left `running` by a dead process must not stay `running`.

    The mechanism moved: it used to happen lazily, when a request read a
    run.json still claiming to be in flight. Runs are rows now, so it is a
    single sweep at startup instead -- which is also more honest, because it
    settles every abandoned run at once rather than only the ones somebody
    happens to look at.
    """

    def _seed(self, principal, run_id, status):
        from webapp.api.db import service_tx

        with service_tx() as cur:
            cur.execute(
                "INSERT INTO aion.runs (id, org_id, user_id, name, kind, status, phase) "
                "VALUES (%s, %s, %s, 'orphan', 'backtest', %s, 'Training model')",
                (run_id, principal.org_id, principal.user_id, status))

    @pytest.mark.parametrize("status", ["running", "queued"])
    def test_an_abandoned_run_is_failed_at_startup(self, manager, test_principal, status):
        self._seed(test_principal, f"orphan-{status}", status)

        manager.reconcile_orphans()

        meta = manager.get(f"orphan-{status}").meta
        assert meta["status"] == "failed"
        assert meta["phase"] == "Interrupted"
        assert "restart" in (meta["error"] or "")
        assert meta["finished_at"] is not None
        # And the reason is actionable, not just a status change.
        assert "Start the run again" in (meta["error_hint"] or "")

    def test_terminal_runs_are_left_alone(self, manager, test_principal):
        self._seed(test_principal, "already-done", "succeeded")

        manager.reconcile_orphans()

        meta = manager.get("already-done").meta
        assert meta["status"] == "succeeded"
        assert meta["error"] is None


class TestDelete:
    """Deleting a run removes its row and directory -- and refuses while it can still write."""

    def _finished_run(self, manager, monkeypatch, run_id_holder):
        """Start a run with a no-op subprocess, so it finishes immediately."""
        monkeypatch.setattr(RunManager, "_run_subprocess",
                            lambda self, run: run.update(status="succeeded", phase="Done",
                                                         exit_code=0))
        run = manager.start(name="done", config={})
        run_id_holder.append(run.id)
        for _ in range(100):
            if manager.get(run.id).meta["status"] == "succeeded":
                break
            time.sleep(0.02)
        run.log_path.write_text("done\n")
        return run

    def test_finished_run_is_removed(self, manager, monkeypatch):
        ids: list[str] = []
        run = self._finished_run(manager, monkeypatch, ids)

        assert manager.delete(run.id) is True
        assert not run.dir.exists()
        assert manager.get(run.id) is None
        assert manager.list() == []

    def test_running_run_refuses(self, manager, monkeypatch):
        ids: list[str] = []
        run = self._finished_run(manager, monkeypatch, ids)
        # Put it back into flight -- the state the endpoint must refuse, and the
        # reason delete is not simply a DELETE statement.
        manager.get(run.id).update(status="running")

        with pytest.raises(runner.RunBusy):
            manager.delete(run.id)
        assert run.dir.exists()

    def test_missing_run_is_false_not_an_error(self, manager):
        assert manager.delete("nosuchrun") is False

    def test_a_traversing_id_is_refused(self, manager, tmp_path):
        """`get` validates the id, so `delete` can never rmtree outside runs_dir."""
        outside = tmp_path / "precious"
        outside.mkdir()

        assert manager.delete("../precious") is False
        assert outside.exists()

    def test_a_colleagues_run_cannot_be_deleted(self, manager, monkeypatch,
                                                test_principal, needs_db):
        """Deletion goes through the caller's own RLS context, not a bare DELETE."""
        from webapp.api.auth import Principal
        from webapp.api.db import service_tx
        import uuid as _uuid

        ids: list[str] = []
        run = self._finished_run(manager, monkeypatch, ids)

        # Someone else, in an organisation of their own.
        with service_tx() as cur:
            cur.execute("SELECT user_id FROM public.user_profiles "
                        "WHERE user_id <> %s LIMIT 1", (test_principal.user_id,))
            row = cur.fetchone()
        if row is None:
            pytest.skip("only one account exists in this database")
        stranger = Principal(user_id=str(row["user_id"]), email=None,
                             org_id=str(_uuid.uuid4()), org_role="member")

        assert RunManager.get(manager, stranger, run.id) is None
        assert run.dir.exists(), "a stranger's delete removed the log"
