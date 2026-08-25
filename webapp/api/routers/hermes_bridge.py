"""Hermes → Aion internal bridge (shared secret, no Supabase session)."""
from __future__ import annotations

import json
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from ..config import Settings, get_settings
from ..db import user_tx
from ..scheduler_spec import ScheduledTaskSpec, next_run

router = APIRouter()


class HermesScheduledBridgeRequest(BaseModel):
    user_id: str = Field(..., min_length=8)
    org_id: str = Field(..., min_length=8)
    spec: ScheduledTaskSpec


def _require_bridge_token(
    settings: Settings,
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    expected = (settings.hermes_bridge_token or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="HERMES_BRIDGE_TOKEN is not configured")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bridge Bearer token")
    if authorization[7:].strip() != expected:
        raise HTTPException(status_code=401, detail="Invalid bridge Bearer token")


@router.post("/hermes/bridge/scheduled-tasks")
def hermes_scheduled_bridge(
    body: HermesScheduledBridgeRequest,
    settings: Settings = Depends(get_settings),
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    """Hermes cron → ``aion.scheduled_tasks`` without duplicating the scheduler."""
    _require_bridge_token(settings, authorization)

    spec = body.spec
    if spec.kind in ("macro_refresh", "data_refresh"):
        raise HTTPException(
            status_code=403,
            detail="Bridge cannot create shared data-refresh tasks; use the Aion UI.",
        )

    task_id = uuid.uuid4().hex[:12]
    nxt = next_run(spec.schedule) if spec.enabled else None
    with user_tx(body.user_id) as cur:
        cur.execute(
            "SELECT 1 FROM public.org_members WHERE user_id = %s AND org_id = %s",
            (body.user_id, body.org_id),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=400, detail="user_id is not a member of org_id")
        cur.execute(
            "INSERT INTO aion.scheduled_tasks "
            "  (id, org_id, user_id, name, kind, enabled, schedule, params, next_run) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::timestamptz) "
            "RETURNING id",
            (
                task_id,
                body.org_id,
                body.user_id,
                spec.name,
                spec.kind,
                spec.enabled,
                json.dumps(spec.schedule.model_dump()),
                json.dumps(spec.params),
                nxt,
            ),
        )
    return {"id": task_id, "next_run": nxt.isoformat() if nxt else None}
