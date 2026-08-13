"""Agenda-specific endpoints: AI-generated outlooks and per-user state.

Outlooks are cached per (user, scope, date) so the page loads instantly and
LLM calls are batched by scope window rather than by page view. A missing or
expired cache triggers a fresh generation; ?force=1 bypasses the cache explicitly.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from ..agenda_outlook import OutlookScope, generate_outlook, outlook_expires_at, outlook_window
from ..auth import Principal, get_principal
from ..config import get_settings
from ..db import user_tx
from .activity import activity as activity_feed

router = APIRouter()


class OutlookResponse(BaseModel):
    summary: str
    generated_at: str
    expires_at: str
    cached: bool


@router.get("/agenda/outlook")
def agenda_outlook(
    scope: OutlookScope = Query(...),
    date: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"),
    force: bool = Query(False),
    principal: Principal = Depends(get_principal),
) -> OutlookResponse:
    settings = get_settings()
    start, end = outlook_window(scope, date)

    # Serve from cache when fresh.
    if not force and settings.database_url:
        try:
            with user_tx(principal.user_id) as cur:
                cur.execute(
                    "SELECT summary, generated_at, expires_at "
                    "FROM aion.agenda_outlook "
                    "WHERE user_id = (SELECT auth.uid()) AND scope = %s AND date = %s",
                    (scope, date),
                )
                row = cur.fetchone()
            if row and row["expires_at"] > datetime.now(timezone.utc):
                return OutlookResponse(
                    summary=row["summary"],
                    generated_at=row["generated_at"].isoformat(),
                    expires_at=row["expires_at"].isoformat(),
                    cached=True,
                )
        except Exception:  # noqa: BLE001
            # A database problem should not block generation; it just costs an LLM call.
            pass

    # Gather the same aggregate feed the Agenda page already renders.
    try:
        feed = activity_feed(limit=200, principal=principal)
        items = feed.get("items", [])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"Could not load activity feed: {exc}") from exc

    api_key = settings.openrouter_api_key or None
    summary, used_llm = generate_outlook(
        principal, items, scope, date, api_key=api_key, model=settings.openrouter_model,
    )

    generated_at = datetime.now(timezone.utc)
    expires_at = outlook_expires_at(scope, date)

    if settings.database_url:
        try:
            with user_tx(principal.user_id) as cur:
                cur.execute(
                    "INSERT INTO aion.agenda_outlook "
                    "  (user_id, scope, date, summary, generated_at, expires_at) "
                    "VALUES ((SELECT auth.uid()), %s, %s, %s, %s, %s) "
                    "ON CONFLICT (user_id, scope, date) DO UPDATE "
                    "  SET summary = EXCLUDED.summary, "
                    "      generated_at = EXCLUDED.generated_at, "
                    "      expires_at = EXCLUDED.expires_at",
                    (scope, date, summary, generated_at, expires_at),
                )
        except Exception:  # noqa: BLE001
            # Cache failure is not fatal; the caller still gets the summary.
            logger = __import__("logging").getLogger(__name__)
            logger.warning("failed to cache agenda outlook", exc_info=True)

    return OutlookResponse(
        summary=summary,
        generated_at=generated_at.isoformat(),
        expires_at=expires_at.isoformat(),
        cached=False,
    )
