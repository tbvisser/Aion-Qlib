"""Which interpreter RunManager launches `qrun` with.

This is the difference between backtests working and not working inside Docker.
The container bind-mounts the repo at /qlib, so <repo>/.venv/bin/python is the
host's macOS binary; exec'ing it fails on every single run. Bare-metal, the venv
is still the right answer because the API may be started by a different Python
than the one holding the dependencies.
"""
from __future__ import annotations

import sys
from pathlib import Path

from webapp.api.runner import RunManager, default_python


def _make_venv(root: Path) -> Path:
    python = root / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.touch()
    python.chmod(0o755)
    return python


def test_prefers_repo_venv_when_present(tmp_path):
    """Bare-metal: dev.sh's venv wins, even though sys.executable also exists."""
    expected = _make_venv(tmp_path)
    assert default_python(tmp_path) == expected


def test_falls_back_to_current_interpreter_without_a_venv(tmp_path):
    """In-container: no .venv on the mount, so use the interpreter we run under.

    Before this fallback existed the manager returned <repo>/.venv/bin/python
    unconditionally and every dockerised run died in exec.
    """
    assert not (tmp_path / ".venv").exists()
    assert default_python(tmp_path) == Path(sys.executable)


def test_run_manager_uses_the_fallback(tmp_path):
    """The wiring, not just the helper -- routers/runs.py passes no override."""
    manager = RunManager(tmp_path / "runs", tmp_path)
    assert manager._python == Path(sys.executable)


def test_run_manager_uses_the_venv(tmp_path):
    expected = _make_venv(tmp_path)
    manager = RunManager(tmp_path / "runs", tmp_path)
    assert manager._python == expected


def test_ignores_a_venv_pointing_at_a_missing_interpreter(tmp_path):
    """The macOS-venv-seen-from-Linux case, which is what Docker actually hits.

    .venv/bin/python is a symlink into the host's Homebrew prefix; inside the
    container it resolves to nothing. Following it would exec a binary that isn't
    there -- or worse, on a Linux host, one built for the wrong environment.
    """
    python = tmp_path / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    # Stands in for /opt/homebrew/... as seen from a Linux container. Pointed at a
    # path under tmp_path so the test doesn't depend on what the host has installed.
    python.symlink_to(tmp_path / "no" / "such" / "python3.11")

    assert python.is_symlink() and not python.exists()
    assert default_python(tmp_path) == Path(sys.executable)


def test_ignores_a_non_executable_venv_interpreter(tmp_path):
    """A file that is there but not runnable is not an interpreter."""
    python = tmp_path / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.touch()
    python.chmod(0o644)

    assert default_python(tmp_path) == Path(sys.executable)


def test_explicit_override_still_wins(tmp_path):
    """Tests and callers that pin an interpreter keep doing so."""
    _make_venv(tmp_path)
    override = tmp_path / "some" / "other" / "python"
    manager = RunManager(tmp_path / "runs", tmp_path, venv_python=override)
    assert manager._python == override
