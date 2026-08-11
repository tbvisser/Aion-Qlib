"""Resolve document citation targets to rendered PDF layout boxes."""

from __future__ import annotations

import html
import json
import re
from typing import Any

from app.db.supabase import get_supabase_client


_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])")


def _normalize_search_text(value: str) -> str:
    # Decode HTML entities (&amp; -> &, &trade; -> ™) so quotes pulled from the
    # extracted markdown match the literal characters in the Docling text layer.
    # Applied to both the candidate quotes and the layout text, so a doc that
    # genuinely contains an entity still compares equal on both sides.
    return re.sub(r"\s+", " ", html.unescape(value or "")).strip()


def _strip_inline_markdown(value: str) -> str:
    return re.sub(r"<[^>]+>", "", re.sub(
        r"!\[([^\]]*)\]\([^)]+\)|\[([^\]]+)\]\([^)]+\)|`([^`]+)`|~~([^~]+)~~|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_",
        lambda m: next((g for g in m.groups() if g is not None), ""),
        value,
    ))


def _strip_markdown_line_markers(value: str) -> str:
    value = re.sub(r"^#{1,6}\s+", "", value, flags=re.MULTILINE)
    value = re.sub(r"^>\s?", "", value, flags=re.MULTILINE)
    value = re.sub(r"^[-*+]\s+", "", value, flags=re.MULTILINE)
    return re.sub(r"^\d+[.)]\s+", "", value, flags=re.MULTILINE)


# Fill-in-the-blank lines (runs of underscores, raw or markdown-escaped) and
# dotted TOC leaders are never matchable layout text, but they fence off clean
# phrases on either side. Splitting on them -- and on label colons -- lets a
# phrase like "You can find them ... behind the oven door." match on its own
# when the full quote (polluted with "....28" and "Model # \_\_\_") cannot.
_BLANK_RUN_RE = re.compile(r"(?:\\?_){2,}")
_DOTTED_LEADER_RE = re.compile(r"(?:\.\s*){4,}\d*")


def _fragment_candidates(exact: str) -> list[str]:
    """Clean sub-phrases of a quote, split on fill-in-blank lines, TOC leaders
    and label colons (longest first).

    A last-resort candidate source so a citation whose verbatim slice was welded
    to non-matchable noise still highlights the part that exists in the source.
    """
    fenced = _DOTTED_LEADER_RE.sub("\x00", _BLANK_RUN_RE.sub("\x00", exact or ""))
    frags: list[str] = []
    for part in re.split(r"[\x00:]", fenced):
        cleaned = _normalize_search_text(_strip_inline_markdown(part))
        if len(cleaned) >= 24:
            frags.append(cleaned)
    frags.sort(key=len, reverse=True)
    return frags


def _target_text_candidates(exact: str) -> list[str]:
    stripped = _strip_inline_markdown(_strip_markdown_line_markers(exact.strip()))
    candidates = [exact, stripped]

    if "|" in exact:
        table_text = " ".join(
            _strip_inline_markdown(cell).strip()
            for cell in exact.strip().strip("|").split("|")
            if cell.strip()
        )
        candidates.append(table_text)

    for block in re.split(r"\n{2,}", stripped):
        block = block.strip()
        if len(block) >= 24:
            candidates.append(block)
        for sentence in _SENTENCE_SPLIT_RE.split(block):
            sentence = sentence.strip()
            if len(sentence) >= 32:
                candidates.append(sentence)

    # Last resort: clean sub-phrases fenced by fill-in-blank lines / TOC leaders,
    # tried after the fuller candidates so a complete match is preferred.
    candidates.extend(_fragment_candidates(exact))

    seen: set[str] = set()
    out: list[str] = []
    for candidate in candidates:
        normalized = _normalize_search_text(candidate)
        if not normalized or normalized.casefold() in seen:
            continue
        seen.add(normalized.casefold())
        out.append(normalized)
    return out


def _coerce_layout(layout: Any) -> dict[str, Any] | None:
    if isinstance(layout, dict):
        return layout
    if isinstance(layout, str):
        try:
            parsed = json.loads(layout)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _bbox_for_item(item: dict[str, Any]) -> dict[str, Any] | None:
    bbox = item.get("bbox")
    if not isinstance(bbox, dict):
        return None
    try:
        page = int(item.get("page_no"))
        l = float(bbox["l"])
        t = float(bbox["t"])
        r = float(bbox["r"])
        b = float(bbox["b"])
    except (KeyError, TypeError, ValueError):
        return None
    if r <= l or t == b:
        return None

    raw_origin = str(bbox.get("coord_origin") or "BOTTOMLEFT")
    coord_origin = raw_origin.split(".")[-1].upper()
    return {
        "page": page,
        "l": l,
        "t": t,
        "r": r,
        "b": b,
        "coord_origin": coord_origin,
        "item_id": str(item.get("id") or ""),
    }


def _segment_text_index(segments: list[dict[str, Any]]) -> tuple[str, list[int | None]]:
    """Concatenate segment texts into one searchable reading-order run.

    Returns the normalized text and a parallel list mapping each character
    position back to its segment index (``None`` for the single-space join
    inserted between segments). That join also reconstructs the whitespace a
    page-break charspan split dropped between two provenance segments, so a
    sentence straddling the break is still found as one contiguous substring.
    """
    text = ""
    char_to_segment: list[int | None] = []

    for seg_index, segment in enumerate(segments):
        normalized = _normalize_search_text(str(segment.get("text") or ""))
        if not normalized:
            continue
        if text:
            text += " "
            char_to_segment.append(None)
        text += normalized
        char_to_segment.extend([seg_index] * len(normalized))

    return text, char_to_segment


def _expand_segments(items_raw: list[Any]) -> list[dict[str, Any]]:
    """Flatten layout text items into per-page provenance segments.

    A paragraph that crosses a page break is stored as one text item with a
    ``prov`` list of per-page segments (each ``{page_no, bbox, text}``); each
    becomes its own segment so a match resolves to the page where the cited text
    actually renders. Items without multi-page provenance -- single-page items,
    or layouts captured before provenance segments were stored -- contribute one
    segment built from their flat ``page_no``/``bbox``/``text`` fields, so older
    documents keep working unchanged until they are re-ingested.
    """
    segments: list[dict[str, Any]] = []
    for item in items_raw:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id") or "")
        prov = item.get("prov")
        if isinstance(prov, list) and len(prov) >= 2:
            for seg in prov:
                if not isinstance(seg, dict):
                    continue
                bbox = seg.get("bbox")
                seg_text = seg.get("text")
                page_no = seg.get("page_no")
                if not isinstance(bbox, dict) or not seg_text or page_no is None:
                    continue
                try:
                    page_int = int(page_no)
                except (TypeError, ValueError):
                    continue
                segments.append({"id": item_id, "page_no": page_int, "bbox": bbox, "text": seg_text})
            continue
        if not item.get("text") or not isinstance(item.get("bbox"), dict):
            continue
        try:
            page_int = int(item.get("page_no"))
        except (TypeError, ValueError):
            continue
        segments.append({"id": item_id, "page_no": page_int, "bbox": item["bbox"], "text": item["text"]})
    return segments


def find_pdf_citation_highlights(
    layout: dict[str, Any] | None,
    exact: str | None,
) -> dict[str, Any] | None:
    """Find Docling text-item boxes that overlap a citation quote.

    The match is text-item precise, not word precise: if part of a Docling text
    item matches, the whole item bbox is returned. Matching runs over the whole
    document in reading order (not page by page), so a quote that crosses a page
    break resolves to a box on *every* page it spans. Docling stores a paragraph
    split across pages as one text item with a per-page provenance segment each
    (see ``_expand_segments``); a single cited sentence straddling that break
    therefore highlights on both pages instead of dropping the continuation.
    """
    if not layout or not exact:
        return None

    items_raw = layout.get("text_items")
    if not isinstance(items_raw, list):
        return None

    candidates = _target_text_candidates(exact)
    if not candidates:
        return None

    # Keep ``_expand_segments`` (reading) order -- it mirrors the order the cited
    # text was chunked from -- rather than grouping by page. Page-local matching
    # cannot find a sentence whose two halves live on different pages.
    segments = _expand_segments(items_raw)
    if not segments:
        return None

    doc_text, char_to_segment = _segment_text_index(segments)
    if not doc_text:
        return None
    doc_text_folded = doc_text.casefold()

    for candidate in candidates:
        start = doc_text_folded.find(candidate.casefold())
        if start < 0:
            continue
        end = start + len(candidate)
        seg_indices = [
            index
            for index in dict.fromkeys(
                char_to_segment[pos]
                for pos in range(start, min(end, len(char_to_segment)))
                if char_to_segment[pos] is not None
            )
        ]
        bboxes = [
            bbox
            for index in seg_indices
            if (bbox := _bbox_for_item(segments[index])) is not None
        ]
        if bboxes:
            # A match may span several pages; the lowest page is the scroll
            # anchor and every box carries its own page so the viewer draws each
            # on the right page.
            pages = sorted({box["page"] for box in bboxes})
            return {"page": pages[0], "bboxes": bboxes}

    return None


def _document_is_pdf(row: dict[str, Any], citation_source: dict[str, Any]) -> bool:
    content_type = str(citation_source.get("content_type") or row.get("file_type") or "").lower()
    title = str(citation_source.get("title") or "").lower()
    return content_type == "application/pdf" or title.endswith(".pdf")


def _load_candidate_documents(document_ids: set[str], user_id: str) -> dict[str, dict[str, Any]]:
    if not document_ids:
        return {}

    supabase = get_supabase_client()
    result = supabase.table("documents").select(
        "id,user_id,folder_id,file_type,document_layout"
    ).in_("id", list(document_ids)).execute()
    rows = result.data or []

    foreign_folder_ids = {
        str(row.get("folder_id"))
        for row in rows
        if row.get("user_id") != user_id and row.get("folder_id")
    }
    global_folder_ids: set[str] = set()
    if foreign_folder_ids:
        folder_result = supabase.table("folders").select("id,user_id").in_(
            "id", list(foreign_folder_ids)
        ).execute()
        global_folder_ids = {
            str(row["id"])
            for row in (folder_result.data or [])
            if row.get("user_id") is None
        }

    allowed: dict[str, dict[str, Any]] = {}
    for row in rows:
        row_id = str(row.get("id") or "")
        if not row_id:
            continue
        if row.get("user_id") == user_id or str(row.get("folder_id") or "") in global_folder_ids:
            allowed[row_id] = row
    return allowed


def enrich_pdf_citation_targets(citations: list[dict], *, user_id: str) -> list[dict]:
    """Attach PDF page/bbox data to document citation targets when available."""
    document_ids = {
        str((citation.get("source") or {}).get("document_id"))
        for citation in citations
        if (citation.get("source") or {}).get("source_type") == "document"
        and (citation.get("source") or {}).get("document_id")
    }
    documents = _load_candidate_documents(document_ids, user_id)

    for citation in citations:
        source = citation.get("source") or {}
        document_id = str(source.get("document_id") or "")
        row = documents.get(document_id)
        target = citation.get("target") or {}
        if not row or target.get("bboxes") or not target.get("exact"):
            continue
        if not _document_is_pdf(row, source):
            continue

        match = find_pdf_citation_highlights(
            _coerce_layout(row.get("document_layout")),
            str(target.get("exact") or ""),
        )
        if not match:
            continue

        citation["target"] = {
            **target,
            "page": match["page"],
            "bboxes": match["bboxes"],
        }

    return citations
