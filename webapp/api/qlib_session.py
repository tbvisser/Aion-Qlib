"""Single, process-wide qlib initialisation.

``qlib.init()`` mutates global state (``qlib.config.C``), so it must happen
exactly once per process and can never be re-pointed per request. That is also
why every backtest runs in a subprocess (see ``runner.py``) rather than in a
worker thread here: a run needs its own global config, and a crash inside a run
must not take the API down.

The API reads whichever store is available -- the EODHD US store once the
ingest has built it, otherwise the bundled CN dataset -- and reports which one
it chose so the UI can be honest about what is on screen.
"""
from __future__ import annotations

import copy
import logging
import threading
from pathlib import Path

from .config import get_settings

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_state: dict = {"ready": False, "provider_uri": None, "region": None, "error": None}


def _store_exists(uri: str) -> bool:
    root = Path(uri).expanduser()
    return (root / "calendars").is_dir() and (root / "features").is_dir()


def resolve_store() -> tuple[str, str] | None:
    """Pick the store to serve: the configured one, else the fallback."""
    s = get_settings()
    if _store_exists(s.provider_uri):
        return s.provider_uri, s.region
    if _store_exists(s.fallback_provider_uri):
        return s.fallback_provider_uri, s.fallback_region
    return None


def init_qlib() -> dict:
    """Initialise qlib once. Safe to call repeatedly; returns the status dict."""
    with _lock:
        if _state["ready"]:
            return dict(_state)

        resolved = resolve_store()
        if resolved is None:
            _state["error"] = (
                "No qlib data store found. Run the EODHD ingest, or download the "
                "bundled dataset with scripts/get_data.py."
            )
            return dict(_state)

        uri, region = resolved
        s = get_settings()
        s.mlflow_dir.mkdir(parents=True, exist_ok=True)
        try:
            import qlib
            from qlib.config import C

            # kernels=1 is a large win here, not a limitation. qlib defaults to
            # a joblib pool (8 workers on this box) whose startup cost is a flat
            # ~14s per query because each worker re-imports qlib -- measured
            # identical for 25 names and for 500, so it is pure overhead rather
            # than work. Serially, the same 500-name query takes 1.9s and a
            # small one 0.05s. Backtests still get full parallelism: they run in
            # their own `qrun` subprocess with qlib's default config.
            # Point the experiment manager at the SAME MLflow store the runs
            # write to. qrun resolves `mlruns` relative to its working directory
            # (examples/), so without this the API would create a second, empty
            # store at the repo root and every finished run would look like it
            # recorded nothing. This is also the store qlib-mlflow-ui serves.
            exp_manager = copy.deepcopy(C["exp_manager"])
            exp_manager["kwargs"]["uri"] = f"file:{s.mlflow_dir.resolve()}"

            qlib.init(provider_uri=uri, region=region, kernels=1, exp_manager=exp_manager)
        except Exception as exc:  # pragma: no cover - depends on local data
            logger.exception("qlib.init failed")
            _state["error"] = f"{type(exc).__name__}: {exc}"
            return dict(_state)

        _state.update(ready=True, provider_uri=uri, region=region, error=None)
        logger.info("qlib initialised on %s (%s)", uri, region)
        return dict(_state)


def status() -> dict:
    return dict(_state)


def require_qlib() -> None:
    """Raise a user-facing HTTP error when the data layer is unusable."""
    from fastapi import HTTPException

    state = init_qlib()
    if not state["ready"]:
        raise HTTPException(status_code=503, detail=state["error"] or "qlib not initialised")
