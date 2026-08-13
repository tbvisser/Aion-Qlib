"""AI-generated agenda outlooks for day, week and month horizons.

The router keeps HTTP concerns; this module owns the date arithmetic, context
gathering, prompt building, LLM call and fallback summary so each piece can be
unit-tested without a running API.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Literal

import httpx
import pandas as pd

from . import macro_cache, macro_regime, qlib_session
from .config import get_settings
from .portfolio_nav import build_nav as build_portfolio_nav
from .repositories import PortfolioRepo
from .results import prediction_sample, resolve_experiment

logger = logging.getLogger(__name__)

OutlookScope = Literal["day", "week", "month"]

# ---------------------------------------------------------------------------
# Date ranges
# ---------------------------------------------------------------------------

def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _month_end(month: str) -> str:
    y, m = map(int, month.split("-"))
    nxt = (datetime(y, m, 1) + timedelta(days=32)).replace(day=1)
    return (nxt - timedelta(days=1)).strftime("%Y-%m-%d")


def outlook_window(scope: OutlookScope, anchor: str) -> tuple[str, str]:
    """Inclusive ISO date span for an outlook scope anchored on a day."""
    if scope == "day":
        return anchor, anchor
    if scope == "week":
        dt = pd.Timestamp(anchor)
        monday = dt - pd.Timedelta(days=int(dt.dayofweek))
        sunday = monday + pd.Timedelta(days=6)
        return monday.strftime("%Y-%m-%d"), sunday.strftime("%Y-%m-%d")
    # month
    month = anchor[:7]
    return f"{month}-01", _month_end(month)


def outlook_expires_at(scope: OutlookScope, anchor: str) -> datetime:
    """UTC timestamp when the cached outlook for this scope/anchor expires.

    The cache is valid until the end of the natural window so a daily/weekly/
    monthly outlook is regenerated at most once per period, not every time the
    page is opened.
    """
    _, end = outlook_window(scope, anchor)
    return datetime.fromisoformat(f"{end}T23:59:59+00:00")


# ---------------------------------------------------------------------------
# Context gathering
# ---------------------------------------------------------------------------

def _release_context(start: str, end: str) -> dict:
    status = macro_cache.calendar_status()
    if not status.get("available"):
        return {"available": False, "reason": status.get("reason"), "events": []}
    rows = macro_cache.releases(start, end, country="US", limit=500)
    events = []
    for r in rows:
        events.append({
            "date": r["date"],
            "time": r.get("time"),
            "country": r.get("country"),
            "type": r.get("type"),
            "importance": r.get("importance", "standard"),
            "estimate": r.get("estimate"),
            "previous": r.get("previous"),
            "actual": r.get("actual"),
        })
    return {
        "available": True,
        "stale": status.get("stale", False),
        "events": events,
    }


def _activity_context(items: list[dict], start: str, end: str) -> dict:
    def in_window(item: dict) -> bool:
        stamp = item.get("finished_at") or item.get("started_at") or item.get("created_at")
        if not stamp:
            return False
        day = stamp[:10]
        return start <= day <= end

    terminal = [i for i in items if i.get("status") in ("succeeded", "failed") and in_window(i)]
    runs = [i for i in terminal if i.get("kind") == "run"]
    jobs = [i for i in terminal if i.get("kind") != "run"]
    return {
        "runs": [
            {"title": i.get("title"), "status": i.get("status"), "finished_at": i.get("finished_at")}
            for i in runs[:10]
        ],
        "jobs": [
            {"title": i.get("title"), "status": i.get("status"), "finished_at": i.get("finished_at")}
            for i in jobs[:10]
        ],
        "failed_count": sum(1 for i in terminal if i.get("status") == "failed"),
    }


def _rebalance_context(principal, start: str, end: str) -> list[dict]:
    try:
        books = PortfolioRepo(principal).list()
    except Exception:  # noqa: BLE001
        logger.exception("failed to list portfolios for outlook")
        return []

    out = []
    for book in books:
        if book.rebalance == "none":
            continue
        try:
            nav = build_portfolio_nav(book, portfolio_id=book.id, updated_at=book.updated_at)
            events = [
                {"date": e["date"], "turnover": e.get("turnover")}
                for e in nav.get("rebalances", [])
                if start <= e["date"] <= end
            ]
            if events:
                out.append({"name": book.name, "events": events})
        except Exception:  # noqa: BLE001
            # One unpriceable book should not hide the rest.
            continue
    return out


def _signal_context(items: list[dict]) -> list[dict]:
    """Top predictions from the most recent succeeded runs, capped for brevity."""
    try:
        qlib_session.require_qlib()
    except Exception:  # noqa: BLE001
        return []

    runs = [
        i for i in items
        if i.get("kind") == "run" and i.get("status") == "succeeded" and i.get("finished_at")
    ]
    runs.sort(key=lambda i: i.get("finished_at") or "", reverse=True)

    out = []
    for run in runs[:3]:
        run_id = run.get("source_id") or run.get("id", "").removeprefix("run:")
        if not run_id:
            continue
        try:
            experiment = resolve_experiment(run_id, run.get("experiment_name"))
            sample = prediction_sample(experiment, limit=5)
            if sample and sample.get("top"):
                out.append({
                    "run": run.get("title"),
                    "date": sample.get("date"),
                    "top": [t["instrument"] for t in sample["top"][:5]],
                })
        except Exception:  # noqa: BLE001
            continue
    return out


def _regime_context() -> dict:
    try:
        current = macro_regime.current_regime(inflation="headline", country="US")
        return {
            "available": current.get("available", False),
            "lenses": [
                {"lens": l.get("lens"), "state": l.get("state"), "label": l.get("label")}
                for l in current.get("lenses", [])
            ],
        }
    except Exception:  # noqa: BLE001
        logger.exception("failed to read regime context")
        return {"available": False, "lenses": []}


# ---------------------------------------------------------------------------
# Prompt and fallback
# ---------------------------------------------------------------------------

def _prompt(context: dict, scope: OutlookScope, start: str, end: str) -> str:
    n_events = len(context["calendar"]["events"])
    event_text = json.dumps(context["calendar"], indent=2) if n_events <= 50 else json.dumps({
        "available": context["calendar"]["available"],
        "stale": context["calendar"].get("stale"),
        "headline_events": [e for e in context["calendar"]["events"] if e["importance"] == "headline"],
        "event_count": n_events,
    }, indent=2)

    return (
        f"You are a concise macro/trading research assistant. Write a brief outlook "
        f"for the {scope} of {start} to {end} based on the data below.\n\n"
        "Rules:\n"
        "- Keep it to 3-5 short bullets.\n"
        "- Lead with the most actionable item.\n"
        "- Mention specific prints, tickers or runs only when the data names them.\n"
        "- Do not invent numbers or events.\n"
        "- If the calendar is empty, say there is little scheduled and flag any running jobs or rebalances instead.\n"
        "- Use plain Markdown: bullets, bold for emphasis, no tables.\n\n"
        f"US economic calendar:\n{event_text}\n\n"
        f"Finished work in window:\n{json.dumps(context['activity'], indent=2)}\n\n"
        f"Portfolio rebalances in window:\n{json.dumps(context['rebalances'], indent=2)}\n\n"
        f"Latest model signals:\n{json.dumps(context['signals'], indent=2)}\n\n"
        f"Current macro regime:\n{json.dumps(context['regime'], indent=2)}\n\n"
        "Write the outlook now."
    )


def _fallback_summary(context: dict, scope: OutlookScope, start: str, end: str) -> str:
    parts = [f"**{scope.capitalize()} outlook ({start} – {end})**"]
    cal = context["calendar"]
    if not cal.get("available"):
        parts.append("- The economic calendar is not cached yet, so macro events are unavailable.")
    else:
        events = cal.get("events", [])
        headlines = [e for e in events if e["importance"] == "headline"]
        if headlines:
            names = ", ".join(sorted({e["type"] for e in headlines}))
            parts.append(f"- **{len(headlines)} headline release(s)** on the calendar: {names}.")
        elif events:
            parts.append(f"- **{len(events)} release(s)** scheduled, none marked headline.")
        else:
            parts.append("- No releases scheduled in this window.")

    act = context["activity"]
    if act.get("runs") or act.get("jobs"):
        parts.append(f"- **{len(act['runs'])} run(s)** and **{len(act['jobs'])} job(s)** finished recently.")
    if act.get("failed_count"):
        parts.append(f"- **{act['failed_count']} failed** — check the activity feed.")

    if context["rebalances"]:
        total = sum(len(b["events"]) for b in context["rebalances"])
        parts.append(f"- **{total} portfolio rebalance(s)** due.")

    if context["signals"]:
        parts.append(f"- **{len(context['signals'])} recent signal run(s)** with top picks.")

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# LLM call
# ---------------------------------------------------------------------------

def _call_openrouter(prompt: str, model: str | None, api_key: str) -> str:
    settings = get_settings()
    model = model or settings.openrouter_model
    url = settings.openrouter_base_url.rstrip("/") + "/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:5274",
        "X-Title": "AION",
    }
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You are a terse trading-desk assistant."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.4,
        "max_tokens": 800,
    }
    with httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
        resp = client.post(url, headers=headers, json=body)
        resp.raise_for_status()
        data = resp.json()
        choices = data.get("choices") or [{}]
        content = choices[0].get("message", {}).get("content", "")
        if not content.strip():
            raise ValueError("empty model response")
        return content.strip()


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def build_context(principal, items: list[dict], start: str, end: str) -> dict:
    """Gather everything the prompt needs from existing feeds."""
    return {
        "calendar": _release_context(start, end),
        "activity": _activity_context(items, start, end),
        "rebalances": _rebalance_context(principal, start, end),
        "signals": _signal_context(items),
        "regime": _regime_context(),
    }


def generate_outlook(
    principal,
    items: list[dict],
    scope: OutlookScope,
    anchor: str,
    api_key: str | None = None,
    model: str | None = None,
) -> tuple[str, bool]:
    """Return (markdown_summary, used_llm). Falls back to a data summary on error."""
    start, end = outlook_window(scope, anchor)
    context = build_context(principal, items, start, end)

    if not api_key:
        return _fallback_summary(context, scope, start, end), False

    prompt = _prompt(context, scope, start, end)
    try:
        summary = _call_openrouter(prompt, model, api_key)
        return summary, True
    except Exception as exc:  # noqa: BLE001
        logger.warning("agenda outlook LLM call failed: %s", exc)
        return _fallback_summary(context, scope, start, end), False
