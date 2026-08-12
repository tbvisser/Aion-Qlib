"""Backtest/training runs, executed as `qrun` subprocesses.

Why subprocesses rather than threads: ``qlib.init()`` writes process-global
config, so two runs in one process would fight over it, and a segfault in a
native model (LightGBM/OpenMP) would take the API down with it. A subprocess
also gives us free cancellation and a clean log per run.

Runs execute with cwd = <repo>/examples so their MLflow file store lands in
examples/mlruns -- the same store the qlib-mlflow-ui container already serves,
and the same one the bundled benchmarks write to.
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

RunStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]

#: Backtests allowed to train at once.
#:
#: One. `qrun` trains a gradient-booster and then walks a full backtest; two of
#: those on a laptop do not finish in half the time each, they thrash. The
#: threads pinned to 1 in `_execute` are per-process, so concurrency here
#: multiplies rather than shares.
MAX_CONCURRENT_RUNS = 1

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


class Run:
    """In-memory handle plus the on-disk record."""

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

    @property
    def meta_path(self) -> Path:
        return self.dir / "run.json"

    def save(self) -> None:
        with self._lock:
            self.meta_path.write_text(json.dumps(self.meta, indent=2))

    def update(self, **fields) -> None:
        self.meta.update(fields)
        self.save()


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
                 max_concurrent: int = MAX_CONCURRENT_RUNS):
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

    # -- persistence ------------------------------------------------------
    def _load(self, run_id: str) -> Run | None:
        directory = self.runs_dir / run_id
        meta_path = directory / "run.json"
        if not meta_path.exists():
            return None
        run = Run(run_id, directory, json.loads(meta_path.read_text()))
        # A run reaches _load only when this process has no handle on it, so a
        # disk record still saying queued/running is a run some earlier API
        # process left behind: its subprocess is untracked and will never
        # report back. Settle it now rather than serving "running" forever.
        # (Assumes one API process owns runs_dir — true today with a single
        # uvicorn worker. With --workers > 1 this would falsely fail a
        # sibling worker's live runs.)
        if run.meta.get("status") in ("queued", "running"):
            run.update(
                status="failed", phase="Interrupted",
                error="Interrupted by an API restart",
                error_hint=(
                    "The API process restarted while this run was in flight, so "
                    "its subprocess is no longer tracked. Start the run again."
                ),
                finished_at=datetime.now(timezone.utc).isoformat(),
            )
        self._runs[run_id] = run
        return run

    def get(self, run_id: str) -> Run | None:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", run_id):
            return None
        return self._runs.get(run_id) or self._load(run_id)

    def list(self, limit: int = 100) -> list[dict]:
        out: list[dict] = []
        for directory in self.runs_dir.iterdir():
            if not directory.is_dir():
                continue
            run = self.get(directory.name)
            if run:
                out.append(self._public(run))
        out.sort(key=lambda r: r["created_at"], reverse=True)
        return out[:limit]

    # -- lifecycle --------------------------------------------------------
    def start(self, *, name: str, config: dict, kind: str = "backtest",
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

        run = Run(run_id, directory, {
            "id": run_id,
            "name": name,
            "kind": kind,
            "strategy_id": strategy_id,
            "status": "queued",
            "phase": "Queued",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "started_at": None,
            "finished_at": None,
            "exit_code": None,
            "error": None,
            "experiment_name": config["experiment_name"],
            **(extra or {}),
        })
        run.config_path.write_text(yaml.safe_dump(config, sort_keys=False, width=100))
        run.save()
        self._runs[run_id] = run

        threading.Thread(target=self._execute, args=(run,), daemon=True).start()
        return run

    def _execute(self, run: Run) -> None:
        """Wait for a slot, then run. The wait is what makes `queued` true."""
        if self._slot.acquire(blocking=False):
            waited = False
        else:
            run.update(phase="Waiting for the running backtest")
            self._slot.acquire()
            waited = True

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

    def cancel(self, run_id: str) -> bool:
        run = self.get(run_id)
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

    def delete(self, run_id: str) -> bool:
        """Remove a finished run's directory. False when there was no such run.

        Only the run directory goes. Its MLflow experiment (`aion-<id>`) and
        artifacts stay under `examples/mlruns` -- reaching those needs qlib
        imported, and a delete that can 503 because `require_qlib` failed is
        worse than one that is honest about what it removes.
        """
        run = self.get(run_id)   # validates the id; run.dir cannot escape runs_dir
        if run is None:
            return False
        if run.meta.get("status") in ("queued", "running"):
            raise RunBusy(run_id)
        shutil.rmtree(run.dir, ignore_errors=True)
        self._runs.pop(run_id, None)
        return True

    # -- presentation -----------------------------------------------------
    @staticmethod
    def _public(run: Run) -> dict:
        return dict(run.meta)

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
