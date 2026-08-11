from app.models.schemas import AnswerCitationModel
from app.services.citation_location_service import find_pdf_citation_highlights


def _layout():
    return {
        "version": 1,
        "source": "docling",
        "coordinate_system": "pdf_points",
        "pages": [{"page_no": 1, "width": 612.0, "height": 792.0}],
        "text_items": [
            {
                "id": "#/texts/1",
                "page_no": 1,
                "text": "This Court has jurisdiction over the appeal pursuant to 29 U.S.C. 1291",
                "label": "text",
                "bbox": {"l": 100.0, "t": 710.0, "r": 520.0, "b": 690.0, "coord_origin": "BOTTOMLEFT"},
                "charspan": [0, 75],
            },
            {
                "id": "#/texts/2",
                "page_no": 1,
                "text": "because the judgment below is final.",
                "label": "text",
                "bbox": {"l": 100.0, "t": 680.0, "r": 410.0, "b": 660.0, "coord_origin": "BOTTOMLEFT"},
                "charspan": [0, 36],
            },
        ],
    }


def test_find_pdf_citation_highlights_matches_within_one_text_item():
    match = find_pdf_citation_highlights(
        _layout(),
        "jurisdiction over the appeal pursuant to 29 U.S.C. 1291",
    )

    assert match["page"] == 1
    assert match["bboxes"] == [
        {
            "page": 1,
            "l": 100.0,
            "t": 710.0,
            "r": 520.0,
            "b": 690.0,
            "coord_origin": "BOTTOMLEFT",
            "item_id": "#/texts/1",
        }
    ]


def test_find_pdf_citation_highlights_matches_across_text_items():
    match = find_pdf_citation_highlights(
        _layout(),
        "29 U.S.C. 1291 because the judgment below is final.",
    )

    assert match["page"] == 1
    assert [box["item_id"] for box in match["bboxes"]] == ["#/texts/1", "#/texts/2"]


def test_find_pdf_citation_highlights_returns_none_for_missing_layout_or_quote():
    assert find_pdf_citation_highlights(None, "anything") is None
    assert find_pdf_citation_highlights(_layout(), "not present in this document") is None


def _cross_page_layout():
    # One paragraph item that Docling split across a page break: prov segment 0
    # on page 1, segment 1 on page 2. The flat page_no/bbox reflect only segment
    # 0 (the pre-fix shape), so the cited tail sentence used to mis-highlight on
    # page 1.
    return {
        "version": 1,
        "source": "docling",
        "coordinate_system": "pdf_points",
        "pages": [
            {"page_no": 1, "width": 612.0, "height": 792.0},
            {"page_no": 2, "width": 612.0, "height": 792.0},
        ],
        "text_items": [
            {
                "id": "#/texts/100",
                "page_no": 1,
                "text": (
                    "After arriving at the hospital, Resa could not find Brad. "
                    "Officer Gallow called for backup, and there were numerous police officers there."
                ),
                "label": "text",
                "bbox": {"l": 100.0, "t": 300.0, "r": 520.0, "b": 158.0, "coord_origin": "BOTTOMLEFT"},
                "prov": [
                    {
                        "page_no": 1,
                        "bbox": {"l": 100.0, "t": 300.0, "r": 520.0, "b": 158.0, "coord_origin": "BOTTOMLEFT"},
                        "text": "After arriving at the hospital, Resa could not find Brad.",
                    },
                    {
                        "page_no": 2,
                        "bbox": {"l": 100.0, "t": 720.0, "r": 520.0, "b": 690.0, "coord_origin": "BOTTOMLEFT"},
                        "text": "Officer Gallow called for backup, and there were numerous police officers there.",
                    },
                ],
            },
        ],
    }


def test_cross_page_paragraph_highlights_on_the_segment_page():
    # The cited sentence lives in the page-2 provenance segment; the box must
    # land on page 2 with the page-2 bbox, not the paragraph's page-1 head.
    match = find_pdf_citation_highlights(
        _cross_page_layout(),
        "Officer Gallow called for backup, and there were numerous police officers there.",
    )
    assert match["page"] == 2
    assert [b["item_id"] for b in match["bboxes"]] == ["#/texts/100"]
    assert match["bboxes"][0]["t"] == 720.0  # page-2 segment, not the page-1 (t=300) one


def test_cross_page_paragraph_first_segment_stays_on_page_one():
    match = find_pdf_citation_highlights(
        _cross_page_layout(),
        "After arriving at the hospital, Resa could not find Brad.",
    )
    assert match["page"] == 1
    assert match["bboxes"][0]["t"] == 300.0


def test_cross_page_quote_spanning_both_segments_highlights_both_pages():
    # A quote that covers the page-1 tail sentence AND the page-2 head sentence
    # must box both pages, not just the first one it matched.
    match = find_pdf_citation_highlights(
        _cross_page_layout(),
        "Resa could not find Brad. Officer Gallow called for backup, "
        "and there were numerous police officers there.",
    )
    assert match["page"] == 1  # lowest page is the scroll anchor
    assert sorted({box["page"] for box in match["bboxes"]}) == [1, 2]
    assert [box["t"] for box in match["bboxes"]] == [300.0, 720.0]


def _mid_sentence_cross_page_layout():
    # The real-world failure: a single sentence Docling split mid-way across a
    # page break (modeled on text item #/texts/43 in sample-legal-brief-full.pdf).
    # The whole sentence lives on NEITHER page, so page-local matching produced
    # no box at all.
    return {
        "version": 1,
        "source": "docling",
        "coordinate_system": "pdf_points",
        "pages": [
            {"page_no": 8, "width": 612.0, "height": 792.0},
            {"page_no": 9, "width": 612.0, "height": 792.0},
        ],
        "text_items": [
            {
                "id": "#/texts/43",
                "page_no": 8,
                "text": (
                    "Brad became enraged with Resa once she began seeing another man, "
                    "and engaged in unlawful behavior."
                ),
                "label": "text",
                "bbox": {"l": 72.0, "t": 327.9, "r": 539.8, "b": 93.8, "coord_origin": "BOTTOMLEFT"},
                "prov": [
                    {
                        "page_no": 8,
                        "bbox": {"l": 72.0, "t": 327.9, "r": 539.8, "b": 93.8, "coord_origin": "BOTTOMLEFT"},
                        "text": "Brad became enraged with Resa once she began seeing another man,",
                    },
                    {
                        "page_no": 9,
                        "bbox": {"l": 72.0, "t": 714.3, "r": 539.8, "b": 641.1, "coord_origin": "BOTTOMLEFT"},
                        "text": "and engaged in unlawful behavior.",
                    },
                ],
            },
        ],
    }


def test_single_sentence_spanning_page_break_highlights_both_pages():
    match = find_pdf_citation_highlights(
        _mid_sentence_cross_page_layout(),
        "Brad became enraged with Resa once she began seeing another man, "
        "and engaged in unlawful behavior.",
    )
    assert match is not None  # page-local matching returned None here pre-fix
    assert match["page"] == 8
    assert sorted({box["page"] for box in match["bboxes"]}) == [8, 9]
    # Both boxes come from the same Docling item's two provenance segments.
    assert [box["item_id"] for box in match["bboxes"]] == ["#/texts/43", "#/texts/43"]
    assert [box["t"] for box in match["bboxes"]] == [327.9, 714.3]


def _table_layout():
    # Docling stores tables outside `texts`; ingestion now emits one layout item
    # per cell (TOPLEFT bboxes, as Docling tags table cells) so a citation that
    # quotes a markdown table row resolves to a box on each cited cell.
    return {
        "version": 1,
        "source": "docling",
        "coordinate_system": "pdf_points",
        "pages": [{"page_no": 1, "width": 612.0, "height": 792.0}],
        "text_items": [
            {
                "id": "#/tables/0/cell_2",
                "page_no": 1,
                "label": "table_cell",
                "text": "Bradford H. Felder #25046 G. Andrew Veazey #21929 2 Flagg Place",
                "bbox": {"l": 72.0, "t": 538.5, "r": 239.6, "b": 676.2, "coord_origin": "TOPLEFT"},
            },
            {
                "id": "#/tables/0/cell_3",
                "page_no": 1,
                "label": "table_cell",
                "text": "Julie Vaughn Felder #25047 P.O. Box 80399",
                "bbox": {"l": 311.4, "t": 538.5, "r": 479.0, "b": 660.1, "coord_origin": "TOPLEFT"},
            },
        ],
    }


def test_markdown_table_quote_highlights_each_cited_cell():
    match = find_pdf_citation_highlights(
        _table_layout(),
        "| Bradford H. Felder #25046 G. Andrew Veazey #21929 2 Flagg Place "
        "| Julie Vaughn Felder #25047 P.O. Box 80399 |",
    )
    assert match["page"] == 1
    assert [box["item_id"] for box in match["bboxes"]] == ["#/tables/0/cell_2", "#/tables/0/cell_3"]
    assert match["bboxes"][0]["coord_origin"] == "TOPLEFT"


def _oven_manual_layout():
    # Page 1 of an owner's manual: a two-column TOC at the top and a
    # "write the model/serial here" box at the bottom. The chunk's verbatim
    # slice welded the last TOC leader ("Consumer Support .... 28") onto the box
    # text, and the fill-in lines came through as escaped underscores.
    return {
        "version": 1,
        "source": "docling",
        "coordinate_system": "pdf_points",
        "pages": [{"page_no": 1, "width": 612.0, "height": 792.0}],
        "text_items": [
            {
                "id": "#/texts/toc",
                "page_no": 1,
                "text": "Consumer Support 28",
                "label": "text",
                "bbox": {"l": 320.0, "t": 700.0, "r": 520.0, "b": 690.0, "coord_origin": "BOTTOMLEFT"},
            },
            {
                "id": "#/texts/box1",
                "page_no": 1,
                "text": "Write the model and serial numbers here:",
                "label": "text",
                "bbox": {"l": 100.0, "t": 300.0, "r": 400.0, "b": 288.0, "coord_origin": "BOTTOMLEFT"},
            },
            {
                "id": "#/texts/box2",
                "page_no": 1,
                "text": (
                    "You can find them on a label on the side trim or on the front "
                    "of the (lower) oven behind the oven door."
                ),
                "label": "text",
                "bbox": {"l": 100.0, "t": 240.0, "r": 520.0, "b": 210.0, "coord_origin": "BOTTOMLEFT"},
            },
        ],
    }


def test_quote_welded_to_toc_leader_and_blank_lines_still_highlights():
    # The full quote (TOC leader "....28" + escaped-underscore fill-in lines) has
    # no contiguous home, but the clean trailing sentence must still resolve.
    quote = (
        "..........28 Write the model and serial numbers here: "
        "Model # \\_\\_\\_\\_\\_\\_\\_\\_\\_\\_ Serial # \\_\\_\\_\\_\\_\\_\\_\\_\\_\\_ "
        "You can find them on a label on the side trim or on the front "
        "of the (lower) oven behind the oven door."
    )
    match = find_pdf_citation_highlights(_oven_manual_layout(), quote)
    assert match is not None  # was None ("Exact location not found") pre-fix
    assert match["page"] == 1
    assert [b["item_id"] for b in match["bboxes"]] == ["#/texts/box2"]


def _coffeemaker_layout():
    # Page 1 of an instruction booklet: a section-header item and the safety
    # sentence below it. The PDF text layer has the literal "&"; the extracted
    # markdown stored it as "&amp;".
    return {
        "version": 1,
        "source": "docling",
        "coordinate_system": "pdf_points",
        "pages": [{"page_no": 1, "width": 612.0, "height": 792.0}],
        "text_items": [
            {
                "id": "#/texts/title",
                "page_no": 1,
                "label": "section_header",
                "text": "Fully Automatic Burr Grind & Brew ™ Thermal Coffeemaker DGB-850 Series",
                "bbox": {"l": 72.0, "t": 430.0, "r": 540.0, "b": 400.0, "coord_origin": "BOTTOMLEFT"},
            },
            {
                "id": "#/texts/safety",
                "page_no": 1,
                "label": "text",
                "text": (
                    "For your safety and continued enjoyment of this product, always "
                    "read the instruction book carefully before using."
                ),
                "bbox": {"l": 72.0, "t": 360.0, "r": 540.0, "b": 340.0, "coord_origin": "BOTTOMLEFT"},
            },
        ],
    }


def test_quote_with_html_entities_and_image_placeholders_highlights():
    # The quote carries "&amp;" (HTML entity), a "## " heading marker, and
    # trailing "<!-- image -->" placeholders; the PDF layer has a literal "&"
    # and no image text. Entity-decoded + markdown-stripped, it must resolve.
    quote = (
        "## Fully Automatic Burr Grind &amp; Brew ™ Thermal Coffeemaker DGB-850 Series "
        "For your safety and continued enjoyment of this product, always read the "
        "instruction book carefully before using. <!-- image --> <!-- image -->"
    )
    match = find_pdf_citation_highlights(_coffeemaker_layout(), quote)
    assert match is not None  # was None ("Exact location not found") pre-fix
    assert match["page"] == 1
    assert [b["item_id"] for b in match["bboxes"]] == ["#/texts/title", "#/texts/safety"]


def test_answer_citation_model_preserves_pdf_bboxes():
    model = AnswerCitationModel(
        citation_id="cite_1",
        answer_id="msg_1",
        display_ref="{[S1]}",
        display_number=1,
        source={
            "source_id": "doc_abc",
            "source_type": "document",
            "title": "sample.pdf",
            "document_id": "00000000-0000-0000-0000-000000000001",
            "content_type": "application/pdf",
        },
        target={
            "kind": "text_quote",
            "exact": "29 U.S.C. 1291",
            "page": 1,
            "bboxes": [{"page": 1, "l": 1, "t": 2, "r": 3, "b": 1, "coord_origin": "BOTTOMLEFT"}],
        },
        quote="29 U.S.C. 1291",
        status="verified",
    )

    assert model.target.bboxes[0]["coord_origin"] == "BOTTOMLEFT"
