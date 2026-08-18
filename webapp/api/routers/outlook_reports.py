"""Download endpoints for scheduled outlook PDF reports."""
from __future__ import annotations

import io

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from ..auth import Principal, get_principal
from ..outlook_report import (
    download_outlook_report as _download_outlook_report,
    render_demo_outlook_pdf,
)

router = APIRouter()


@router.get("/outlook-reports/demo/download")
def download_demo_outlook_report(
    principal: Principal = Depends(get_principal),
) -> StreamingResponse:
    """Stream a freshly generated Aion-branded demo outlook PDF."""
    try:
        data, _pages = render_demo_outlook_pdf(principal)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=aion-demo-outlook.pdf"},
    )


@router.get("/outlook-reports/{report_id}/download")
def download_outlook_report(
    report_id: str,
    principal: Principal = Depends(get_principal),
) -> StreamingResponse:
    """Stream the caller's PDF report directly from Supabase Storage."""
    try:
        data, filename = _download_outlook_report(report_id, principal)
    except PermissionError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
