from pathlib import Path
from types import SimpleNamespace

from docling.document_converter import DocumentConverter

from app.services.document_render import (
    _table_cell_layout_items,
    _table_fallback_layout_item,
    attach_chunk_ranges_to_structure,
    build_docling_render,
)
from app.services.hierarchy_extractor import HierarchyNode, HierarchySection


def _fake_bbox(l: float, t: float, r: float, b: float, origin: str = "TOPLEFT"):
    return SimpleNamespace(l=l, t=t, r=r, b=b, coord_origin=SimpleNamespace(value=origin))


def _fake_cell(text, l, t, r, b, *, row, col, has_bbox=True):
    return SimpleNamespace(
        text=text,
        bbox=_fake_bbox(l, t, r, b) if has_bbox else None,
        start_row_offset_idx=row,
        start_col_offset_idx=col,
    )


def _fake_table(self_ref, page_no, cells, *, table_bbox=None):
    prov = [SimpleNamespace(
        page_no=page_no,
        bbox=table_bbox or _fake_bbox(70.0, 306.0, 480.0, 115.0, "BOTTOMLEFT"),
        charspan=None,
    )]
    return SimpleNamespace(
        self_ref=self_ref,
        prov=prov,
        data=SimpleNamespace(table_cells=cells, num_rows=2, num_cols=2),
    )


FIXTURE_PATH = (
    Path(__file__).resolve().parents[3]
    / "frontend"
    / "tests"
    / "fixtures"
    / "sample.pdf"
)


def test_docling_render_extracts_pages_and_structure():
    docling_document = DocumentConverter().convert(str(FIXTURE_PATH)).document

    render = build_docling_render(docling_document)

    assert render.markdown.startswith("## Sample PDF for preview tests")
    assert [page["page_no"] for page in render.pages] == [1, 2]
    assert "Page 1 of 2" in render.pages[0]["markdown"]
    assert "Page 2" in render.pages[1]["markdown"]
    assert render.layout
    assert render.layout["coordinate_system"] == "pdf_points"
    assert render.layout["pages"][0] == {"page_no": 1, "width": 612.0, "height": 792.0}
    assert any(
        item["page_no"] == 1
        and item["text"] == "Page 1 of 2. This is a fixture used by Playwright."
        and item["bbox"]["coord_origin"] == "BOTTOMLEFT"
        for item in render.layout["text_items"]
    )

    nodes = render.structure["nodes"]
    assert nodes[0] == {
        "id": "page-1",
        "kind": "page",
        "title": "Page 1",
        "level": 1,
        "page_no": 1,
    }
    assert any(
        node["kind"] == "section"
        and node["title"] == "Sample PDF for preview tests"
        and node["page_no"] == 1
        for node in nodes
    )


def test_table_cells_become_row_major_layout_items():
    # A 2x2 counsel block (like the cover-page table in sample-legal-brief-full),
    # cells deliberately out of order to prove row-major sorting.
    cells = [
        _fake_cell("Julie Vaughn Felder #25047", 311.0, 538.0, 479.0, 660.0, row=1, col=1),
        _fake_cell("HUVAL, VEAZEY, FELDER", 72.0, 490.0, 251.0, 515.0, row=0, col=0),
        _fake_cell("Bradford H. Felder #25046", 72.0, 538.0, 239.0, 676.0, row=1, col=0),
        _fake_cell("JULIEKORENVAUGHN FELDER", 311.0, 490.0, 473.0, 515.0, row=0, col=1),
    ]
    items = _table_cell_layout_items(_fake_table("#/tables/0", 1, cells), 1)

    assert [it["text"] for it in items] == [
        "HUVAL, VEAZEY, FELDER",
        "JULIEKORENVAUGHN FELDER",
        "Bradford H. Felder #25046",
        "Julie Vaughn Felder #25047",
    ]
    assert [it["id"] for it in items] == [f"#/tables/0/cell_{i}" for i in range(4)]
    assert all(it["page_no"] == 1 and it["label"] == "table_cell" for it in items)
    # bbox + non-default coord_origin are preserved from the cell.
    assert items[2]["bbox"] == {"l": 72.0, "t": 538.0, "r": 239.0, "b": 676.0, "coord_origin": "TOPLEFT"}


def test_table_cell_items_skip_empty_or_boxless_cells():
    cells = [
        _fake_cell("Good", 72.0, 538.0, 239.0, 676.0, row=0, col=0),
        _fake_cell("   ", 80.0, 538.0, 200.0, 676.0, row=0, col=1),          # blank text
        _fake_cell("NoBox", 0.0, 0.0, 0.0, 0.0, row=1, col=0, has_bbox=False),  # no bbox
    ]
    items = _table_cell_layout_items(_fake_table("#/tables/1", 5, cells), 1)
    assert [it["text"] for it in items] == ["Good"]


def test_table_without_cell_bboxes_falls_back_to_whole_table_box():
    cells = [
        _fake_cell("Alpha cell", 0.0, 0.0, 0.0, 0.0, row=0, col=0, has_bbox=False),
        _fake_cell("Beta cell", 0.0, 0.0, 0.0, 0.0, row=0, col=1, has_bbox=False),
    ]
    table = _fake_table("#/tables/3", 7, cells)

    assert _table_cell_layout_items(table, 3) == []
    fallback = _table_fallback_layout_item(table, 3)
    assert fallback["id"] == "#/tables/3"
    assert fallback["label"] == "table"
    assert fallback["page_no"] == 7
    assert fallback["text"] == "Alpha cell Beta cell"
    assert fallback["bbox"]["coord_origin"] == "BOTTOMLEFT"


def test_attach_chunk_ranges_to_structure_matches_section_titles():
    structure = {
        "version": 1,
        "source": "docling",
        "nodes": [
            {
                "id": "section-1",
                "kind": "section",
                "title": "Sample PDF for preview tests",
                "level": 2,
                "page_no": 1,
            }
        ],
    }
    section = HierarchySection(
        title="Sample PDF for preview tests",
        original_title="Sample PDF for preview tests",
        level=2,
        hierarchy_stack=[HierarchyNode("Sample PDF for preview tests", 2)],
        hierarchy_path="Sample PDF for preview tests",
        content="",
        content_length=0,
        section_index=0,
        mapped_chunk_index=0,
        chunk_range=[0, 1],
        chunk_count=2,
        chunk_indices=[0, 1],
    )

    updated = attach_chunk_ranges_to_structure(structure, [section])

    node = updated["nodes"][0]
    assert node["chunk_range"] == [0, 1]
    assert node["chunk_count"] == 2
    assert node["mapped_chunk_index"] == 0
