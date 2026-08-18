"""Control plane for the venue scalability tool.

This router is deliberately thin: it accepts trade-file uploads, enqueues rows
in ``aion.scalability_jobs``, and serves the reports the scalability agent
writes back. It never parses a trade file or runs the ceiling calculation
itself -- that is the agent's job (top-level ``scalability_agent/`` package),
which is the whole reason the analysis runs with no inbound HTTP surface and
no competition with this API for the machine.

The one piece of business logic that must live here and nowhere else is the
consent gate: ``aion.scalability_bookings.report_shared_at`` is set by the
booking endpoint below, and by no other code path. Until a fund completes a
booking, its report is never marked shared with a venue.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..auth import Principal, get_principal
from ..db import service_tx, user_tx
from ..supabase_storage import create_signed_url, upload_bytes

router = APIRouter()

# Private bucket the raw uploads and the rendered report artifacts share. The
# agent reads uploads and writes artifacts here with its own service role.
UPLOAD_BUCKET = "scalability-uploads"


class AnalysisRequest(BaseModel):
    upload_id: str
    # None means "compare against every venue in the catalog".
    candidate_venues: list[str] | None = None


class BookingRequest(BaseModel):
    venue: str


def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    """Make a psycopg dict_row JSON-safe: uuids and datetimes to strings."""
    out: dict[str, Any] = {}
    for key, value in row.items():
        if isinstance(value, uuid.UUID):
            out[key] = str(value)
        elif isinstance(value, datetime):
            out[key] = value.isoformat()
        else:
            out[key] = value
    return out


def _candidate_venues(result: dict[str, Any]) -> list[str]:
    """Venue names the report ranked as candidates.

    Reads the engine's result shape -- ``result["comparison"]["alternatives"]``
    is a list of per-venue dicts keyed by ``"venue"`` -- and nothing else, so
    a venue the engine never evaluated cannot be booked (and therefore cannot
    receive a shared report) by naming it here.
    """
    comparison = result.get("comparison") or {}
    candidates = comparison.get("alternatives") or []
    return [c["venue"] for c in candidates if isinstance(c, dict) and c.get("venue")]


# Raw body + filename query param rather than multipart: the qlib image ships
# no python-multipart (same constraint as routers/vibe.py's journal upload),
# and one file with one name doesn't need form framing.
@router.post("/scalability/uploads")
async def create_upload(
    request: Request,
    filename: str,
    principal: Principal = Depends(get_principal),
) -> dict:
    name = Path(filename.strip()).name  # strip any client-supplied path parts
    if not name:
        raise HTTPException(status_code=400, detail="A filename is required")
    content = await request.body()
    if not content:
        raise HTTPException(status_code=400, detail="Empty upload")

    upload_id = str(uuid.uuid4())
    storage_path = f"{principal.user_id}/{upload_id}/{name}"
    try:
        upload_bytes(UPLOAD_BUCKET, storage_path, content)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    # Upload row and its parse job in one transaction: a pending upload with
    # no job would sit unparsed forever, and a job with no upload has nothing
    # to read.
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "INSERT INTO aion.scalability_uploads "
            "  (id, user_id, org_id, filename, storage_path) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING *",
            (upload_id, principal.user_id, principal.org_id, name, storage_path),
        )
        upload = cur.fetchone()
        cur.execute(
            "INSERT INTO aion.scalability_jobs "
            "  (user_id, org_id, kind, upload_id) "
            "VALUES (%s, %s, 'parse_upload', %s) RETURNING id",
            (principal.user_id, principal.org_id, upload_id),
        )
        job_id = str(cur.fetchone()["id"])
    return {"upload": _serialize(upload), "job_id": job_id}


@router.get("/scalability/uploads")
def list_uploads(principal: Principal = Depends(get_principal)) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "SELECT * FROM aion.scalability_uploads ORDER BY created_at DESC"
        )
        rows = cur.fetchall()
    return {"uploads": [_serialize(r) for r in rows]}


@router.get("/scalability/uploads/{upload_id}")
def get_upload(
    upload_id: str,
    principal: Principal = Depends(get_principal),
) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "SELECT * FROM aion.scalability_uploads WHERE id = %s", (upload_id,)
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No such upload")
    return _serialize(row)


@router.post("/scalability/analyses")
def create_analysis(
    req: AnalysisRequest,
    principal: Principal = Depends(get_principal),
) -> dict:
    with user_tx(principal.user_id) as cur:
        # RLS scopes this to the caller, so a foreign upload id reads as 404,
        # not as a permission error that would confirm the id exists.
        cur.execute(
            "SELECT status FROM aion.scalability_uploads WHERE id = %s",
            (req.upload_id,),
        )
        upload = cur.fetchone()
        if upload is None:
            raise HTTPException(status_code=404, detail="No such upload")
        if upload["status"] != "parsed":
            raise HTTPException(
                status_code=409,
                detail=f"Upload is not parsed yet (status: {upload['status']})",
            )
        cur.execute(
            "INSERT INTO aion.scalability_jobs "
            "  (user_id, org_id, kind, upload_id, params) "
            "VALUES (%s, %s, 'analyze', %s, %s) RETURNING id",
            (
                principal.user_id,
                principal.org_id,
                req.upload_id,
                json.dumps({"candidate_venues": req.candidate_venues}),
            ),
        )
        job_id = str(cur.fetchone()["id"])
    return {"job_id": job_id}


@router.get("/scalability/jobs/{job_id}")
def get_job(
    job_id: str,
    principal: Principal = Depends(get_principal),
) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "SELECT id, kind, status, upload_id, report_id, attempts, error, "
            "       created_at, updated_at "
            "FROM aion.scalability_jobs WHERE id = %s",
            (job_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No such job")
    return _serialize(row)


@router.get("/scalability/reports")
def list_reports(principal: Principal = Depends(get_principal)) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "SELECT * FROM aion.scalability_reports ORDER BY created_at DESC"
        )
        rows = cur.fetchall()
    return {"reports": [_serialize(r) for r in rows]}


@router.get("/scalability/reports/{report_id}")
def get_report(
    report_id: str,
    principal: Principal = Depends(get_principal),
) -> dict:
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "SELECT * FROM aion.scalability_reports WHERE id = %s", (report_id,)
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No such report")
    report = _serialize(row)
    if row["artifact_path"]:
        try:
            report["artifact_url"] = create_signed_url(
                UPLOAD_BUCKET, row["artifact_path"]
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    return report


class BookingError(Exception):
    """Booking rejected; the message is safe to show the caller."""


def book_consultation_for(principal: Principal, report_id: str, venue: str) -> dict:
    """Book a consultation and mark the report shared with the venue.

    CONSENT GATE: this is the only code path that sets
    scalability_bookings.report_shared_at. A non-NULL value is the fund's
    recorded consent to share this report with the venue, and any future
    forwarding must require it. Actually emailing the report to the venue is
    deliberately out of scope here -- the booking_link below takes the fund
    to the venue's own scheduling page instead.

    Shared by the REST endpoint below and the chat assistant's
    ``book_venue_consultation`` tool, so the gate is enforced in exactly one
    place (PRD M8). Raises BookingError with a user-safe message on rejection.
    """
    # Ownership is checked under the caller's own RLS context first; only then
    # does the write below bypass RLS.
    with user_tx(principal.user_id) as cur:
        cur.execute(
            "SELECT result FROM aion.scalability_reports WHERE id = %s",
            (report_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise BookingError("No such report")

    eligible = _candidate_venues(row["result"] or {})
    if venue not in eligible:
        raise BookingError(f"{venue!r} is not a candidate venue in this report")

    booking_id = str(uuid.uuid4())
    with service_tx() as cur:
        cur.execute(
            "INSERT INTO aion.scalability_bookings "
            "  (id, user_id, org_id, report_id, venue, report_shared_at) "
            "VALUES (%s, %s, %s, %s, %s, now()) RETURNING *",
            (booking_id, principal.user_id, principal.org_id, report_id, venue),
        )
        booking = cur.fetchone()
        cur.execute(
            "SELECT profile FROM aion.venue_catalog WHERE venue = %s "
            "ORDER BY version DESC LIMIT 1",
            (venue,),
        )
        catalog_row = cur.fetchone()
    booking_link = (catalog_row["profile"] or {}).get("booking_link") if catalog_row else None
    return {"booking": booking, "booking_link": booking_link}


@router.post("/scalability/reports/{report_id}/book")
def book_consultation(
    report_id: str,
    req: BookingRequest,
    principal: Principal = Depends(get_principal),
) -> dict:
    try:
        out = book_consultation_for(principal, report_id, req.venue)
    except BookingError as exc:
        status = 404 if "No such report" in str(exc) else 400
        raise HTTPException(status_code=status, detail=str(exc)) from None
    return {"booking": _serialize(out["booking"]), "booking_link": out["booking_link"]}
