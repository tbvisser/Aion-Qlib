"""Backtest/training runs, executed as `qrun` subprocesses.

Why subprocesses rather than threads: ``qlib.init()`` writes process-global
config, so two runs in one process would fight over it, and a segfault in a
native model (LightGBM/OpenMP) would take the API down with it. A subprocess
also gives us free cancellation and a clean log per run.

Runs execute with cwd = <repo>/examples so their MLflow file store lands in
examples/mlruns -- the same store the qlib-mlflow-ui container already serves,
and the same one the bundled benchmarks write to.

Who owns a run lives in Postgres (``aion.runs``); its config and log stay on
disk under ``runs_dir/<run_id>/``. The split is deliberate: a log is an append-
heavy stream that files handle well and rows do not, and the row is what gates
access to the file anyway.

Note on identity, because there are two paths and they are not interchangeable.
Reads and the initial insert run as the caller under
:func:`webapp.api.db.user_tx`, so row level security decides what is visible and
which organisation a run may be created in. Everything the *run thread* writes
afterwards goes through :func:`webapp.api.db.service_tx`, because that thread
outlives the request that started it -- by the time a two-hour backtest records
its outcome the user's access token is long expired. It scopes by run id, and
the ownership check already happened at the door.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import yaml

from .db import service_tx, user_tx

RunStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]

#: Backtests allowed to train at once, across everybody.
#:
#: `qrun` trains a gradient-booster and then walks a full backtest; several of
#: those on one box do not finish in a fraction of the time each, they thrash.
#: The threads pinned to 1 in `_execute` are per-process, so concurrency here
#: multiplies rather than shares. Two rather than one only because a single
#: global slot became a cross-user queue the moment the platform had more than
#: one user: a colleague's long backtest would hold everyone else's at "Waiting".
MAX_CONCURRENT_RUNS = 2

#: And at most this many per person, so nobody can take the whole machine by
#: queueing ten runs. This is the half that makes the global cap fair rather
#: than first-come-first-served.
MAX_CONCURRENT_RUNS_PER_USER = 1

# qrun prints these; they are the only reliable progress signal it emits.
_PHASE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"Loading data|DataHandlerLP", re.I), "Loading data"),
    (re.compile(r"training|train\b|fit\b", re.I), "Training model"),
    (re.compile(r"SignalRecord|generating prediction|pred\.pkl", re.I), "Generating predictions"),
    (re.compile(r"backtest loop|Create new exchange", re.I), "Running backtest"),
    (re.compile(r"portfolio analysis|port_analysis", re.I), "Analysing portfolio"),
]


class RunBusy(Exception):
    """A run that can still write to its own directory cannot be deleted."""


#: Lifecycle fields with a column of their own in ``aion.runs``. Anything else
#: passed to ``Run.update`` is a strategy knob and lands in the ``params`` blob,
#: which is what keeps the wire shape flat for the UI without the table growing
#: a column every time the builder gains a setting.
_RUN_COLUMNS = {
    "name", "kind", "strategy_id", "status", "phase", "exit_code", "error",
    "error_hint", "experiment_name", "metrics", "started_at", "finished_at",
    "visibility",
}

#: Written as jsonb rather than a scalar.
_RUN_JSON_COLUMNS = {"metrics"}

#: Written as timestamptz. The meta dict carries ISO strings; Postgres wants a
#: timestamp, and letting it cast keeps one representation on the wire.
_RUN_TIME_COLUMNS = {"started_at", "finished_at"}


class Run:
    """In-memory handle plus the database record."""

    def __init__(self, run_id: str, directory: Path, meta: dict[str, Any]):
        self.id = run_id
        self.dir = directory
        self.meta = meta
        self.process: subprocess.Popen | None = None
        self._lock = threading.Lock()

    @property
    def log_path(self) -> Path:
        return self.dir / "run.log"

    @property
    def config_path(self) -> Path:
        return self.dir / "config.yaml"

    def update(self, **fields) -> None:
        """Apply changes in memory and persist them.

        Called from the run thread, so it writes as ``service_role``: this
        happens long after the request that started the run has returned, and
        the user's token may no longer be valid. The run id is the scope.
        """
        self.meta.update(fields)

        columns: dict[str, Any] = {}
        params: dict[str, Any] = {}
        for key, value in fields.items():
            if key in _RUN_COLUMNS:
                columns[key] = json.dumps(value) if key in _RUN_JSON_COLUMNS else value
            else:
                params[key] = value

        sets = [f"{k} = %s::timestamptz" if k in _RUN_TIME_COLUMNS
                else f"{k} = %s::jsonb" if k in _RUN_JSON_COLUMNS
                else f"{k} = %s"
                for k in columns]
        values = list(columns.values())
        if params:
            # Merge rather than replace: two updates touching different knobs
            # must not erase each other.
            sets.append("params = params || %s::jsonb")
            values.append(json.dumps(params))
        if not sets:
            return
        sets.append("updated_at = NOW()")

        with self._lock:
            with service_tx() as cur:
                cur.execute(
                    f"UPDATE aion.runs SET {', '.join(sets)} WHERE id = %s",
                    (*values, self.id),
                )


def default_python(repo_root: Path) -> Path:
    """The interpreter to run `qrun` subprocesses with.

    Prefers the repo's own virtualenv, which is what `webapp/dev.sh` sets up and
    what the API itself runs under bare-metal. Falls back to the interpreter
    currently executing, which is the case that matters in Docker: the container
    bind-mounts the repo at /qlib, so <repo>/.venv/bin/python is whatever the
    *host* put there and exec fails with an arch error on every run.

    The executable check is doing the work, not the existence check. A macOS venv
    seen from a Linux container is a symlink into /opt/homebrew that resolves to
    nothing, so it is skipped -- but relying on that would be relying on an
    accident of how the venv was built. os.access says what we actually mean:
    only hand qrun an interpreter we can really launch.
    """
    venv = repo_root / ".venv" / "bin" / "python"
    if venv.is_file() and os.access(venv, os.X_OK):
        return venv
    return Path(sys.executable)


class RunManager:
    """Owns the run directory and the live subprocesses."""

    def __init__(self, runs_dir: Path, repo_root: Path, venv_python: Path | None = None,
                 max_concurrent: int = MAX_CONCURRENT_RUNS,
                 max_per_user: int = MAX_CONCURRENT_RUNS_PER_USER):
        self.runs_dir = runs_dir
        self.repo_root = repo_root
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self._runs: dict[str, Run] = {}
        self._python = venv_python or default_python(repo_root)
        # `queued` used to be a fiction: the status was written and the thread
        # started in the same breath, so pressing Run three times -- which is
        # reasonable, since nothing said a backtest was already going -- put
        # three qrun subprocesses on the machine, each training a model.
        self._slot = threading.BoundedSemaphore(max(1, max_concurrent))
        # One semaphore per person, created on first use. Without this the
        # global cap is pure first-come-first-served and one enthusiastic user
        # can occupy every slot.
        self._max_per_user = max(1, max_per_user)
        self._user_slots: dict[str, threading.BoundedSemaphore] = {}
        self._user_slots_lock = threading.Lock()

    def _user_slot(self, user_id: str) -> threading.BoundedSemaphore:
        with self._user_slots_lock:
            slot = self._user_slots.get(user_id)
            if slot is None:
                slot = threading.BoundedSemaphore(self._max_per_user)
                self._user_slots[user_id] = slot
            return slot

    # -- persistence ------------------------------------------------------
    #: Every column _meta_from_row expects. Named once so SELECT and RETURNING
    #: cannot drift apart -- they must produce the same shape.
    _FIELDS = (
        "id, user_id, visibility, name, kind, strategy_id, status, phase, "
        "exit_code, error, error_hint, experiment_name, params, metrics, "
        "created_at, started_at, finished_at"
    )
    _SELECT = f"SELECT {_FIELDS} FROM aion.runs "

    @staticmethod
    def _meta_from_row(row: dict) -> dict:
        """Flatten a row back into the meta shape the UI has always received.

        The strategy knobs (model, handler, universe, costs...) were top-level
        keys in run.json and stay top-level here; in the table they live in
        `params` so the schema does not grow a column per builder setting.
        """
        def iso(value):
            return value.isoformat() if value is not None else None

        return {
            **(row.get("params") or {}),
            "id": row["id"],
            "user_id": str(row["user_id"]),
            "visibility": row["visibility"],
            "name": row["name"],
            "kind": row["kind"],
            "strategy_id": row["strategy_id"],
            "status": row["status"],
            "phase": row["phase"],
            "exit_code": row["exit_code"],
            "error": row["error"],
            "error_hint": row["error_hint"],
            "experiment_name": row["experiment_name"],
            "metrics": row["metrics"],
            "created_at": iso(row["created_at"]),
            "started_at": iso(row["started_at"]),
            "finished_at": iso(row["finished_at"]),
        }

    def reconcile_orphans(self) -> int:
        """Fail runs left `queued`/`running` by a previous API process.

        Their subprocesses are untracked and will never report back, so serving
        "running" forever is a lie. Called once at startup.

        Assumes one API process owns runs_dir -- true with a single uvicorn
        worker. With --workers > 1 this would falsely fail a sibling's live runs,
        which is the same assumption the file-based version made and the reason
        MAX_CONCURRENT_RUNS is enforced in-process rather than in the database.
        """
        with service_tx() as cur:
            cur.execute(
                "UPDATE aion.runs SET status = 'failed', phase = 'Interrupted', "
                "  error = 'Interrupted by an API restart', error_hint = %s, "
                "  finished_at = NOW(), updated_at = NOW() "
                "WHERE status IN ('queued', 'running')",
                ("The API process restarted while this run was in flight, so its "
                 "subprocess is no longer tracked. Start the run again.",),
            )
            return cur.rowcount

    def get(self, principal, run_id: str) -> Run | None:
        """One run, if this caller may see it.

        RLS answers the ownership question: a run belonging to someone else
        simply is not in the result, so there is no separate permission check to
        forget.
        """
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", run_id):
            return None
        with user_tx(principal.user_id) as cur:
            cur.execute(self._SELECT + "WHERE id = %s", (run_id,))
            row = cur.fetchone()
        if row is None:
            return None
        meta = self._meta_from_row(row)
        # Reuse the live handle when this process owns the subprocess -- it
        # holds the Popen needed to cancel -- but take the freshly read row as
        # the truth about status.
        live = self._runs.get(run_id)
        if live is not None:
            live.meta = meta
            return live
        return Run(run_id, self.runs_dir / run_id, meta)

    def list(self, principal, limit: int = 100) -> list[dict]:
        limit = max(1, min(int(limit), 1000))
        with user_tx(principal.user_id) as cur:
            cur.execute(
                self._SELECT + "ORDER BY created_at DESC LIMIT %s", (limit,)
            )
            return [self._meta_from_row(row) for row in cur.fetchall()]

    # -- lifecycle --------------------------------------------------------
    def start(self, principal, *, name: str, config: dict, kind: str = "backtest",
              strategy_id: str | None = None, extra: dict | None = None) -> Run:
        run_id = uuid.uuid4().hex[:12]
        directory = self.runs_dir / run_id
        directory.mkdir(parents=True, exist_ok=True)

        # Give the run its own MLflow experiment, keyed on the id, so its
        # recorder can be found later without guessing between concurrent runs.
        # This must happen before the config is written -- the subprocess starts
        # reading it the moment the thread below launches.
        # Read back by results.resolve_experiment, which also knows the
        # pre-rename `qlibstudio-` prefix.
        config = {**config, "experiment_name": f"aion-{run_id}"}
        params = dict(extra or {})

        # Written as the caller, so the INSERT policy checks org membership. If
        # this fails nothing else has happened yet.
        with user_tx(principal.user_id) as cur:
            cur.execute(
                "INSERT INTO aion.runs "
                "  (id, org_id, user_id, name, kind, strategy_id, status, phase, "
                "   experiment_name, params) "
                "VALUES (%s, %s, %s, %s, %s, %s, 'queued', 'Queued', %s, %s::jsonb) "
                f"RETURNING {self._FIELDS}",
                (run_id, principal.org_id, principal.user_id, name, kind,
                 strategy_id, config["experiment_name"], json.dumps(params)),
            )
            row = cur.fetchone()

        run = Run(run_id, directory, self._meta_from_row(row))
        run.config_path.write_text(yaml.safe_dump(config, sort_keys=False, width=100))
        self._runs[run_id] = run

        threading.Thread(
            target=self._execute, args=(run, principal.user_id), daemon=True
        ).start()
        return run

    def _execute(self, run: Run, user_id: str) -> None:
        """Wait for a slot, then run. The wait is what makes `queued` true.

        Two gates, taken in a fixed order so they cannot deadlock: the caller's
        own slot first, then a global one. Holding a personal slot while waiting
        for the machine is harmless -- it only blocks that same person's next
        run, which is exactly the intent.
        """
        user_slot = self._user_slot(user_id)
        waited = False

        if not user_slot.acquire(blocking=False):
            run.update(phase="Waiting for your other backtest")
            user_slot.acquire()
            waited = True

        try:
            if not self._slot.acquire(blocking=False):
                run.update(phase="Waiting for a free slot on the machine")
                self._slot.acquire()
                waited = True
        except BaseException:
            user_slot.release()
            raise

        try:
            # Cancelling a queued run is allowed, and by the time the slot frees
            # it may already have happened. Starting the subprocess anyway would
            # be the one case where Cancel visibly does nothing.
            if run.meta.get("status") == "cancelled":
                run.update(phase="Cancelled",
                           finished_at=datetime.now(timezone.utc).isoformat())
                return
            if waited:
                run.update(phase="Starting")
            self._run_subprocess(run)
        finally:
            self._slot.release()
            user_slot.release()

    def _run_subprocess(self, run: Run) -> None:
        # cwd = examples/ so mlruns lands in the store the MLflow UI serves.
        cwd = self.repo_root / "examples"
        cwd.mkdir(exist_ok=True)

        env = os.environ.copy()
        env.setdefault("MLFLOW_ALLOW_FILE_STORE", "true")
        # macOS: qlib's CI pins these to avoid OpenMP segfaults during backtests.
        for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS",
                    "OPENBLAS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
            env.setdefault(var, "1")
        env["PYTHONUNBUFFERED"] = "1"

        cmd = [str(self._python), str(self.repo_root / "qlib" / "cli" / "run.py"),
               str(run.config_path)]

        run.update(status="running", phase="Starting", started_at=datetime.now(timezone.utc).isoformat())

        try:
            with run.log_path.open("w") as log:
                process = subprocess.Popen(
                    cmd, cwd=str(cwd), env=env,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, bufsize=1, start_new_session=True,
                )
                run.process = process
                assert process.stdout is not None
                for line in process.stdout:
                    log.write(line)
                    log.flush()
                    phase = _phase_for(line)
                    if phase and _phase_advances(run.meta.get("phase"), phase):
                        run.update(phase=phase)
                code = process.wait()
        except Exception as exc:  # pragma: no cover - process-level failure
            run.update(status="failed", phase="Failed", error=f"{type(exc).__name__}: {exc}",
                       finished_at=datetime.now(timezone.utc).isoformat())
            return

        if run.meta.get("status") == "cancelled":
            run.update(finished_at=datetime.now(timezone.utc).isoformat(), exit_code=code)
            return

        if code == 0:
            run.update(status="succeeded", phase="Done", exit_code=0,
                       finished_at=datetime.now(timezone.utc).isoformat(),
                       metrics=_metrics_snapshot(run))
        else:
            tail = _last_error(run.log_path)
            run.update(status="failed", phase="Failed", exit_code=code,
                       error=tail, error_hint=_diagnose(tail),
                       finished_at=datetime.now(timezone.utc).isoformat())

    def cancel(self, principal, run_id: str) -> bool:
        run = self.get(principal, run_id)
        if not run or run.meta.get("status") not in ("queued", "running"):
            return False
        run.update(status="cancelled", phase="Cancelled")
        process = run.process
        if process and process.poll() is None:
            # start_new_session put the child in its own group, so this reaches
            # any workers qrun spawned rather than orphaning them.
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                process.terminate()
        return True

    def delete(self, principal, run_id: str) -> bool:
        """Remove a finished run. False when there was no such run.

        Only the row and the run directory go. The MLflow experiment
        (`aion-<id>`) and its artifacts stay under `examples/mlruns` -- reaching
        those needs qlib imported, and a delete that can 503 because
        `require_qlib` failed is worse than one that is honest about what it
        removes.

        The DELETE goes through the caller's own transaction, so RLS decides
        whether they may remove it. The directory is only unlinked if the row
        actually went -- otherwise a colleague viewing a shared run could
        destroy its log while leaving the record intact.
        """
        run = self.get(principal, run_id)   # validates the id; dir cannot escape runs_dir
        if run is None:
            return False
        if run.meta.get("status") in ("queued", "running"):
            raise RunBusy(run_id)
        with user_tx(principal.user_id) as cur:
            cur.execute("DELETE FROM aion.runs WHERE id = %s", (run_id,))
            removed = cur.rowcount > 0
        if not removed:
            return False
        shutil.rmtree(run.dir, ignore_errors=True)
        self._runs.pop(run_id, None)
        return True

    # -- presentation -----------------------------------------------------
    def tail(self, run: Run, offset: int = 0, limit: int = 400) -> tuple[list[str], int]:
        if not run.log_path.exists():
            return [], offset
        lines = run.log_path.read_text(errors="replace").splitlines()
        return lines[offset:offset + limit], min(len(lines), offset + limit)


def _metrics_snapshot(run: Run) -> dict[str, Any] | None:
    """The run's own copy of its headline metrics, taken once at completion.

    Metrics live in the MLflow file store under `examples/mlruns`, and until now
    that was the only copy: every render re-read it, and clearing that directory
    silently turned every historical run's metrics into em dashes with nothing on
    disk to fall back to. `RunManager.delete` already refuses to touch `mlruns`
    for the mirror-image reason; this closes the other direction.

    Deliberately only the small stuff -- the risk table, the signal metrics and
    the sanity verdict, not the curves. A snapshot is for keeping a finished run
    readable in a list, and the curves are large and re-derivable.

    A failure here is not a failed run. The run succeeded; only the bookkeeping
    did, so this returns None and the report route falls back to reading MLflow.
    """
    try:
        from . import results

        experiment = results.resolve_experiment(
            run.meta["id"], run.meta.get("experiment_name"))
        report = results.build_report(experiment)
        if report is None:
            return None
        return {
            "risk": report.get("risk") or {},
            "metrics": report.get("metrics") or {},
            "sanity": report.get("sanity") or {},
            "period": report.get("period"),
            "indicators": report.get("indicators") or {},
            "captured_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception:
        return None


def _phase_for(line: str) -> str | None:
    """The phase a log line announces, or None.

    Last match wins, not first. The patterns are ordered by when they happen,
    and a single line can trip more than one -- qrun logs backtest segment
    names, so "backtest loop ... train" matched `train\\b` under first-wins and
    reported Training. Taking the latest match makes a line that mentions two
    stages resolve to the later one.
    """
    found: str | None = None
    for pattern, phase in _PHASE_PATTERNS:
        if pattern.search(line):
            found = phase
    return found


#: Phase name -> where it sits in the run. Progress may only move forwards.
_PHASE_ORDER: dict[str, int] = {phase: i for i, (_, phase) in enumerate(_PHASE_PATTERNS)}


def _phase_advances(current: str | None, candidate: str) -> bool:
    """Is `candidate` later in the run than `current`?

    The only progress signal a waiting user has is this word, so it must not go
    backwards. `Starting` and the queue phases are not in the table and rank
    below everything, which is what lets the first real phase replace them.
    """
    return _PHASE_ORDER.get(candidate, -1) > _PHASE_ORDER.get(current or "", -1)


# A run fails for a handful of knowable reasons, and the codebase already
# understands each of them -- in comments, where the person reading a traceback
# never sees them. These turn the ones we can recognise into a sentence.
#
# Order matters: the first match wins, so the specific patterns come before the
# generic ones. Anything unrecognised falls through to the raw tail, which is
# still the honest answer for a failure nobody has seen before.
_DIAGNOSES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"Empty data from dataset", re.I),
     "Every row was dropped before training. This usually means a feature is "
     "all-NaN for this store — a column whose source the store does not carry. "
     "Linear models drop any row with a gap, so one empty column empties the "
     "whole set; a tree model would have tolerated it."),
    # The twin of the one above, and it took a sweep to surface: there the
    # column was all-NaN and `dropna` emptied the set, here a few cells are inf
    # or NaN and scipy refuses the matrix outright. Same root cause — a value a
    # tree would have shrugged at reaching a linear solver — and it is the
    # failure a model sweep hits most, because ticking `linear` beside
    # `lightgbm` is the obvious first comparison to run.
    # Two wordings for one failure: scipy's, and sklearn's own check, which
    # says either "Input X contains NaN" or "Input contains infinity" — hence
    # `.*contains` rather than `.* contains`, which would need a second space.
    (re.compile(r"array must not contain infs or NaNs|Input .*contains (NaN|infinity)", re.I),
     "A feature held an infinite or missing value where the model needs a "
     "number. Linear models refuse those outright; a tree model tolerates "
     "them. It is usually a custom factor dividing by something that can be "
     "zero — wrap the denominator, or train this one with a tree."),
    (re.compile(r"\bImportError\b|\bModuleNotFoundError\b", re.I),
     "A dependency this model needs is not installed. The torch-based learners "
     "need the `rl` extras; pick one of the offered models instead."),
    (re.compile(r"IndexError.*is out of bounds for axis", re.I),
     "The backtest ran past the last day in the store's calendar. Move the test "
     "end date a few sessions earlier."),
    (re.compile(r"No such file or directory.*(calendars|instruments|features)", re.I),
     "The data store is missing files the run needs. Rebuild it from the "
     "Markets page before running again."),
    (re.compile(r"\bMemoryError\b|Killed", re.I),
     "The run ran out of memory. A smaller universe or a shorter training "
     "window will fit."),
]


def _diagnose(text: str) -> str | None:
    """A plain sentence for a failure we recognise, or None."""
    for pattern, message in _DIAGNOSES:
        if pattern.search(text):
            return message
    return None


def _last_error(log_path: Path, lines: int = 25) -> str:
    """The tail of the log — the traceback is what makes a failure actionable."""
    try:
        text = log_path.read_text(errors="replace").splitlines()
    except OSError:
        return "Run failed (no log)."
    return "\n".join(text[-lines:]) or "Run failed with no output."
