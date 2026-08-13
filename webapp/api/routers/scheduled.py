"""CRUD for scheduled tasks and the hooks the scheduler reads them through."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..auth import Principal, get_principal, require_org_admin
from ..db import service_tx, user_tx
from ..scheduler import get_scheduler
from ..scheduler_spec import (
    Schedule,
    ScheduledTaskSpec,
    cadence_label,
    next_run,
)

router = APIRouter()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _row_to_dict(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "org_id": str(row["org_id"]),
        "user_id": str(row["user_id"]),
        "visibility": row["visibility"],
        "name": row["name"],
        "kind": row["kind"],
        "enabled": row["enabled"],
        "schedule": row["schedule"],
        "params": row["params"] or {},
        "next_run": row["next_run"].isoformat() if row["next_run"] else None,
        "last_run": row["last_run"].isoformat() if row["last_run"] else None,
        "last_status": row["last_status"],
        "last_error": row["last_error"],
        "last_output_id": row.get("last_output_id"),
        "last_output_kind": row.get("last_output_kind"),
        "last_output_summary": row.get("last_output_summary"),
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
        "cadence": cadence_label(Schedule(**row["schedule"])),
    }


@router.get("/scheduled/tasks")
def list_tasks(principal: Principal = Depends(get_principal)) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "SELECT * FROM aion.scheduled_tasks ORDER BY enabled DESC, next_run NULLS LAST, created_at DESC"
        )
        rows = cur.fetchall()
    return {"tasks": [_row_to_dict(r) for r in rows]}


@router.post("/scheduled/tasks")
def create_task(
    spec: ScheduledTaskSpec,
    principal: Principal = Depends(get_principal),
) -> dict:
    if spec.kind in ("macro_refresh", "data_refresh") and not principal.is_org_admin:
        raise HTTPException(
            status_code=403,
            detail="Refreshing shared data stores is restricted to organisation admins.",
        )

    task_id = _new_id()
    nxt = next_run(spec.schedule) if spec.enabled else None
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "INSERT INTO aion.scheduled_tasks "
            "  (id, org_id, user_id, name, kind, enabled, schedule, params, next_run) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::timestamptz) "
            "RETURNING *",
            (
                task_id,
                principal.org_id,
                principal.user_id,
                spec.name,
                spec.kind,
                spec.enabled,
                json.dumps(spec.schedule.model_dump()),
                json.dumps(spec.params),
                nxt,
            ),
        )
        row = cur.fetchone()
    return _row_to_dict(row)


@router.get("/scheduled/tasks/{task_id}")
def get_task(
    task_id: str,
    principal: Principal = Depends(get_principal),
) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute("SELECT * FROM aion.scheduled_tasks WHERE id = %s", (task_id,))
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No such scheduled task")
    return _row_to_dict(row)


@router.put("/scheduled/tasks/{task_id}")
def update_task(
    task_id: str,
    spec: ScheduledTaskSpec,
    principal: Principal = Depends(get_principal),
) -> dict:
    if spec.kind in ("macro_refresh", "data_refresh") and not principal.is_org_admin:
        raise HTTPException(
            status_code=403,
            detail="Refreshing shared data stores is restricted to organisation admins.",
        )

    nxt = next_run(spec.schedule) if spec.enabled else None
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "UPDATE aion.scheduled_tasks SET "
            "  name = %s, kind = %s, enabled = %s, schedule = %s, params = %s, "
            "  next_run = %s::timestamptz, last_status = NULL, last_error = NULL, "
            "  last_output_id = NULL, last_output_kind = NULL, last_output_summary = NULL "
            "WHERE id = %s "
            "RETURNING *",
            (
                spec.name,
                spec.kind,
                spec.enabled,
                json.dumps(spec.schedule.model_dump()),
                json.dumps(spec.params),
                nxt,
                task_id,
            ),
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No such scheduled task")
    return _row_to_dict(row)


@router.delete("/scheduled/tasks/{task_id}", status_code=204)
def delete_task(
    task_id: str,
    principal: Principal = Depends(get_principal),
) -> None:
    with user_tx(principal.user_id) as cur:
        cur.execute("DELETE FROM aion.scheduled_tasks WHERE id = %s", (task_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="No such scheduled task")


class ToggleRequest(BaseModel):
    enabled: bool


@router.post("/scheduled/tasks/{task_id}/toggle")
def toggle_task(
    task_id: str,
    req: ToggleRequest,
    principal: Principal = Depends(get_principal),
) -> dict:
    enabled = req.enabled

    with user_tx(principal.user_id) as cur:
        cur.execute("SELECT schedule FROM aion.scheduled_tasks WHERE id = %s", (task_id,))
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="No such scheduled task")

        schedule = Schedule(**row["schedule"])
        nxt = next_run(schedule) if enabled else None
        cur.execute(
            "UPDATE aion.scheduled_tasks SET enabled = %s, next_run = %s::timestamptz "
            "WHERE id = %s RETURNING *",
            (enabled, nxt, task_id),
        )
        row = cur.fetchone()
    return _row_to_dict(row)
