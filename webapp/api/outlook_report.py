"""Generate an Aion-branded PDF outlook report for a scheduled task.

The PDF reuses the same context and LLM summary the Agenda page uses, then
renders it with the Aion colour palette and logo.
"""
from __future__ import annotations

import io
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Frame,
    PageTemplate,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.flowables import KeepTogether
from svglib.svglib import svg2rlg

from .agenda_outlook import OutlookScope, build_context, generate_outlook, outlook_window
from .auth import Principal
from .config import get_settings
from .db import service_tx
from .routers.activity import activity as activity_feed
from .supabase_storage import upload_bytes

# Aion brand tokens from webapp/ui/public/brand/aion-tokens.css
_AION_INK = colors.HexColor("#0C1110")
_AION_DEEP_GREEN = colors.HexColor("#08201A")
_AION_SAND = colors.HexColor("#EBE3D4")
_AION_CREAM = colors.HexColor("#FAF5F0")
_AION_MINT = colors.HexColor("#7DDF9A")

_BUCKET = "outlook-reports"

# Match bold and italic markdown inline markup.
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_ITALIC_RE = re.compile(r"\*(.+?)\*")


def _aion_symbol_path() -> Path | None:
    """Resolve the mint Aion symbol shipped with the UI assets."""
    candidate = (
        Path(__file__).resolve().parents[1]
        / "ui"
        / "public"
        / "brand"
        / "aion-symbol-mint.svg"
    )
    return candidate if candidate.exists() else None


def _escape_xml(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _md_line_to_xml(line: str) -> str:
    """Convert a single line of simple Markdown to reportlab XML markup."""
    text = _escape_xml(line)
    text = _BOLD_RE.sub(r"<b>\1</b>", text)
    text = _ITALIC_RE.sub(r"<i>\1</i>", text)
    return text


def _md_to_flowables(md_text: str, styles: dict[str, ParagraphStyle]) -> list[Any]:
    """Turn a short Markdown summary into reportlab flowables."""
    out: list[Any] = []
    for raw in md_text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        # Heading: strip leading hashes and render as bold.
        if line.startswith("#"):
            line = line.lstrip("#").strip()
            out.append(Paragraph(_md_line_to_xml(line), styles["Heading"]))
            continue
        # Bullet line.
        if line.startswith("- "):
            body = line[2:].strip()
            out.append(Paragraph(f"• {_md_line_to_xml(body)}", styles["Bullet"]))
            continue
        out.append(Paragraph(_md_line_to_xml(line), styles["Body"]))
    return out


def _header_footer(canvas: Any, doc: Any, page_count_holder: list[int]) -> None:
    """Draw the Aion header band and footer on every page."""
    page_num = canvas.getPageNumber()
    if page_num > page_count_holder[0]:
        page_count_holder[0] = page_num

    width, height = A4
    header_height = 56 * mm
    footer_height = 14 * mm

    # Header band.
    canvas.setFillColor(_AION_DEEP_GREEN)
    canvas.rect(0, height - header_height, width, header_height, fill=1, stroke=0)

    # Mint accent line under the band.
    canvas.setStrokeColor(_AION_MINT)
    canvas.setLineWidth(1.5)
    canvas.line(0, height - header_height, width, height - header_height)

    # Logo.
    symbol_path = _aion_symbol_path()
    logo_height = 14 * mm
    left_margin = 18 * mm
    top_y = height - 18 * mm
    if symbol_path:
        try:
            drawing = svg2rlg(str(symbol_path))
            if drawing:
                scale = logo_height / float(drawing.height)
                drawing.scale(scale, scale)
                drawing.width = float(drawing.width) * scale
                drawing.height = logo_height
                from reportlab.graphics.renderPDF import draw as renderPDF_draw

                renderPDF_draw(drawing, canvas, left_margin, top_y - logo_height)
                logo_right = left_margin + float(drawing.width) + 4 * mm
            else:
                logo_right = left_margin
        except Exception:
            logo_right = left_margin
    else:
        logo_right = left_margin

    # Wordmark.
    canvas.setFillColor(_AION_MINT)
    canvas.setFont("Helvetica-Bold", 18)
    canvas.drawString(logo_right, top_y - 11 * mm, "AION")

    canvas.setFillColor(_AION_SAND)
    canvas.setFont("Helvetica", 10)
    canvas.drawString(logo_right + 52 * mm, top_y - 10.5 * mm, "Outlook")

    # Footer band.
    canvas.setStrokeColor(_AION_MINT)
    canvas.setLineWidth(0.5)
    canvas.line(left_margin, footer_height, width - left_margin, footer_height)
    canvas.setFillColor(_AION_INK)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(left_margin, 8 * mm, "AION")
    canvas.drawRightString(width - left_margin, 8 * mm, f"Page {page_num}")


def _build_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "Title": ParagraphStyle(
            "OutlookTitle",
            parent=base["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=20,
            textColor=_AION_INK,
            spaceAfter=6,
        ),
        "Subtitle": ParagraphStyle(
            "OutlookSubtitle",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=10,
            textColor=colors.grey,
            spaceAfter=16,
        ),
        "Heading": ParagraphStyle(
            "OutlookHeading",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=13,
            textColor=_AION_INK,
            spaceAfter=6,
            spaceBefore=10,
        ),
        "Body": ParagraphStyle(
            "OutlookBody",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=10,
            leading=14,
            textColor=_AION_INK,
            spaceAfter=8,
        ),
        "Bullet": ParagraphStyle(
            "OutlookBullet",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=10,
            leading=14,
            textColor=_AION_INK,
            leftIndent=12,
            bulletIndent=0,
            spaceAfter=6,
        ),
        "TileLabel": ParagraphStyle(
            "TileLabel",
            fontName="Helvetica",
            fontSize=8,
            textColor=colors.grey,
            leading=10,
            alignment=1,
        ),
        "TileValue": ParagraphStyle(
            "TileValue",
            fontName="Helvetica-Bold",
            fontSize=16,
            textColor=_AION_DEEP_GREEN,
            leading=18,
            alignment=1,
        ),
    }


def _context_tiles(context: dict, styles: dict[str, ParagraphStyle]) -> Table:
    """Metric tiles summarising the outlook context."""
    cal = context.get("calendar") or {}
    activity = context.get("activity") or {}
    rebalances = context.get("rebalances") or []
    signals = context.get("signals") or []

    events = cal.get("events") if cal.get("available") else []
    tiles = [
        ("Calendar events", len(events) if isinstance(events, list) else 0),
        ("Recent runs", len(activity.get("runs") or [])),
        ("Rebalances", sum(len(b.get("events") or []) for b in rebalances)),
        ("Signal runs", len(signals)),
    ]

    cells = [
        [
            Paragraph(str(value), styles["TileValue"]),
            Paragraph(label, styles["TileLabel"]),
        ]
        for label, value in tiles
    ]
    table = Table(cells, colWidths=[38 * mm, 38 * mm, 38 * mm, 38 * mm])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), _AION_CREAM),
                ("BOX", (0, 0), (-1, -1), 0.5, colors.lightgrey),
                ("LINEBEFORE", (1, 0), (-1, -1), 0.5, colors.lightgrey),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    return table


def render_outlook_pdf(
    summary_md: str,
    context: dict,
    scope: OutlookScope,
    anchor: str,
    principal: Principal,
) -> tuple[bytes, int]:
    """Render the outlook as an Aion-branded PDF. Returns (bytes, page_count)."""
    start, end = outlook_window(scope, anchor)
    styles = _build_styles()
    page_count_holder = [0]

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        topMargin=70 * mm,
        bottomMargin=22 * mm,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
    )

    frame = Frame(
        doc.leftMargin,
        doc.bottomMargin,
        doc.width,
        doc.height,
        id="normal",
    )
    template = PageTemplate(
        id="aion-outlook",
        frames=[frame],
        onPage=lambda canvas, doc: _header_footer(canvas, doc, page_count_holder),
    )
    doc.addPageTemplates([template])

    story: list[Any] = []
    story.append(
        Paragraph(
            f"AION Outlook — {scope.capitalize()} of {start}{' – ' + end if end != start else ''}",
            styles["Title"],
        )
    )
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    story.append(
        Paragraph(
            f"Generated for {principal.email or principal.user_id} on {generated_at}",
            styles["Subtitle"],
        )
    )
    story.append(KeepTogether([_context_tiles(context, styles), Spacer(1, 14)]))
    story.extend(_md_to_flowables(summary_md, styles))

    doc.build(story)
    return buf.getvalue(), page_count_holder[0]


def generate_outlook_report(
    task: dict[str, Any], principal: Principal
) -> tuple[str, dict[str, Any]]:
    """Create a scheduled outlook report and persist it to Supabase Storage.

    Returns (report_id, output_summary).
    """
    settings = get_settings()
    params = task.get("params") or {}
    scope: OutlookScope = params.get("scope", "week")
    anchor = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Gather the same feed the Agenda page renders.
    feed = activity_feed(limit=200, principal=principal)
    items = feed.get("items", [])

    # Build context for the PDF tiles.
    start, end = outlook_window(scope, anchor)
    context = build_context(principal, items, start, end)

    # Generate the markdown summary (LLM if key present, otherwise fallback).
    api_key = settings.openrouter_api_key or None
    summary_md, _ = generate_outlook(
        principal, items, scope, anchor, api_key=api_key, model=settings.openrouter_model
    )

    # Render PDF.
    pdf_bytes, pages = render_outlook_pdf(summary_md, context, scope, anchor, principal)

    # Upload to storage.
    user_id = str(task["user_id"])
    task_id = task.get("id")
    task_slug = str(task_id) if task_id else "manual"
    filename = f"{task_slug}_{scope}_{anchor}_{uuid.uuid4().hex[:8]}.pdf"
    storage_path = f"{user_id}/outlook/{filename}"
    upload_bytes(_BUCKET, storage_path, pdf_bytes, content_type="application/pdf")

    # Persist metadata.
    with service_tx() as cur:
        cur.execute(
            "INSERT INTO aion.outlook_reports "
            "  (scheduled_task_id, user_id, org_id, scope, anchor_date, summary, storage_path, file_size) "
            "VALUES (%s, %s::uuid, %s::uuid, %s, %s, %s, %s, %s) "
            "RETURNING id",
            (
                task_id,
                user_id,
                str(task["org_id"]),
                scope,
                anchor,
                summary_md,
                storage_path,
                len(pdf_bytes),
            ),
        )
        row = cur.fetchone()
        report_id = str(row["id"])

    return report_id, {
        "kind": "outlook_report",
        "status": "ok",
        "scope": scope,
        "date": anchor,
        "start": start,
        "end": end,
        "pages": pages,
        "file_size": len(pdf_bytes),
        "title": f"{scope.capitalize()} outlook ({anchor})",
    }


def download_outlook_report(report_id: str, principal: Principal) -> tuple[bytes, str]:
    """Download the PDF bytes for a report the caller owns."""
    from .db import user_tx
    from .supabase_storage import download_bytes as storage_download

    with user_tx(principal.user_id) as cur:
        cur.execute(
            "SELECT storage_path FROM aion.outlook_reports WHERE id = %s::uuid AND user_id = %s::uuid",
            (report_id, principal.user_id),
        )
        row = cur.fetchone()
    if row is None:
        raise PermissionError("Report not found or not accessible")

    storage_path = row["storage_path"]
    return storage_download(_BUCKET, storage_path), Path(storage_path).name


_DEMO_BULLETS = """- **Macro:** inflation prints are cooling in the US and EU, while the BoJ held rates steady. Watch NFP and core PCE on Friday.
- **Rates / FX:** 10Y Treasury yields are consolidating near the recent range top. DXY is softening, giving EUR and JPY a small tailwind.
- **Equities:** breadth improved over the last two sessions, but volumes remain thin. Defensive sectors are outperforming cyclicals.
- **Portfolio:** no rebalances triggered. The model book is neutral risk with a slight quality tilt.
- **Agenda:** light calendar until Thursday; use the quiet period to review factor drift and signal health."""


def render_demo_outlook_pdf(principal: Principal) -> tuple[bytes, int]:
    """Render a self-contained Aion-branded demo PDF (no DB, no LLM, no storage)."""
    scope: OutlookScope = "week"
    anchor = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    start, end = outlook_window(scope, anchor)

    context: dict[str, Any] = {
        "calendar": {
            "available": True,
            "events": [
                {"date": start, "title": "US CPI", "country": "USA"},
                {"date": start, "title": "ECB minutes", "country": "EUR"},
                {"date": end, "title": "Non-farm payrolls", "country": "USA"},
                {"date": end, "title": "UMich sentiment", "country": "USA"},
            ],
        },
        "activity": {
            "runs": [
                {"id": "run-a", "name": "Morning book", "status": "succeeded"},
                {"id": "run-b", "name": "Factor sweep", "status": "succeeded"},
                {"id": "run-c", "name": "Drift check", "status": "succeeded"},
            ],
        },
        "rebalances": [
            {"portfolio_id": "demo-pf-6040", "events": []},
            {"portfolio_id": "demo-pf-digital", "events": [{"date": start, "symbol": "BTC-USD"}]},
        ],
        "signals": [
            {"strategy_id": "demo-baseline", "date": start, "direction": "neutral"},
            {"strategy_id": "demo-momentum", "date": start, "direction": "long"},
        ],
    }

    summary_md = f"**Week outlook ({start} – {end})**\n\n{_DEMO_BULLETS}"
    return render_outlook_pdf(summary_md, context, scope, anchor, principal)
