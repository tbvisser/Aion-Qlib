"""Page-aware document render metadata helpers."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from app.services.hierarchy_extractor import HierarchySection, MarkdownHierarchyExtractor
from app.services.markdown_structure import normalize_docling_markdown_headings


@dataclass
class DocumentRenderExtraction:
    markdown: str
    pages: list[dict[str, Any]]
    structure: dict[str, Any] | None
    layout: dict[str, Any] | None = None


_MARKDOWN_HEADING_RE = re.compile(r"^#{1,6}\s+", re.MULTILINE)


def _label_value(label: Any) -> str:
    value = getattr(label, "value", None)
    return str(value or label or "").lower()


def _bbox_to_dict(bbox: Any) -> dict[str, Any] | None:
    if bbox is None:
        return None

    data: dict[str, Any] = {}
    for key in ("l", "t", "r", "b"):
        value = getattr(bbox, key, None)
        if value is not None:
            data[key] = value

    coord_origin = getattr(bbox, "coord_origin", None)
    if coord_origin is not None:
        data["coord_origin"] = getattr(coord_origin, "value", str(coord_origin))

    return data or None


def _first_provenance(item: Any) -> Any | None:
    prov = getattr(item, "prov", None)
    if isinstance(prov, list) and prov:
        return prov[0]
    return None


def _item_page_no(item: Any) -> int | None:
    provenance = _first_provenance(item)
    page_no = getattr(provenance, "page_no", None)
    if page_no is None:
        return None
    try:
        return int(page_no)
    except (TypeError, ValueError):
        return None


def _item_bbox(item: Any) -> dict[str, Any] | None:
    provenance = _first_provenance(item)
    return _bbox_to_dict(getattr(provenance, "bbox", None))


def _item_provenance_segments(item: Any, raw_text: str) -> list[dict[str, Any]] | None:
    """Per-page provenance segments for a text item that crosses a page break.

    Docling stores a paragraph split across pages as a single text item with
    multiple ``prov`` entries, each carrying its own page, bbox and charspan.
    Returns one ``{page_no, bbox, text}`` segment per provenance (text sliced by
    charspan) so a citation highlights on the page where the matched sentence
    actually renders -- not just the paragraph's first page.

    Returns ``None`` for single-provenance items (the common case) or when any
    charspan is missing; callers then fall back to the item's flat page/bbox.
    """
    prov = getattr(item, "prov", None)
    if not isinstance(prov, list) or len(prov) < 2:
        return None
    segments: list[dict[str, Any]] = []
    for provenance in prov:
        page_no = getattr(provenance, "page_no", None)
        bbox = _bbox_to_dict(getattr(provenance, "bbox", None))
        charspan = _charspan_to_list(getattr(provenance, "charspan", None))
        if page_no is None or not bbox or not charspan:
            return None
        try:
            page_int = int(page_no)
        except (TypeError, ValueError):
            return None
        seg_text = raw_text[charspan[0]:charspan[1]].strip()
        if seg_text:
            segments.append({"page_no": page_int, "bbox": bbox, "text": seg_text})
    return segments if len(segments) >= 2 else None


def _table_cell_layout_items(table: Any, table_index: int) -> list[dict[str, Any]]:
    """Layout text-items for a Docling table, one per cell.

    Tables live in ``docling_document.tables``, not ``texts``, so without this a
    citation that quotes a table -- e.g. a two-column counsel/signature block
    that ``export_to_markdown`` renders as ``| left | right |`` -- has no box to
    match and silently falls back to the text view. Each cell carries its own
    page-space bbox and text; we emit them in row-major (reading) order so a
    markdown-derived quote matches across the cells it spans, highlighting each
    cited cell. Cells without a usable bbox or text are skipped; a table whose
    cells are all unusable is handled by the caller's whole-table fallback.
    """
    data = getattr(table, "data", None)
    cells = getattr(data, "table_cells", None) or []
    # Cells carry no page of their own -- a table's cells share its page. A table
    # that crosses a page break is rare; its cells then anchor to the table's
    # first page, still better than dropping the box entirely.
    table_page = _item_page_no(table)
    if table_page is None:
        return []
    table_id = str(getattr(table, "self_ref", None) or f"table-{table_index}")

    ordered = sorted(
        cells,
        key=lambda cell: (
            getattr(cell, "start_row_offset_idx", 0) or 0,
            getattr(cell, "start_col_offset_idx", 0) or 0,
        ),
    )
    items: list[dict[str, Any]] = []
    for cell_index, cell in enumerate(ordered):
        cell_text = str(getattr(cell, "text", "") or "").strip()
        cell_bbox = _bbox_to_dict(getattr(cell, "bbox", None))
        if not cell_text or not cell_bbox:
            continue
        items.append({
            "id": f"{table_id}/cell_{cell_index}",
            "page_no": table_page,
            "text": cell_text,
            "label": "table_cell",
            "bbox": cell_bbox,
        })
    return items


def _table_fallback_layout_item(table: Any, table_index: int) -> dict[str, Any] | None:
    """One whole-table box for tables whose cells expose no per-cell geometry.

    Joins cell text in document order so a table citation still matches and
    highlights the table region when ``_table_cell_layout_items`` came back empty.
    """
    table_page = _item_page_no(table)
    table_bbox = _item_bbox(table)
    if table_page is None or not table_bbox:
        return None
    cells = getattr(getattr(table, "data", None), "table_cells", None) or []
    text = " ".join(
        cell_text
        for cell in cells
        if (cell_text := str(getattr(cell, "text", "") or "").strip())
    )
    if not text:
        return None
    return {
        "id": str(getattr(table, "self_ref", None) or f"table-{table_index}"),
        "page_no": table_page,
        "text": text,
        "label": "table",
        "bbox": table_bbox,
    }


def _page_size_to_dict(page: Any, page_no: int) -> dict[str, Any]:
    size = getattr(page, "size", None)
    out: dict[str, Any] = {"page_no": page_no}
    for key in ("width", "height"):
        value = getattr(size, key, None)
        if value is not None:
            out[key] = value
    return out


def _charspan_to_list(value: Any) -> list[int] | None:
    if value is None:
        return None
    try:
        items = list(value)
    except TypeError:
        return None
    if len(items) != 2:
        return None
    try:
        return [int(items[0]), int(items[1])]
    except (TypeError, ValueError):
        return None


def _structure_node_key(title: str) -> str:
    return re.sub(r"\s+", " ", title).strip().casefold()


def _is_heading_item(item: Any) -> bool:
    label = _label_value(getattr(item, "label", None))
    type_name = type(item).__name__.lower()
    return label in {"section_header", "title"} or "header" in type_name or "title" in type_name


def _heading_level(item: Any) -> int:
    raw_level = getattr(item, "level", None)
    try:
        level = int(raw_level)
    except (TypeError, ValueError):
        level = 1

    # Page rows sit at level 1 in the nav; headings are indented beneath pages.
    return min(max(level + 1, 2), 6)


def _build_page_nodes(page_numbers: list[int]) -> dict[int, dict[str, Any]]:
    return {
        page_no: {
            "id": f"page-{page_no}",
            "kind": "page",
            "title": f"Page {page_no}",
            "level": 1,
            "page_no": page_no,
        }
        for page_no in page_numbers
    }


def _plain_markdown_structure(markdown: str) -> dict[str, Any]:
    page_node = _build_page_nodes([1])[1]
    nodes: list[dict[str, Any]] = [page_node]

    if _MARKDOWN_HEADING_RE.search(markdown):
        extractor = MarkdownHierarchyExtractor()
        for index, section in enumerate(extractor.extract_hierarchy(markdown), start=1):
            if section.title == "Document":
                continue
            nodes.append(
                {
                    "id": f"section-{index}",
                    "kind": "section",
                    "title": section.title,
                    "level": min(section.level + 1, 6),
                    "page_no": 1,
                    "hierarchy_path": section.hierarchy_path,
                }
            )

    return {"version": 1, "source": "markdown", "nodes": nodes}


def build_plain_text_render(markdown: str) -> DocumentRenderExtraction:
    """Build a single-page render envelope for text-like uploads."""
    return DocumentRenderExtraction(
        markdown=markdown,
        pages=[{"page_no": 1, "markdown": markdown}],
        structure=_plain_markdown_structure(markdown),
    )


def build_docling_render(docling_document: Any) -> DocumentRenderExtraction:
    """Build full markdown, page markdown, and clickable structure from Docling."""
    markdown = normalize_docling_markdown_headings(
        docling_document.export_to_markdown()
    )

    raw_pages = getattr(docling_document, "pages", None) or {}
    page_numbers = sorted(int(page_no) for page_no in raw_pages.keys())
    if not page_numbers:
        page_numbers = sorted(
            {
                page_no
                for item in getattr(docling_document, "texts", [])
                if (page_no := _item_page_no(item)) is not None
            }
        )

    if not page_numbers:
        return build_plain_text_render(markdown)

    pages: list[dict[str, Any]] = []
    for page_no in page_numbers:
        page_markdown = normalize_docling_markdown_headings(
            docling_document.export_to_markdown(page_no=page_no)
        )
        pages.append({"page_no": page_no, "markdown": page_markdown})

    layout_pages = [
        _page_size_to_dict(raw_pages.get(page_no) or raw_pages.get(str(page_no)), page_no)
        for page_no in page_numbers
    ]
    layout_text_items: list[dict[str, Any]] = []
    for index, item in enumerate(getattr(docling_document, "texts", []), start=1):
        raw_text = str(getattr(item, "text", "") or "")
        text = raw_text.strip()
        if not text:
            continue
        page_no = _item_page_no(item)
        bbox = _item_bbox(item)
        if page_no is None or not bbox:
            continue

        provenance = _first_provenance(item)
        text_item: dict[str, Any] = {
            "id": str(getattr(item, "self_ref", None) or f"text-{index}"),
            "page_no": page_no,
            "text": text,
            "label": _label_value(getattr(item, "label", None)),
            "bbox": bbox,
        }
        charspan = _charspan_to_list(getattr(provenance, "charspan", None))
        if charspan:
            text_item["charspan"] = charspan
        # A paragraph split across a page break carries one provenance segment
        # per page; keep them all so a citation resolves to the page where the
        # matched sentence renders, not just the paragraph's first page.
        segments = _item_provenance_segments(item, raw_text)
        if segments:
            text_item["prov"] = segments
        layout_text_items.append(text_item)

    # Tables are a separate collection from texts; emit per-cell boxes (with a
    # whole-table fallback) so citations into tables can highlight on the page.
    for table_index, table in enumerate(getattr(docling_document, "tables", []), start=1):
        cell_items = _table_cell_layout_items(table, table_index)
        if cell_items:
            layout_text_items.extend(cell_items)
        elif (fallback := _table_fallback_layout_item(table, table_index)) is not None:
            layout_text_items.append(fallback)

    page_nodes = _build_page_nodes(page_numbers)
    sections_by_page: dict[int, list[dict[str, Any]]] = {page_no: [] for page_no in page_numbers}
    unpaged_sections: list[dict[str, Any]] = []
    section_count = 0

    for item in getattr(docling_document, "texts", []):
        if not _is_heading_item(item):
            continue

        title = str(getattr(item, "text", "") or "").strip()
        if not title:
            continue

        section_count += 1
        page_no = _item_page_no(item)
        node: dict[str, Any] = {
            "id": f"section-{section_count}",
            "kind": "section",
            "title": title,
            "level": _heading_level(item),
            "page_no": page_no,
        }

        bbox = _item_bbox(item)
        if bbox:
            node["bbox"] = bbox

        item_ref = getattr(item, "self_ref", None)
        if item_ref:
            node["item_ref"] = str(item_ref)

        if page_no in sections_by_page:
            sections_by_page[page_no].append(node)
        else:
            unpaged_sections.append(node)

    nodes: list[dict[str, Any]] = []
    for page_no in page_numbers:
        nodes.append(page_nodes[page_no])
        nodes.extend(sections_by_page[page_no])
    nodes.extend(unpaged_sections)

    return DocumentRenderExtraction(
        markdown=markdown,
        pages=pages,
        structure={"version": 1, "source": "docling", "nodes": nodes},
        layout={
            "version": 1,
            "source": "docling",
            "coordinate_system": "pdf_points",
            "pages": layout_pages,
            "text_items": layout_text_items,
        },
    )


def attach_chunk_ranges_to_structure(
    structure: dict[str, Any] | None,
    sections: list[HierarchySection],
) -> dict[str, Any] | None:
    """Attach smart-chunk ranges to matching section nodes when available."""
    if not structure:
        return structure

    nodes = structure.get("nodes")
    if not isinstance(nodes, list):
        return structure

    section_nodes_by_title: dict[str, list[dict[str, Any]]] = {}
    for node in nodes:
        if not isinstance(node, dict) or node.get("kind") != "section":
            continue
        title = str(node.get("title") or "")
        if not title:
            continue
        section_nodes_by_title.setdefault(_structure_node_key(title), []).append(node)

    used_node_ids: set[str] = set()
    for section in sections:
        if not section.chunk_range:
            continue

        candidates = section_nodes_by_title.get(
            _structure_node_key(section.original_title or section.title),
            [],
        )
        target = next(
            (
                node
                for node in candidates
                if str(node.get("id") or "") not in used_node_ids
            ),
            None,
        )
        if target is None:
            continue

        used_node_ids.add(str(target.get("id") or ""))
        target["chunk_range"] = list(section.chunk_range)
        target["chunk_count"] = section.chunk_count
        if section.mapped_chunk_index is not None:
            target["mapped_chunk_index"] = section.mapped_chunk_index
        if section.hierarchy_path:
            target["hierarchy_path"] = section.hierarchy_path

    return structure
