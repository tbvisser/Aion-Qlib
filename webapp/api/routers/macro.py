"""The Macro Desk's HTTP surface.

Three groups of endpoints:

* **Series** -- the curated registry, its levels and changes, the snapshot
  strip and the Treasury curve. All served from data already on disk.
* **Calendar and indicators** -- the cached EODHD economic calendar and annual
  country indicators, plus the job that refreshes them. **A GET never
  fetches**: read paths serve the cache and report its age. A cold cache is a
  200 carrying ``available: false`` and a reason, not a 404 -- the same
  convention ``/models`` uses. Say why; do not pretend the feature is absent.
* **Linkage** -- what macro actually drives a strategy, run or portfolio.
  ``GET /macro/linkage`` answers the whole panel in one call; the four
  primitives underneath it exist so the UI can re-parameterise one panel
  (a different covariance estimator, regime axes, event type) without
  recomputing the rest.

The analytics paths live here rather than in ``runs.py`` so the qlib and
statistics imports stay out of the CRUD router.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from typing import AsyncIterator, Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import macro, macro_analytics, macro_cache, macro_regime
from .. import macro_registry as registry
from ..auth import Principal, get_principal, require_org_admin
from ..config import get_settings
from ..macro_analytics import MacroAnalyticsError

logger = logging.getLogger(__name__)

router = APIRouter()

_JOBS: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="macro-refresh")

Subject = Literal["strategy", "run", "portfolio"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _clean(value):
    """NaN and inf are not JSON.

    A correlation on a flat series produces both, so every float leaves through
    here rather than trusting the estimator to have been well behaved.
    """
    if value is None:
        return None
    if isinstance(value, (bool, str, int)):
        return value
    try:
        number = float(value)
    except (TypeError, ValueError):
        return value
    return number if math.isfinite(number) else None


def _payload(obj):
    """Dataclasses -> JSON-safe dicts, recursively, cleaning every float."""
    if is_dataclass(obj) and not isinstance(obj, type):
        return _payload(asdict(obj))
    if isinstance(obj, dict):
        return {k: _payload(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_payload(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        return _clean(obj)
    if isinstance(obj, pd.Timestamp):
        return obj.strftime("%Y-%m-%d")
    return obj


# --------------------------------------------------------------------------
# Series
# --------------------------------------------------------------------------
@router.get("/macro/series")
def macro_series() -> dict:
    """The registry, grouped, with per-series availability.

    Unavailable series are returned carrying ``available: false`` and a reason
    rather than being filtered out — a shorter list would read as "this desk
    does not track the dollar", which is a different and wrong statement.
    """
    rows = macro.catalog()
    by_key = {r["key"]: r for r in rows}
    groups = []
    for group, entries in registry.by_group().items():
        groups.append({
            "group": group,
            "label": registry.GROUP_LABELS[group],
            "series": [by_key[e.key] for e in entries if e.key in by_key],
        })
    return {
        "groups": groups,
        "basket": [e.key for e in registry.default_basket()],
        "count": len(rows),
        "available": sum(1 for r in rows if r["available"]),
    }


@router.get("/macro/series/{key}")
def macro_series_data(
    key: str,
    start: str | None = None,
    end: str | None = None,
    resample: Literal["daily", "weekly", "monthly"] = "daily",
) -> dict:
    entry = registry.get(key)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Unknown macro series '{key}'")

    index = macro.reference_index(start, end)
    level = macro.resample(macro.level(entry.key, index).dropna(), resample)
    change = macro.change(entry.key, index).reindex(level.index)

    return {
        "key": entry.key,
        "label": entry.label,
        "group": entry.group,
        "unit": entry.unit,
        "change_unit": entry.change_unit,
        "derived": entry.derivation is not None,
        "note": entry.note,
        "resample": resample,
        "coverage": macro.coverage(entry.key),
        "substituted_from": macro.substituted_from(entry.key),
        "points": [
            {"date": stamp.strftime("%Y-%m-%d"),
             "value": _clean(value),
             "change": _clean(change.get(stamp))}
            for stamp, value in level.items()
        ],
    }


def _window_stats(level: pd.Series, sessions: int) -> float | None:
    if len(level) <= sessions:
        return None
    return _clean(level.iloc[-1] - level.iloc[-1 - sessions])


@router.get("/macro/snapshot")
def macro_snapshot(spark_days: int = Query(90, ge=10, le=400)) -> dict:
    """Latest level, changes over four horizons, a z-score and a sparkline.

    The z-score is the level against its own trailing history — a *direction*
    against precedent, not a judgement. A VIX two standard deviations high is
    not "good" or "bad"; the UI has to say so, and this endpoint deliberately
    does not encode a sign preference.
    """
    index = macro.reference_index()
    if len(index) == 0:
        return {"as_of": None, "rows": [], "available": False,
                "reason": "no macro data on disk yet"}

    horizons = {"1d": 1, "1w": 5, "1m": 21, "1y": 252}
    rows = []
    as_of: pd.Timestamp | None = None

    for entry in registry.offered():
        level = macro.level(entry.key, index).dropna()
        if level.empty:
            rows.append({
                "key": entry.key, "label": entry.label, "group": entry.group,
                "unit": entry.unit, "change_unit": entry.change_unit,
                "available": False,
                "reason": macro.coverage(entry.key).get("reason"),
                "as_of": None, "level": None, "zscore": None, "spark": [],
                **{f"change_{h}": None for h in horizons},
            })
            continue

        last = level.index[-1]
        as_of = last if as_of is None else max(as_of, last)
        scale = 100.0 if entry.unit == "percent" else 1.0
        changes: dict[str, float | None] = {}
        for name, sessions in horizons.items():
            # An annual series steps once a year. Differencing it over one
            # session reports the whole year-on-year jump as today's move --
            # US CPI rendered a -174.8bp "daily change" before this guard.
            # Only the 1y horizon means anything for these.
            if not entry.daily_ok and name != "1y":
                changes[f"change_{name}"] = None
                continue
            raw = _window_stats(level, sessions)
            if raw is None:
                changes[f"change_{name}"] = None
            elif entry.transform == "diff":
                changes[f"change_{name}"] = _clean(raw * scale)
            else:
                base = level.iloc[-1 - sessions]
                changes[f"change_{name}"] = (
                    _clean(level.iloc[-1] / base - 1.0) if base else None
                )

        trailing = level.tail(252 * 10)
        sd = float(trailing.std(ddof=1)) if len(trailing) > 60 else 0.0
        rows.append({
            "key": entry.key, "label": entry.label, "group": entry.group,
            "unit": entry.unit, "change_unit": entry.change_unit,
            "available": True, "reason": None,
            "as_of": last.strftime("%Y-%m-%d"),
            "level": _clean(level.iloc[-1]),
            # None rather than 0.0 when there is too little history to score
            # against: a fabricated zero would tint the tile as "normal".
            "zscore": _clean((level.iloc[-1] - trailing.mean()) / sd) if sd > 0 else None,
            "spark": [_clean(v) for v in level.tail(spark_days)],
            **changes,
        })

    return {
        "as_of": as_of.strftime("%Y-%m-%d") if as_of is not None else None,
        "rows": rows,
        "available": any(r["available"] for r in rows),
        "groups": [
            {"group": g, "label": registry.GROUP_LABELS[g]}
            for g in registry.GROUP_ORDER
        ],
    }


#: Tenor -> registry key, shortest first. The x axis of the curve chart is a
#: category, which is why months is carried alongside the label.
_CURVE = (("3M", 3, "US3M"), ("2Y", 24, "US2Y"), ("5Y", 60, "US5Y"),
          ("10Y", 120, "US10Y"), ("30Y", 360, "US30Y"))


@router.get("/macro/curve")
def macro_curve(date: str | None = None, compare: str | None = None) -> dict:
    """The Treasury curve on a date, and optionally on an earlier one."""
    index = macro.reference_index()
    if len(index) == 0:
        raise HTTPException(status_code=409, detail="No macro data is available yet")
    frame = macro.levels([k for _, _, k in _CURVE], index)

    def snapshot(wanted: str | None) -> dict | None:
        if wanted is None:
            resolved = frame.dropna(how="all").index[-1]
        else:
            target = pd.Timestamp(wanted)
            usable = frame.index[frame.index <= target]
            if len(usable) == 0:
                return None
            resolved = usable[-1]
        row = frame.loc[resolved]
        return {
            "date": wanted or resolved.strftime("%Y-%m-%d"),
            # Differs from `date` when it fell on a holiday or a weekend; the
            # UI says which day it actually drew.
            "resolved_date": resolved.strftime("%Y-%m-%d"),
            "tenors": [
                {"tenor": label, "months": months, "yield": _clean(row.get(key))}
                for label, months, key in _CURVE
            ],
        }

    current = snapshot(date)
    if current is None:
        raise HTTPException(
            status_code=404, detail=f"No Treasury curve on or before {date}"
        )
    return {"current": current,
            "compare": snapshot(compare) if compare else None,
            "compare_label": compare}


# --------------------------------------------------------------------------
# Calendar and indicators
# --------------------------------------------------------------------------
@router.get("/macro/calendar")
def macro_calendar(
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    country: str = "",
    type: str = "",
    limit: int = Query(400, ge=1, le=2000),
) -> dict:
    status = macro_cache.calendar_status()
    if not status["available"]:
        return {"available": False, "reason": status.get("reason"),
                "past": [], "upcoming": [], **status}

    today = pd.Timestamp.utcnow().normalize()
    start = from_ or (today - pd.Timedelta(days=21)).strftime("%Y-%m-%d")
    end = to or (today + pd.Timedelta(days=30)).strftime("%Y-%m-%d")
    rows = macro_cache.releases(start, end, country, type, limit)
    for row in rows:
        row["importance"] = _importance(row["event_key"])
    cutoff = today.strftime("%Y-%m-%d")
    return {
        **status,
        # `from`/`to` below echo the resolved *query* window, shadowing the
        # cache's own coverage from `status` — so that coverage is re-exposed
        # here. The Inbox month grid uses it to say "outside the cached
        # window" instead of implying a quiet month.
        "cache_from": status.get("from"),
        "cache_to": status.get("to"),
        "from": start,
        "to": end,
        "country": country or None,
        "past": [r for r in rows if r["date"] < cutoff],
        "upcoming": [r for r in rows if r["date"] >= cutoff],
    }


@router.get("/macro/calendar/types")
def macro_calendar_types(country: str = "US", limit: int = Query(60, ge=1, le=400)) -> dict:
    """Release types the cache can actually support a study of."""
    status = macro_cache.calendar_status()
    if not status["available"]:
        return {"available": False, "reason": status.get("reason"), "types": []}
    return {"available": True, "country": country or None,
            "types": macro_cache.event_types(country)[:limit]}


@router.get("/macro/calendar/history")
def macro_calendar_history(
    event_key: str,
    country: str = "US",
    limit: int = Query(24, ge=4, le=120),
) -> dict:
    """Trailing prints of one indicator, for the release-detail history chart.

    Release-dated on purpose (``macro_cache.release_history``), not the
    session-shifted event-study series — the chart answers "what printed on
    each date", not "when could the market react".
    """
    status = macro_cache.calendar_status()
    if not status["available"]:
        return {"available": False, "reason": status.get("reason"),
                "event_key": event_key, "country": country or None, "points": []}
    points = macro_cache.release_history(event_key, country, limit)
    for point in points:
        point["importance"] = _importance(point["event_key"])
    return {"available": True, "event_key": event_key,
            "country": country or None, "points": points}


@router.get("/macro/indicators")
def macro_indicators(country: str = "USA") -> dict:
    status = macro_cache.indicator_status()
    if not status["available"]:
        return {"available": False, "reason": status.get("reason"),
                "country": country.upper(), "indicators": [], **status}
    return {**status, "country": country.upper(),
            "indicators": macro_cache.indicators(country)}


class MacroRefreshRequest(BaseModel):
    what: Literal["all", "calendar", "indicators"] = "all"
    start: str = "2015-01-01"
    end: str | None = None


def _new_job_id() -> str:
    return uuid.uuid4().hex[:12]


def _enqueue_job(job_id: str, req: MacroRefreshRequest) -> None:
    """Create the in-memory job record if no macro refresh is already running.

    Split out so the scheduled-task scheduler can reuse the same worker path
    without going through the HTTP router.
    """
    job = {
        "job_id": job_id, "status": "running", "started_at": _now(),
        "finished_at": None, "params": req.model_dump(),
        "progress": {"stage": "queued", "message": "Waiting for a worker",
                     "done": 0, "total": 0},
        "summary": None, "error": None,
    }
    with _jobs_lock:
        if any(j["status"] == "running" for j in _JOBS.values()):
            raise RuntimeError("A macro refresh is already running.")
        _JOBS[job_id] = job


@router.post("/macro/refresh")
def start_macro_refresh(
    req: MacroRefreshRequest,
    _admin: Principal = Depends(require_org_admin),
) -> dict:
    # Admin-gated: rewrites the shared macro parquet cache under webapp/data.
    settings = get_settings()
    if not settings.eodhd_api_key:
        raise HTTPException(
            status_code=400,
            detail="EODHD_API_KEY is not set — add it to webapp/.env and restart the API.",
        )

    job_id = _new_job_id()
    try:
        _enqueue_job(job_id, req)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None

    _executor.submit(_run_refresh, job_id, req)
    return {"status": "started", "job_id": job_id}


def _run_refresh(job_id: str, req: MacroRefreshRequest) -> None:
    """Worker-thread body. Never raises — failures land in the job record."""
    from webapp.ingest.eodhd import EodhdError, IngestProgress, run_macro_refresh

    settings = get_settings()

    def on_progress(p: IngestProgress) -> None:
        with _jobs_lock:
            _JOBS[job_id]["progress"] = p.as_dict()

    try:
        summary = run_macro_refresh(
            settings.eodhd_api_key, settings.macro_dir,
            start=req.start, end=req.end, what=req.what,
            event_countries=settings.event_countries,
            indicator_countries=settings.indicator_countries,
            on_progress=on_progress,
        )
    except EodhdError as exc:
        _finish(job_id, error=str(exc))
        return
    except Exception as exc:  # noqa: BLE001 - a crashed thread must still report
        logger.exception("macro refresh %s failed", job_id)
        _finish(job_id, error=f"{type(exc).__name__}: {exc}")
        return

    # The read paths are mtime-cached; drop them so the next GET sees new
    # files. The regime states are derived from both, so they go too —
    # otherwise a refresh lands new CPI prints and the desk keeps serving the
    # old quadrant until the process restarts.
    macro_cache.reset_cache()
    macro.reset_cache()
    macro_regime.reset_cache()
    _finish(job_id, summary=summary)


def _finish(job_id: str, *, summary: dict | None = None, error: str | None = None) -> None:
    with _jobs_lock:
        job = _JOBS[job_id]
        job.update(status="error" if error else "done", finished_at=_now(),
                   summary=summary, error=error)
        if error:
            job["progress"] = {**job["progress"], "stage": "error", "message": error}


def _get_job(job_id: str) -> dict:
    with _jobs_lock:
        job = _JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Unknown job '{job_id}'")
        return dict(job)


@router.get("/macro/refresh/{job_id}")
def macro_refresh_job(job_id: str) -> dict:
    return _get_job(job_id)


@router.get("/macro/refresh/{job_id}/stream")
async def macro_refresh_stream(job_id: str) -> StreamingResponse:
    _get_job(job_id)  # 404 before opening the stream, not inside it

    async def events() -> AsyncIterator[str]:
        last: str | None = None
        while True:
            job = _get_job(job_id)
            payload = json.dumps(job)
            if payload != last:
                yield f"data: {payload}\n\n"
                last = payload
            if job["status"] != "running":
                return
            await asyncio.sleep(1.0)

    return StreamingResponse(events(), media_type="text/event-stream")


# --------------------------------------------------------------------------
# Regime
# --------------------------------------------------------------------------
@router.get("/macro/regime")
def macro_regime_read(
    country: str = "US",
    inflation: Literal["headline", "core"] = "headline",
) -> dict:
    """What regime we are in, across four lenses.

    **Always 200.** A cold calendar is ``available: false`` with a reason at the
    top and a per-lens reason underneath, matching ``/macro/calendar`` — a desk
    tile that 404s on a cold cache reads as "this desk does not do regimes".
    """
    return _payload(macro_regime.current_regime(inflation=inflation, country=country))


@router.get("/macro/regime/history")
def macro_regime_history(
    months: int = Query(24, ge=1, le=120),
    country: str = "US",
    inflation: Literal["headline", "core"] = "headline",
) -> dict:
    """Month-end state of every lens, oldest first.

    ``month`` is ``YYYY-MM``. The UI's year label keys on a January suffix, and
    a ``YYYY-MM-01`` serialisation would make that test true for every month.
    """
    rows = macro_regime.regime_history(months, inflation=inflation, country=country)
    return {
        "months": _payload(rows),
        "available": bool(rows),
        "reason": None if rows else (
            "No regime history yet — the economic calendar and the macro market "
            "store are both empty. Run POST /api/macro/refresh."
        ),
    }


@router.get("/macro/regime/playbook")
def macro_regime_playbook(
    lens: Literal["quadrant", "rate_cycle", "risk", "market"] = "quadrant",
    min_days: int = Query(60, ge=1, le=2000),
    min_episodes: int = Query(3, ge=1, le=50),
) -> dict:
    """What each asset has historically paid in each state of a lens.

    409 when the lens exists but nothing in the window could be classified —
    the same "exists but not computable" convention as ``/runs/{id}/report``.
    """
    try:
        return _payload(macro_regime.regime_asset_performance(
            lens=lens, min_days=min_days, min_episodes=min_episodes,
        ))
    except MacroAnalyticsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/macro/regime/lenses")
def macro_regime_lenses() -> dict:
    """The playbook lenses, so the UI does not hardcode the list."""
    return {"lenses": [
        {"key": spec.key, "label": spec.label, "caveat": spec.caveat,
         "states": [{"state": s, "label": spec.labels.get(s, s)} for s in spec.order]}
        for spec in macro_regime.LENSES.values()
    ]}


# --------------------------------------------------------------------------
# Linkage
# --------------------------------------------------------------------------
def _returns_for(principal: Principal, kind: Subject, subject_id: str,
                 curve: str) -> tuple[pd.Series, dict]:
    """Daily returns for a strategy, run or portfolio, plus a subject echo.

    A strategy resolves to its most recent succeeded run: macro linkage is
    measured from realised daily returns, so a strategy that has never run has
    nothing to measure and says so as a 409 rather than an empty chart.
    """
    from .. import results
    # The runs router owns the process's RunManager. A second instance would
    # keep its own in-memory cache of run records and the two would drift.
    from .runs import _runs as runs

    settings = get_settings()

    if kind == "portfolio":
        from .. import portfolio_nav
        from ..repositories import PortfolioRepo

        stored = PortfolioRepo(principal).get(subject_id)
        if stored is None:
            raise HTTPException(status_code=404, detail=f"Unknown portfolio '{subject_id}'")
        try:
            report = portfolio_nav.build_nav(
                stored, portfolio_id=stored.id, updated_at=stored.updated_at
            )
        except portfolio_nav.NavError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        returns = macro_analytics.strategy_returns(report, curve="nav")
        return returns, {"kind": kind, "id": stored.id, "name": stored.name,
                         "run_id": None}

    if kind == "run":
        run = runs.get(principal, subject_id)
        if run is None:
            raise HTTPException(status_code=404, detail=f"Unknown run '{subject_id}'")
        meta = run.meta
    else:
        from ..repositories import StrategyRepo

        stored = StrategyRepo(principal).get(subject_id)
        if stored is None:
            raise HTTPException(status_code=404, detail=f"Unknown strategy '{subject_id}'")
        # `list` returns metadata dicts. The generous limit matters here: the
        # default of 100 would start hiding a strategy's only successful run
        # once the runs directory fills up.
        candidates = [
            m for m in runs.list(principal, limit=1000)
            if m.get("strategy_id") == subject_id and m.get("status") == "succeeded"
        ]
        if not candidates:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"'{stored.name}' has no completed run. Macro linkage is measured "
                    "from a run's daily returns, so there is nothing to measure yet."
                ),
            )
        meta = max(candidates, key=lambda m: m.get("created_at") or "")

    if meta.get("status") != "succeeded":
        raise HTTPException(
            status_code=409,
            detail=f"Run {meta['id']} is {meta.get('status')}, so it has no returns yet.",
        )
    # Reading MLflow artifacts needs qlib's global config. Startup initialises
    # it best-effort, so a store that only became available later would
    # otherwise make every finished run look like it recorded nothing.
    from .. import qlib_session

    qlib_session.init_qlib()
    report = results.build_report(
        results.resolve_experiment(meta["id"], meta.get("experiment_name"))
    )
    if not report:
        raise HTTPException(
            status_code=409, detail=f"Run {meta['id']} recorded no results."
        )
    returns = macro_analytics.strategy_returns(report, curve=curve)
    return returns, {"kind": kind, "id": subject_id,
                     "name": meta.get("name") or subject_id, "run_id": meta["id"]}


def _window(returns: pd.Series) -> dict:
    return {
        "start": returns.index[0].strftime("%Y-%m-%d"),
        "end": returns.index[-1].strftime("%Y-%m-%d"),
        "days": int(len(returns)),
    }


@router.get("/macro/linkage")
def macro_linkage(
    kind: Subject,
    id: str,
    curve: str = "strategy",
    max_lag: int = Query(0, ge=0, le=10),
    cov: Literal["hac", "ols"] = "hac",
    event_type: str = "",
    country: str = "US",
    principal: Principal = Depends(get_principal),
) -> dict:
    """Everything the linkage panel needs, in one call.

    Each analytic is attempted independently: a window too short for a
    seven-factor regression can still support a correlation ranking, and
    reporting three panels plus one honest refusal beats refusing all four.
    """
    returns, subject = _returns_for(principal, kind, id, curve)
    out: dict = {"subject": subject, "window": _window(returns),
                 "run_id": subject.get("run_id"), "curve": curve, "notes": {}}

    for name, thunk in (
        ("drivers", lambda: [_payload(d) for d in
                             macro_analytics.drivers(returns, max_lag=max_lag)]),
        ("betas", lambda: _payload(macro_analytics.factor_betas(returns, cov=cov))),
        ("regimes", lambda: _payload(macro_analytics.regimes(returns))),
    ):
        try:
            out[name] = thunk()
        except MacroAnalyticsError as exc:
            out[name] = [] if name == "drivers" else None
            out["notes"][name] = str(exc)

    out["events"] = _event_summary(returns, country, event_type, out["notes"])
    return out


#: The releases a macro desk actually watches, most-watched first.
#:
#: Ranking candidates by frequency alone fills the panel with 4-week bill
#: auctions, rig counts and jobless claims -- the highest-count series in the
#: feed and the least interesting. These are tried first; frequency only breaks
#: ties and backfills the remainder.
HEADLINE_EVENTS: tuple[str, ...] = (
    "inflation_rate__yoy", "core_inflation_rate__yoy", "core_inflation_rate__mom",
    "non_farm_payrolls", "unemployment_rate",
    "pce_price_index__yoy", "core_pce_price_index__yoy",
    "gdp_growth_rate__qoq", "retail_sales__yoy", "core_ppi__yoy",
    "ism_manufacturing_pmi", "cb_consumer_confidence",
    "michigan_consumer_sentiment", "michigan_inflation_expectations",
    "fed_interest_rate_decision", "initial_jobless_claims",
)


def _importance(event_key: str | None) -> str:
    """Two tiers for now; EODHD supplies no importance so membership in the
    desk's own headline list is the honest proxy."""
    return "headline" if event_key in HEADLINE_EVENTS else "standard"


def _event_candidates(country: str, limit: int = 12) -> list[dict]:
    available = macro_cache.event_types(country)
    by_key = {row["event_key"]: row for row in available}
    ordered = [by_key[k] for k in HEADLINE_EVENTS if k in by_key]
    seen = {r["event_key"] for r in ordered}
    ordered.extend(r for r in available if r["event_key"] not in seen)
    return ordered[:limit]


def _event_summary(returns: pd.Series, country: str, event_type: str,
                   notes: dict) -> list[dict]:
    """A short table of the releases this window can actually support.

    Only types with enough dated observations inside the window are studied;
    the rest are simply absent, because a row saying "n=3" invites a reading
    the data cannot carry.
    """
    if not macro_cache.calendar_status()["available"]:
        notes["events"] = "no economic calendar cached — run POST /api/macro/refresh"
        return []

    wanted = ([{"event_key": event_type}] if event_type
              else _event_candidates(country))
    out = []
    for row in wanted:
        key = row["event_key"]
        dates = macro_cache.release_dates(key, country)
        if not dates:
            continue
        try:
            study = macro_analytics.event_study(
                returns, dates, event_type=key, country=country, pre=3, post=3
            )
        except MacroAnalyticsError:
            continue
        out.append({
            "event_key": key,
            "type": row.get("type") or key,
            "country": country,
            "n": study.n_events,
            "car_0_1": _clean(study.headline["car"]),
            "t": _clean(study.headline["t"]),
            "p": _clean(study.headline["p"]),
            "hit_rate": _clean(study.headline["hit_rate"]),
        })
    out.sort(key=lambda r: -abs(r["t"] or 0.0))
    return out


def _primitive(principal: Principal, kind: Subject, subject_id: str,
               curve: str, fn) -> dict:
    returns, subject = _returns_for(principal, kind, subject_id, curve)
    try:
        return {"subject": subject, "window": _window(returns), "result": fn(returns)}
    except MacroAnalyticsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/macro/{kind}/{subject_id}/drivers")
def linkage_drivers(kind: Subject, subject_id: str, curve: str = "strategy",
                    max_lag: int = Query(0, ge=0, le=10),
                    principal: Principal = Depends(get_principal)) -> dict:
    return _primitive(principal, kind, subject_id, curve, lambda r: [
        _payload(d) for d in macro_analytics.drivers(r, max_lag=max_lag)
    ])


@router.get("/macro/{kind}/{subject_id}/betas")
def linkage_betas(kind: Subject, subject_id: str, curve: str = "strategy",
                  cov: Literal["hac", "ols"] = "hac",
                  keys: str = "",
                  principal: Principal = Depends(get_principal)) -> dict:
    selected = [k.strip().upper() for k in keys.split(",") if k.strip()] or None
    return _primitive(principal, kind, subject_id, curve, lambda r: _payload(
        macro_analytics.factor_betas(r, keys=selected, cov=cov)
    ))


@router.get("/macro/{kind}/{subject_id}/regimes")
def linkage_regimes(kind: Subject, subject_id: str, curve: str = "strategy",
                    rates: str = "US2Y", vol: str = "VIX",
                    momentum: int = Query(60, ge=5, le=252),
                    lookback: int = Query(756, ge=252, le=2520),
                    principal: Principal = Depends(get_principal)) -> dict:
    return _primitive(principal, kind, subject_id, curve, lambda r: _payload(
        macro_analytics.regimes(r, rates_key=rates, vol_key=vol,
                                momentum=momentum, lookback=lookback)
    ))


@router.get("/macro/{kind}/{subject_id}/event-study")
def linkage_event_study(kind: Subject, subject_id: str, event_type: str,
                        curve: str = "strategy", country: str = "US",
                        pre: int = Query(5, ge=0, le=20),
                        post: int = Query(5, ge=1, le=20),
                        principal: Principal = Depends(get_principal)) -> dict:
    dates = macro_cache.release_dates(event_type, country)
    if not dates:
        raise HTTPException(
            status_code=404,
            detail=f"No cached releases of '{event_type}' for {country}",
        )
    return _primitive(principal, kind, subject_id, curve, lambda r: _payload(
        macro_analytics.event_study(r, dates, event_type=event_type,
                                    country=country, pre=pre, post=post)
    ))
