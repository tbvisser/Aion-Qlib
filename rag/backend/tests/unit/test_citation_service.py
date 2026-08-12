"""Unit tests for citation_service (Fast Mode logic)."""

import pytest

from app.services.citation_service import (
    CitationContext,
    EvidenceSpan,
    build_answer_citations,
    build_newly_cited_full_citations,
    build_streaming_citations,
    canonical_source_id,
    canonical_span_id,
    span_to_registry_dict,
    span_from_registry_dict,
    format_evidence_block,
    format_evidence_block_for_alias_numbers,
    format_evidence_block_for_new_aliases,
    content_type_for_document_title,
    inline_label_result,
    inline_label_passages,
    merge_same_pdf_highlight_citation_runs,
    normalize_aliases_in_text,
    sanitize_unowned_aliases,
    strip_alias_numbers,
    spans_from_document_sections,
    spans_from_document_structure,
    spans_from_grep_result,
    spans_from_read_result,
    spans_from_search_chunks,
    spans_from_web_results,
    spans_from_workspace_file,
    split_into_spans,
    register_web_results,
    clean_web_text,
)


def _mk_span(source_id: str, text: str, idx: int = 0) -> EvidenceSpan:
    return EvidenceSpan(
        span_id=canonical_span_id(source_id, text, idx),
        source_id=source_id,
        source_type="document",
        title="Doc",
        text=text,
        document_id="doc-uuid-aaa",
    )


def test_split_into_spans_handles_short_text():
    # Short input should still yield exactly one span.
    spans = split_into_spans("Hello world.")
    assert spans == ["Hello world."]


def test_split_into_spans_sentence_boundaries():
    text = (
        "The court found liability. The damages totaled $4.2 million in 2024. "
        "Subsequent appeals were dismissed. The plaintiff settled the remaining claims."
    )
    spans = split_into_spans(text)
    assert len(spans) >= 2
    # All sentences should be present.
    joined = " ".join(spans)
    assert "$4.2 million" in joined
    assert "Subsequent appeals were dismissed" in joined


def test_canonical_ids_are_stable_across_turns():
    # The same chunk content yields the same source/span ids regardless of turn.
    sid_a = canonical_source_id(document_id="doc-123", file_path=None, thread_id=None, uri=None)
    sid_b = canonical_source_id(document_id="doc-123", file_path=None, thread_id=None, uri=None)
    assert sid_a == sid_b

    text = "A reproducible factual sentence used in two different turns."
    assert canonical_span_id(sid_a, text, 0) == canonical_span_id(sid_b, text, 0)


def test_register_assigns_sequential_aliases_and_is_idempotent():
    ctx = CitationContext(turn_id="turn_1", max_aliases=24)
    s1 = _mk_span("doc_x", "First evidence span used by the model.", 0)
    s2 = _mk_span("doc_x", "Second evidence span used by the model.", 1)
    aliases = ctx.register_spans([s1, s2])
    assert [a.display_number for a in aliases] == [1, 2]
    # Re-registering the same span_id returns the same alias.
    aliases2 = ctx.register_spans([s1])
    assert aliases2[0].display_number == 1


def test_validate_drops_unknown_aliases():
    ctx = CitationContext(turn_id="turn_1")
    s1 = _mk_span("doc_x", "alpha bravo charlie delta echo foxtrot.", 0)
    ctx.register_spans([s1])

    nums = ctx.parse_aliases("Statement one {[S1]} and statement two {[S7]} together.")
    assert nums == [1, 7]
    valid, invalid = ctx.validate(nums)
    assert [a.display_number for a in valid] == [1]
    assert invalid == [7]


def test_build_answer_citations_produces_expected_fields():
    ctx = CitationContext(turn_id="turn_xyz")
    s1 = _mk_span("doc_x", "Westlaw AI hallucinated on 33% of legal queries in the audit.", 0)
    s2 = _mk_span("doc_x", "Lexis suggested incorrect citations in 17% of test prompts.", 1)
    ctx.register_spans([s1, s2])

    answer = (
        "The audit found that Westlaw AI hallucinated on 33% of queries {[S1]}. "
        "Lexis exhibited a lower but still material error rate {[S2]}."
    )
    citations, invalid = build_answer_citations(
        answer_text=answer, context=ctx, message_id="msg-1", thread_id="thr-1",
    )
    assert invalid == []
    assert len(citations) == 2
    by_num = {c["display_number"]: c for c in citations}
    assert by_num[1]["status"] == "not_verified"  # Fast Mode default
    assert by_num[1]["source"]["document_id"] == "doc-uuid-aaa"
    assert by_num[1]["target"]["kind"] == "text_quote"
    assert "Westlaw AI" in by_num[1]["target"]["exact"]


def test_streaming_citation_id_matches_finalized_citation_id():
    """Quick-mode streaming: a chip rendered mid-stream must keep its href after
    the end-of-turn citation_metadata event narrows the bucket. That requires
    build_streaming_citations and build_answer_citations to mint the SAME
    citation_id for a given cited alias."""
    ctx = CitationContext(turn_id="turn_stream")
    s1 = _mk_span("doc_x", "Westlaw AI hallucinated on 33% of legal queries in the audit.", 0)
    s2 = _mk_span("doc_x", "Lexis suggested incorrect citations in 17% of test prompts.", 1)
    ctx.register_spans([s1, s2])

    # Streamed mid-turn: all registered aliases, answer_id is the turn id.
    streamed = build_streaming_citations(
        ctx.aliases, answer_id=ctx.turn_id, thread_id="thr-1",
    )
    assert len(streamed) == 2  # all registered aliases, even if not yet cited

    # Finalized: only the alias actually cited in the answer, real message id.
    answer = "Only the first source is cited here {[S1]}."
    finalized, invalid = build_answer_citations(
        answer_text=answer, context=ctx, message_id="msg-real-id", thread_id="thr-1",
    )
    assert invalid == []
    assert len(finalized) == 1

    streamed_by_num = {c["display_number"]: c for c in streamed}
    final_by_num = {c["display_number"]: c for c in finalized}
    # Same citation_id despite different answer_id (turn vs message id) so the
    # rendered citation: href is stable across the stream -> finalize transition.
    assert streamed_by_num[1]["citation_id"] == final_by_num[1]["citation_id"]
    # And the id is deterministic (derived from span_id), not a random uuid.
    assert build_streaming_citations(ctx.aliases, answer_id="other", thread_id=None)[0][
        "citation_id"
    ] == streamed_by_num[1]["citation_id"]


def test_streaming_citations_are_lightweight_finalize_is_full():
    # Plan 23 A4: the streamed alias->source map omits the quote/exact passage
    # text to keep the SSE payload small even when every passage is citable; the
    # finalize citations carry the full quote/target for the cited subset.
    ctx = CitationContext(turn_id="turn_lw")
    s1 = _mk_span("doc_x", "A clearly citable sentence used in the answer here.", 0)
    ctx.register_spans([s1])

    streamed = build_streaming_citations(ctx.aliases, answer_id=ctx.turn_id, thread_id="t")
    assert streamed[0]["target"] == {"kind": "text_quote"}  # no exact passage text
    assert "quote" not in streamed[0]
    # Source chip metadata is still present so the chip can render mid-stream.
    assert streamed[0]["source"]["source_id"]
    assert streamed[0]["display_number"] == 1

    final, _ = build_answer_citations(
        answer_text="The finding is real {[S1]}.",
        context=ctx,
        message_id="m1",
        thread_id="t",
    )
    assert final[0]["quote"] == s1.text
    assert final[0]["target"]["exact"] == s1.text
    # Same citation_id across stream -> finalize, so chips don't churn.
    assert final[0]["citation_id"] == streamed[0]["citation_id"]


def test_newly_cited_aliases_upgrade_to_full_target_mid_stream():
    """As the answer streams, an alias the model actually cites upgrades from its
    lightweight source-chip entry to a full citation carrying target.exact, so a
    click can scroll the preview to the cited passage before the end-of-turn
    citation_metadata lands. Only cited aliases upgrade, and each upgrades once."""
    ctx = CitationContext(turn_id="turn_upgrade")
    s1 = _mk_span("doc_x", "First citable sentence about the holding.", 0)
    s2 = _mk_span("doc_x", "Second citable sentence about damages.", 1)
    ctx.register_spans([s1, s2])

    sent: set[int] = set()
    # Nothing cited yet -> nothing to upgrade.
    assert build_newly_cited_full_citations(
        ctx, "The answer begins", already_sent=sent, answer_id=ctx.turn_id, thread_id="t",
    ) == []
    assert sent == set()

    # S1 cited -> full target for S1 only, exactly once.
    first = build_newly_cited_full_citations(
        ctx, "The court held X {[S1]}.", already_sent=sent, answer_id=ctx.turn_id, thread_id="t",
    )
    assert [c["display_number"] for c in first] == [1]
    assert first[0]["target"]["exact"] == s1.text  # full, not lightweight
    assert first[0]["quote"] == s1.text
    assert sent == {1}

    # Re-parsing the now-longer text doesn't re-send S1, and adds S2.
    second = build_newly_cited_full_citations(
        ctx, "The court held X {[S1]}. Damages were Y {[S2]}.",
        already_sent=sent, answer_id=ctx.turn_id, thread_id="t",
    )
    assert [c["display_number"] for c in second] == [2]
    assert second[0]["target"]["exact"] == s2.text
    assert sent == {1, 2}


def test_mid_stream_full_citation_id_matches_lightweight_and_finalize():
    """The upgraded full citation shares its citation_id with both the lightweight
    streamed chip and the finalized citation, so the rendered chip's href is
    stable across lightweight -> full -> citation_metadata (no churn)."""
    ctx = CitationContext(turn_id="turn_ids")
    s1 = _mk_span("doc_y", "A stable-id citable sentence.", 0)
    ctx.register_spans([s1])

    light = build_streaming_citations(ctx.aliases, answer_id=ctx.turn_id, thread_id="t")[0]
    full = build_newly_cited_full_citations(
        ctx, "Cited here {[S1]}.", already_sent=set(), answer_id=ctx.turn_id, thread_id="t",
    )[0]
    finalized, _ = build_answer_citations(
        answer_text="Cited here {[S1]}.", context=ctx, message_id="m1", thread_id="t",
    )
    assert light["citation_id"] == full["citation_id"] == finalized[0]["citation_id"]
    # The lightweight chip has no passage text; the mid-stream upgrade does.
    assert light["target"] == {"kind": "text_quote"}
    assert full["target"]["exact"] == s1.text


# ---- Phase B: thread-stable numbering -------------------------------------

def test_span_registry_dict_roundtrips():
    s = _mk_span("doc_x", "A verbatim citable sentence.", 3)
    assert span_from_registry_dict(span_to_registry_dict(s)) == s
    # Unknown keys are tolerated (schema drift).
    d = span_to_registry_dict(s)
    d["bogus_field"] = "x"
    assert span_from_registry_dict(d) == s


def test_seed_keeps_thread_stable_numbers_across_turns():
    # Turn 1: register two spans -> S1, S2; capture the registry delta.
    t1 = CitationContext(turn_id="t1")
    s_a = _mk_span("doc_x", "Alpha sentence with enough length here.", 0)
    s_b = _mk_span("doc_x", "Bravo sentence with enough length here.", 1)
    t1.register_spans([s_a, s_b])
    registry = t1.registry_updates()
    assert {a.display_number for a in t1.aliases} == {1, 2}

    # Turn 2: a fresh context seeded from the registry. The same span keeps its
    # number; a new span numbers above the max.
    t2 = CitationContext(turn_id="t2")
    t2.seed_persisted_aliases(registry)
    s_c = _mk_span("doc_x", "Charlie sentence with enough length here.", 2)
    aliases = t2.register_spans([s_b, s_c])  # re-fetch B, introduce C
    by_text = {a.span.text: a.display_number for a in aliases}
    assert by_text["Bravo sentence with enough length here."] == 2   # stable
    assert by_text["Charlie sentence with enough length here."] == 3  # max + 1
    # Only C is a new assignment to persist.
    assert set(t2.registry_updates().keys()) == {s_c.span_id}
    # Seeded entries don't consume the per-turn alias list.
    assert {a.display_number for a in t2.aliases} == {2, 3}


def test_seed_next_number_survives_eviction_gaps():
    # A sparse registry (earlier spans evicted / never re-registered) must not
    # cause renumbering: the next new number is max+1, never a reused gap.
    registry = {
        "spanA": {"n": 2, "s": span_to_registry_dict(_mk_span("doc_x", "A.", 0))},
        "spanC": {"n": 5, "s": span_to_registry_dict(_mk_span("doc_x", "C.", 2))},
    }
    ctx = CitationContext(turn_id="t")
    ctx.seed_persisted_aliases(registry)
    new = _mk_span("doc_x", "Distinct new sentence with enough length here.", 9)
    [alias] = ctx.register_spans([new])
    assert alias.display_number == 6  # max(2, 5) + 1, not 1 or 3


def test_persisted_number_cited_from_history_resolves():
    # A {[S#]} cited from a prior turn's still-visible tool result resolves
    # against the registry even when no tool re-registered that span this turn.
    s_a = _mk_span("doc_x", "Historical passage cited again later.", 0)
    registry = {s_a.span_id: {"n": 7, "s": span_to_registry_dict(s_a)}}
    ctx = CitationContext(turn_id="t")
    ctx.seed_persisted_aliases(registry)
    rows, invalid = build_answer_citations(
        answer_text="As shown earlier {[S7]}.",
        context=ctx,
        message_id="m",
        thread_id="thr",
    )
    assert not invalid
    assert rows and rows[0]["display_number"] == 7
    assert rows[0]["quote"] == s_a.text


def test_two_turns_share_canonical_span_id_but_have_independent_aliases():
    text = "Reused factual statement appears in both turns verbatim."
    span_for_turn_a = _mk_span("doc_x", text, 0)
    span_for_turn_b = _mk_span("doc_x", text, 0)
    assert span_for_turn_a.span_id == span_for_turn_b.span_id

    ctx_a = CitationContext(turn_id="turn_a")
    ctx_b = CitationContext(turn_id="turn_b")
    # Pad turn B with one decoy first so the same span gets a different alias.
    decoy = _mk_span("doc_x", "Decoy sentence used only by turn B.", 1)
    ctx_b.register_spans([decoy])

    [alias_a] = ctx_a.register_spans([span_for_turn_a])
    [alias_b] = ctx_b.register_spans([span_for_turn_b])

    assert alias_a.display_number == 1
    assert alias_b.display_number == 2
    assert alias_a.span.span_id == alias_b.span.span_id


def test_max_aliases_per_turn_is_respected():
    ctx = CitationContext(turn_id="turn_cap", max_aliases=3)
    spans = [_mk_span("doc_x", f"Sentence number {i}.", i) for i in range(5)]
    registered = ctx.register_spans(spans)
    assert len(registered) == 3
    assert len(ctx.aliases) == 3


def test_format_evidence_block_emits_aliases():
    ctx = CitationContext(turn_id="turn_xyz")
    spans = [
        _mk_span("doc_x", "Pixar produced Toy Story.", 0),
        _mk_span("doc_x", "Dreamworks released Shrek.", 1),
    ]
    aliases = ctx.register_spans(spans)
    block = format_evidence_block(aliases)
    assert "{[S1]} Doc" in block
    assert "{[S2]} Doc" in block


def test_spans_from_search_chunks_adapter():
    chunks = [
        {
            "id": "c1",
            "content": "A factual span. Another factual span follows. And a third.",
            "metadata": {
                "filename": "report.pdf",
                "content_type": "application/pdf",
                "document_id": "doc-abc",
            },
            "document_id": "doc-abc",
        }
    ]
    spans = spans_from_search_chunks(chunks, thread_id=None, max_spans_per_chunk=2)
    assert 1 <= len(spans) <= 2
    assert all(s.source_type == "document" for s in spans)
    assert all(s.title == "report.pdf" for s in spans)


# --- Plan 15: citations quote verbatim citable_text, not enriched content ---

def test_spans_from_search_chunks_prefers_citable_text():
    """When a chunk carries the verbatim citable_text, spans quote it (not the
    enriched content), so every span is a verbatim slice of the source."""
    chunks = [
        {
            "id": "c1",
            # Enriched content as stored/embedded: synthetic part heading + headline.
            "content": (
                "## Section (Part 2)\nThis chunk is from a report, specifically "
                "The verbatim body sentence one. Body sentence two follows here."
            ),
            "citable_text": "The verbatim body sentence one. Body sentence two follows here.",
            "metadata": {"filename": "report.pdf", "document_id": "doc-abc"},
            "document_id": "doc-abc",
        }
    ]
    spans = spans_from_search_chunks(chunks, thread_id=None, max_spans_per_chunk=5)
    assert spans
    for s in spans:
        # Invariant: every span is a verbatim slice of citable_text, free of enrichment.
        assert s.text in chunks[0]["citable_text"]
        assert "(Part " not in s.text
        assert "This chunk is from" not in s.text


def test_spans_from_search_chunks_falls_back_to_content_without_citable_text():
    """Rows not yet re-ingested (no citable_text) still produce spans from content."""
    chunks = [
        {
            "id": "c1",
            "content": "A factual span. Another factual span follows. And a third.",
            "metadata": {"filename": "report.pdf", "document_id": "doc-abc"},
            "document_id": "doc-abc",
        }
    ]
    spans = spans_from_search_chunks(chunks, thread_id=None, max_spans_per_chunk=2)
    assert spans
    assert all(s.text in chunks[0]["content"] for s in spans)


def test_spans_from_document_sections_prefers_citable_text():
    chunks = [
        {
            "id": "chunk-7",
            "document_id": "doc-sections",
            "chunk_index": 7,
            "content": (
                "## 1.5 SUBMITTALS (Part 3)\n\n"
                "Section 0330 requires submittals for concrete mix design. "
                "Testing must be documented."
            ),
            "citable_text": (
                "Section 0330 requires submittals for concrete mix design. "
                "Testing must be documented."
            ),
            "metadata": {"content_type": "application/pdf"},
        }
    ]
    spans = spans_from_document_sections(
        chunks, title_by_document_id={"doc-sections": "manual.pdf"}
    )
    assert spans
    for s in spans:
        assert s.text in chunks[0]["citable_text"]
        assert "(Part " not in s.text


def test_content_type_for_document_title_promotes_pdf():
    # Shared by grep/read/get_document_sections/get_document_structure and the
    # analyze_document sub-agent: PDF filenames must render as the PDF page.
    assert content_type_for_document_title("brief.pdf") == "application/pdf"
    assert content_type_for_document_title("BRIEF.PDF") == "application/pdf"
    # Everything else keeps the markdown text view.
    assert content_type_for_document_title("manual.md") == "text/markdown"
    assert content_type_for_document_title("notes.txt") == "text/markdown"
    assert content_type_for_document_title(None) == "text/markdown"
    assert content_type_for_document_title("x.docx", fallback="text/plain") == "text/plain"


def test_spans_from_grep_result_adapter():
    result = (
        "Found 1 document(s) matching '18 U\\\\.S\\\\.C':\n\n"
        "**sample-documents.md** (id: cce2a085-771e-4780-b23c-026e1484cfa1)\n"
        "  Line 46: | 1 | `18 U.S.C. § 247A` | fabricated statute section |\n"
    )
    spans = spans_from_grep_result(result)

    assert len(spans) == 1
    assert spans[0].source_type == "document"
    assert spans[0].title == "sample-documents.md"
    assert spans[0].document_id == "cce2a085-771e-4780-b23c-026e1484cfa1"
    assert "18 U.S.C." in spans[0].text
    # Non-PDF sources keep the markdown text view.
    assert spans[0].content_type == "text/markdown"


def test_spans_from_grep_result_tags_pdf_sources_for_page_render():
    # A PDF-backed match must carry application/pdf so the citation panel shows
    # the PDF page render (with bbox highlights) instead of the text extraction.
    result = (
        "Found 1 document(s) matching 'RESA LATIOLAIS':\n\n"
        "**sample-legal-brief.pdf** (id: 870aa24c-6fa0-455b-9a0c-c118e9bfd7c)\n"
        "  Line 3: RESA LATIOLAIS, Plaintiff-Appellant\n"
    )
    spans = spans_from_grep_result(result)

    assert len(spans) == 1
    assert spans[0].title == "sample-legal-brief.pdf"
    assert spans[0].content_type == "application/pdf"


def test_spans_from_read_result_adapter():
    result = (
        "**Document: project-manual.md** (lines 12-15 of 40)\n\n"
        "12: Section 0330 covers cast-in-place concrete.\n"
        "13: Concrete materials must comply with ACI 301.\n"
        "14: Placement procedures are specified for slabs and formed surfaces.\n"
    )

    spans = spans_from_read_result(result, document_id="doc-read")

    assert spans
    assert spans[0].source_type == "document"
    assert spans[0].title == "project-manual.md"
    assert spans[0].document_id == "doc-read"
    assert "Section 0330" in " ".join(s.text for s in spans)
    # Non-PDF reads keep the markdown text view.
    assert all(s.content_type == "text/markdown" for s in spans)


def test_spans_from_read_result_tags_pdf_sources_for_page_render():
    result = (
        "**Document: sample-legal-brief.pdf** (lines 1-3 of 120)\n\n"
        "1: CASE NO. 13-30972 UNITED STATES COURT OF APPEALS FIFTH CIRCUIT\n"
        "2: RESA LATIOLAIS, Plaintiff-Appellant\n"
    )

    spans = spans_from_read_result(result, document_id="doc-pdf")

    assert spans
    assert spans[0].title == "sample-legal-brief.pdf"
    assert all(s.content_type == "application/pdf" for s in spans)


def test_spans_from_document_sections_adapter():
    chunks = [
        {
            "id": "chunk-7",
            "document_id": "doc-sections",
            "chunk_index": 7,
            "content": "Section 0330 requires submittals for concrete mix design. Testing must be documented.",
            "metadata": {"content_type": "application/pdf"},
        }
    ]

    spans = spans_from_document_sections(
        chunks,
        title_by_document_id={"doc-sections": "manual.pdf"},
    )

    assert spans
    assert spans[0].title == "manual.pdf"
    assert spans[0].chunk_id == "chunk-7"
    assert spans[0].document_id == "doc-sections"
    assert spans[0].content_type == "application/pdf"
    assert spans[0].start_char_in_chunk == 0


def test_spans_from_document_sections_infers_pdf_from_title_when_metadata_missing():
    # Chunk metadata commonly omits content_type (the RPC returns it as-is). A
    # PDF-backed expansion must still yield a PDF page render, not the text view.
    chunks = [
        {
            "id": "chunk-9",
            "document_id": "doc-pdf",
            "chunk_index": 9,
            "content": "RESA LATIOLAIS, Plaintiff-Appellant versus Donald Cravins, Sr.",
            "metadata": {},
        }
    ]

    spans = spans_from_document_sections(
        chunks,
        title_by_document_id={"doc-pdf": "sample-legal-brief.pdf"},
    )

    assert spans
    assert all(s.content_type == "application/pdf" for s in spans)


def test_spans_from_document_sections_keeps_later_list_blocks_citable():
    chunks = [
        {
            "id": "chunk-5",
            "document_id": "doc-sections",
            "chunk_index": 5,
            "content": (
                "## 1.5 INFORMATIONAL SUBMITTALS (Part 3)\n\n"
                "- A. Cold-Weather Placement: Comply with ACI 301 and ACI 306.1.\n"
                "- B. Hot-Weather Placement: Comply with ACI 301 and ACI 305.1.\n\n"
                "## PART 2 - PRODUCTS\n\n"
                "- 2.1 CONCRETE, GENERAL\n"
                "- A. ACI Publications: Comply with ACI 301 unless modified.\n"
                "- 2.2 CONCRETE MATERIALS\n"
                "- A. Cementitious Materials:\n"
                "1. Portland Cement: ASTM C150/C150M, Type I.\n"
                "2. Fly Ash: ASTM C618, Class C or F.\n"
            ),
            "metadata": {"content_type": "text/markdown"},
        }
    ]

    spans = spans_from_document_sections(
        chunks,
        title_by_document_id={"doc-sections": "manual.pdf"},
    )
    texts = [s.text for s in spans]

    assert any("ACI Publications" in text for text in texts)
    assert any("Cementitious Materials" in text and "Fly Ash" in text for text in texts)
    assert not any(text.strip() == "- 2.1 CONCRETE, GENERAL" for text in texts)


def test_spans_from_document_structure_adapter():
    hierarchy = (
        "# Project Manual [0-12]\n"
        "  ## Section 0330 Cast-in-Place Concrete [7-9]\n"
        "  Non-structural note without range\n"
    )

    spans = spans_from_document_structure(
        hierarchy,
        document_id="doc-structure",
        title="manual.md",
    )

    assert len(spans) == 2
    assert all(s.source_type == "document" for s in spans)
    assert spans[1].text == "## Section 0330 Cast-in-Place Concrete [7-9]"
    # Non-PDF structure keeps the markdown text view.
    assert all(s.content_type == "text/markdown" for s in spans)


def test_spans_from_document_structure_tags_pdf_sources():
    hierarchy = (
        "# Original Brief [0-12]\n"
        "  ## Statement of the Case [7-9]\n"
    )

    spans = spans_from_document_structure(
        hierarchy,
        document_id="doc-pdf",
        title="sample-legal-brief.pdf",
    )

    assert spans
    assert all(s.content_type == "application/pdf" for s in spans)


def test_spans_from_workspace_file_adapter():
    spans = spans_from_workspace_file(
        "The workspace note says cite this generated finding.",
        thread_id="thread-1",
        file_path="notes/findings.md",
        content_type="text/markdown",
    )

    assert spans
    assert spans[0].source_type == "workspace_file"
    assert spans[0].thread_id == "thread-1"
    assert spans[0].file_path == "notes/findings.md"
    assert spans[0].content_type == "text/markdown"


def test_sanitize_unowned_aliases_preserves_only_owned_numbers():
    text = "Use stale {[S1]}, keep {[S2]}, split {[S1, S3]}, recover [W2], drop [D9]."

    sanitized = sanitize_unowned_aliases(text, {2, 3})

    assert "{[S1]}" not in sanitized
    assert "[D9]" not in sanitized
    assert "{[S2]}" in sanitized
    assert "{[S3]}" in sanitized
    assert "[W2]" not in sanitized


def test_format_evidence_block_for_new_aliases_only_includes_later_spans():
    ctx = CitationContext(turn_id="turn_new_aliases", max_aliases=24)
    ctx.register_spans([_mk_span("doc_x", "Earlier evidence span.", 0)])
    previous_count = len(ctx.aliases)
    ctx.register_spans([_mk_span("doc_x", "New evidence span.", 1)])

    block = format_evidence_block_for_new_aliases(ctx, previous_count)

    assert "{[S1]}" not in block
    assert "{[S2]}" in block
    assert "New evidence span" in block


def test_format_evidence_block_for_alias_numbers_filters_turn_aliases():
    ctx = CitationContext(turn_id="turn_used_aliases", max_aliases=24)
    ctx.register_spans([
        _mk_span("doc_x", "First evidence span.", 0),
        _mk_span("doc_x", "Second evidence span.", 1),
        _mk_span("doc_x", "Third evidence span.", 2),
    ])

    block = format_evidence_block_for_alias_numbers(ctx, {3, 1, 99})

    assert "{[S1]}" in block
    assert "{[S2]}" not in block
    assert "{[S3]}" in block
    assert "Third evidence span" in block


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
    ],
)
def test_split_into_spans_handles_empty(text):
    assert split_into_spans(text) == []


def test_spans_from_web_results_uses_url_as_source_id():
    results = [
        {
            "title": "Akava: Demystifying Quantum Computing",
            "url": "https://akava.io/quantum-101",
            "content": "Quantum computers use qubits. Qubits can hold a 0 and a 1 simultaneously via superposition. Entanglement links pairs.",
        },
        {
            "title": "Quantum Inspire: Superposition",
            "url": "https://quantum-inspire.com/kbase/superposition",
            "content": "Superposition is the ability of a quantum system to be in many states at once. Measurement collapses it.",
        },
    ]
    spans = spans_from_web_results(results)
    assert len(spans) >= 2
    assert all(s.source_type == "web" for s in spans)
    assert {s.uri for s in spans} == {results[0]["url"], results[1]["url"]}
    # Same URL across turns hashes to the same canonical source_id.
    again = spans_from_web_results(results[:1])
    assert again[0].source_id == spans[0].source_id


def test_spans_from_web_results_cite_from_content_even_with_raw_content():
    raw = (
        "Galway's weather in June is mild and changeable. Average highs reach "
        "about 17 degrees Celsius. Rain is common, so pack a light waterproof "
        "jacket. Sea breezes keep the coast cooler than inland towns nearby."
    )
    content = "Galway June weather is mild."
    results = [{
        "title": "Galway Weather",
        "url": "https://example.com/galway",
        "content": content,
        "raw_content": raw,
    }]
    spans = spans_from_web_results(results)
    assert spans, "expected at least one span"
    # Web citation aliases must be generated from the snippet the model sees,
    # not from the raw page snapshot.
    for s in spans:
        assert s.text in content
        assert s.text not in raw
        if s.start_char_in_chunk is not None:
            assert content[s.start_char_in_chunk:s.end_char_in_chunk] == s.text
    assert spans[0].content_type == "text/html"


def test_clean_web_text_strips_markdown_image_and_link_syntax():
    raw = (
        "![logo](/img/logo.svg)\n\n"
        "The forecast for [Galway](https://met.ie/galway) is mild.\n\n\n\n"
        "![radar](https://met.ie/radar.png) Rain later.\n\n"
        "[](https://world-weather.info/) Home"  # empty-anchor link
    )
    cleaned = clean_web_text(raw)
    assert "![" not in cleaned  # images dropped
    assert "](http" not in cleaned  # link targets gone
    assert "Galway" in cleaned  # link anchor text kept
    assert "The forecast for Galway is mild." in cleaned
    assert "\n\n\n" not in cleaned  # blank-line runs collapsed
    assert "[]" not in cleaned  # empty-anchor link removed


def test_spans_from_web_results_ignores_cleaned_markdown_for_spans():
    raw = (
        "![hdr](/img/h.png)\n\n"
        "Galway sees frequent rain in June. Pack a [waterproof jacket]"
        "(https://shop.example/jacket) for the coast and inland towns alike."
    )
    content = "Short search snippet about Galway weather."
    results = [{"title": "Galway", "url": "https://example.com/g", "content": content, "raw_content": raw}]
    spans = spans_from_web_results(results)
    cleaned = clean_web_text(raw)
    assert spans
    for s in spans:
        assert s.text in content
        assert s.text not in cleaned


def test_spans_from_web_results_falls_back_to_snippet_without_raw():
    results = [{
        "title": "No raw",
        "url": "https://example.com/x",
        "content": "Only a snippet is available for this source right now.",
    }]
    spans = spans_from_web_results(results)
    assert spans
    assert spans[0].text in results[0]["content"]
    assert spans[0].content_type == "text/html"


def test_register_web_results_registers_aliases_and_stashes_snapshots():
    ctx = CitationContext(turn_id="t")
    results = [
        {
            "title": "Page A",
            "url": "https://a.example/post",
            "content": "snippet a",
            "raw_content": "Full page A text. It has several sentences worth citing here.",
        },
        {
            "title": "Page B (snippet only)",
            "url": "https://b.example/post",
            "content": "snippet b only, no raw content captured for this one at all.",
        },
    ]
    aliases = register_web_results(ctx, results, fetched_at="2026-06-02T00:00:00+00:00")
    assert aliases, "expected answer-local aliases"
    # Only the result with raw_content produces a snapshot, keyed by the same
    # source_id the spans carry.
    source_a = canonical_source_id(document_id=None, file_path=None, thread_id=None, uri="https://a.example/post")
    source_b = canonical_source_id(document_id=None, file_path=None, thread_id=None, uri="https://b.example/post")
    assert source_a in ctx.web_snapshots
    assert source_b not in ctx.web_snapshots
    snap = ctx.web_snapshots[source_a]
    assert snap["content"].startswith("Full page A text")
    assert snap["url"] == "https://a.example/post"
    assert snap["fetched_at"] == "2026-06-02T00:00:00+00:00"
    # Aliases reference spans whose source_id matches the stashed snapshot.
    assert any(a.span.source_id == source_a for a in ctx.aliases)
    assert any(a.span.source_id == source_a and a.span.text == "snippet a" for a in ctx.aliases)
    assert not any(a.span.text.startswith("Full page A text") for a in ctx.aliases)


def test_parse_aliases_accepts_canonical_form():
    ctx = CitationContext(turn_id="t")
    ctx.register_spans([
        EvidenceSpan(
            span_id=canonical_span_id("web_abc", "Some web text.", 0),
            source_id="web_abc",
            source_type="web",
            title="t",
            text="Some web text.",
        ),
    ])
    assert ctx.parse_aliases("Foo {[S1]} bar.") == [1]


def test_parse_aliases_falls_back_to_w_format_when_no_s_tokens():
    ctx = CitationContext(turn_id="t")
    ctx.register_spans([
        EvidenceSpan(
            span_id=canonical_span_id("web_abc", "Some web text.", 0),
            source_id="web_abc",
            source_type="web",
            title="t",
            text="Some web text.",
        ),
        EvidenceSpan(
            span_id=canonical_span_id("web_def", "Other web text.", 0),
            source_id="web_def",
            source_type="web",
            title="t",
            text="Other web text.",
        ),
    ])
    # Model produced [W#] convention; we should recover both as valid aliases.
    assert ctx.parse_aliases("Foo [W1] bar [W2].") == [1, 2]
    # Unknown numbers in fallback path are filtered to valid ids only.
    assert ctx.parse_aliases("Foo [W3] bar [W99].") == []


def test_parse_aliases_prefers_canonical_when_both_forms_present():
    ctx = CitationContext(turn_id="t")
    ctx.register_spans([
        EvidenceSpan(
            span_id=canonical_span_id("web_abc", "Some web text.", 0),
            source_id="web_abc",
            source_type="web",
            title="t",
            text="Some web text.",
        ),
    ])
    # Canonical {[S#]} takes precedence so we don't double-cite.
    assert ctx.parse_aliases("Foo {[S1]} bar [W1].") == [1]


def test_parse_aliases_handles_combined_brackets():
    ctx = CitationContext(turn_id="t")
    ctx.register_spans([
        EvidenceSpan(
            span_id=canonical_span_id("doc_a", "a.", 0),
            source_id="doc_a", source_type="document", title="a", text="a.",
        ),
        EvidenceSpan(
            span_id=canonical_span_id("doc_a", "b.", 1),
            source_id="doc_a", source_type="document", title="a", text="b.",
        ),
        EvidenceSpan(
            span_id=canonical_span_id("doc_a", "c.", 2),
            source_id="doc_a", source_type="document", title="a", text="c.",
        ),
    ])
    # Common LLM combined-citation format.
    assert ctx.parse_aliases("Foo {[S1, S2]} bar.") == [1, 2]
    # Three-way combined.
    assert ctx.parse_aliases("Foo {[S1, S2, S3]} bar.") == [1, 2, 3]
    # Drop-the-prefix form ({[S1, 2, 3]}).
    assert ctx.parse_aliases("Foo {[S1, 2, 3]} bar.") == [1, 2, 3]
    # Mixed singular + combined.
    assert ctx.parse_aliases("Foo {[S1]} bar {[S2, S3]}.") == [1, 2, 3]
    # Merged form: separate brackets inside one brace pair (what models emit).
    assert ctx.parse_aliases("Foo {[S1], [S2]} bar.") == [1, 2]
    assert ctx.parse_aliases("Foo {[S1], [S2], [S3]} bar.") == [1, 2, 3]
    # Adjacent canonical tokens stay distinct.
    assert ctx.parse_aliases("Foo {[S1]}{[S2]} bar.") == [1, 2]


def test_normalize_aliases_splits_combined_block_into_separate_chips():
    ctx = CitationContext(turn_id="t")
    ctx.register_spans([
        EvidenceSpan(
            span_id=canonical_span_id("doc_a", "a.", 0),
            source_id="doc_a", source_type="document", title="a", text="a.",
        ),
        EvidenceSpan(
            span_id=canonical_span_id("doc_a", "b.", 1),
            source_id="doc_a", source_type="document", title="a", text="b.",
        ),
    ])
    text = "transitions to authenticator app-based 2FA {[S1, S2]}."
    out = normalize_aliases_in_text(text, ctx)
    assert "{[S1]}{[S2]}" in out
    assert "{[S1, S2]}" not in out
    # Merged form (separate brackets in one brace pair) splits into adjacent chips.
    merged = normalize_aliases_in_text("Cited {[S1], [S2]}.", ctx)
    assert "{[S1]}{[S2]}" in merged
    assert "{[S1], [S2]}" not in merged


def test_normalize_aliases_drops_unknown_numbers_from_combined_block():
    ctx = CitationContext(turn_id="t")
    ctx.register_spans([
        EvidenceSpan(
            span_id=canonical_span_id("doc_a", "a.", 0),
            source_id="doc_a", source_type="document", title="a", text="a.",
        ),
    ])
    # Combined block with one valid and one invalid number; only the valid one survives.
    text = "Foo {[S1, S99]} bar."
    out = normalize_aliases_in_text(text, ctx)
    assert "{[S1]}" in out
    assert "S99" not in out


def test_normalize_aliases_rewrites_w_to_s():
    ctx = CitationContext(turn_id="t")
    ctx.register_spans([
        EvidenceSpan(
            span_id=canonical_span_id("web_abc", "Some web text.", 0),
            source_id="web_abc",
            source_type="web",
            title="t",
            text="Some web text.",
        ),
        EvidenceSpan(
            span_id=canonical_span_id("web_def", "Other web text.", 0),
            source_id="web_def",
            source_type="web",
            title="t",
            text="Other web text.",
        ),
    ])
    text = "Decoherence is real [W1]. Entanglement is too [W2]."
    normalized = normalize_aliases_in_text(text, ctx)
    assert "{[S1]}" in normalized
    assert "{[S2]}" in normalized
    assert "[W1]" not in normalized

    # If the canonical {[S#]} token is already present, leave text untouched.
    pure = "Already canonical {[S1]}."
    assert normalize_aliases_in_text(pure, ctx) == pure


def test_inline_label_result_injects_markers_in_place():
    ctx = CitationContext(turn_id="t")
    al = ctx.register_spans([
        _mk_span("doc_x", "Alpha bravo charlie sentence one.", 0),
        _mk_span("doc_x", "Delta echo foxtrot sentence two.", 1),
    ])
    content = (
        "[Source: Doc]\n(score)\n"
        "Alpha bravo charlie sentence one. Delta echo foxtrot sentence two."
    )
    out = inline_label_result(content, al)
    # Markers are injected immediately before each span, content otherwise intact.
    assert out == (
        "[Source: Doc]\n(score)\n"
        "{[S1]} Alpha bravo charlie sentence one. {[S2]} Delta echo foxtrot sentence two."
    )
    # Removing the injected markers recovers the original content exactly.
    assert out.replace("{[S1]} ", "").replace("{[S2]} ", "") == content


def test_inline_label_result_never_drops_markers():
    ctx = CitationContext(turn_id="t")
    al = ctx.register_spans([_mk_span("doc_x", "Text that is not in the result.", 0)])
    # Empty aliases -> unchanged.
    assert inline_label_result("some content", []) == "some content"
    # Span text absent from the result -> the marker is anchored at the cursor
    # rather than silently dropped, so the passage stays citable (Plan 23 A1).
    # No exception, and every registered alias still yields exactly one marker.
    out = inline_label_result("entirely different body", al)
    assert out == "{[S1]} entirely different body"


def test_inline_label_result_marks_every_registered_span():
    # Plan 23 A1: marker count == registered span count, even when a span doesn't
    # anchor verbatim (it falls back to a cursor anchor instead of being dropped).
    ctx = CitationContext(turn_id="t")
    body = "First sentence is present here. Second sentence is present here."
    aliases = ctx.register_spans([
        _mk_span("doc_x", "First sentence is present here.", 0),
        _mk_span("doc_x", "A whitespace reformatted span absent from the body.", 1),
        _mk_span("doc_x", "Second sentence is present here.", 2),
    ])
    out = inline_label_result(body, aliases)
    assert out.count("{[S1]}") == 1
    assert out.count("{[S2]}") == 1
    assert out.count("{[S3]}") == 1


def test_spans_from_search_chunks_registers_all_spans_without_cap():
    # Plan 23 A2: per-source caps removed -> a long chunk yields a span per
    # sentence, not a truncated prefix (the old default capped at 8 per chunk).
    sentences = " ".join(
        f"Sentence number {i} provides a good deal of distinct citable content."
        for i in range(20)
    )
    chunks = [{"id": "c1", "document_id": "doc_long", "content": sentences, "metadata": {}}]
    spans = spans_from_search_chunks(chunks, thread_id=None)
    assert len(spans) > 8


def test_inline_label_result_anchors_on_first_line_when_block_reformatted():
    ctx = CitationContext(turn_id="t")
    # Span text is a re-joined multi-line block whose exact form isn't a verbatim
    # substring of the result (extra blank line), but its first line is.
    al = ctx.register_spans([
        _mk_span("doc_x", "## D. Final Judgment\nThis disposes of all claims.", 0),
    ])
    content = "## D. Final Judgment\n\nThis disposes of all claims."
    out = inline_label_result(content, al)
    assert out.startswith("{[S1]} ## D. Final Judgment")


def test_inline_label_passages_renders_labeled_passages():
    ctx = CitationContext(turn_id="t")
    al = ctx.register_spans([
        EvidenceSpan(
            span_id=canonical_span_id("web_abc", "Page passage one.", 0),
            source_id="web_abc", source_type="web", title="Example", text="Page passage one.",
        ),
    ])
    block = inline_label_passages(al)
    assert "{[S1]} Example: Page passage one." in block
    assert inline_label_passages([]) == ""


def test_strip_alias_numbers_removes_only_invalid():
    text = "Granted JMOL {[S25]}. Vicarious liability {[S5, S25]}. Damages {[S73]}."
    out = strip_alias_numbers(text, {25, 73})
    assert "{[S25]}" not in out
    assert "{[S73]}" not in out
    # Still-valid member of a combined block survives.
    assert "{[S5]}" in out
    # No double spaces or stray space-before-period left behind.
    assert "  " not in out
    assert " ." not in out


def test_strip_alias_numbers_noop_without_numbers():
    text = "Keep {[S1]} and {[S2]} intact."
    assert strip_alias_numbers(text, set()) == text


def _with_pdf_box(
    citation: dict,
    *,
    item_id: str = "#/texts/1",
    page: int = 4,
    top: float = 540.0,
    bottom: float = 420.0,
) -> dict:
    citation["target"] = {
        **citation["target"],
        "page": page,
        "bboxes": [
            {
                "page": page,
                "l": 72.0,
                "t": top,
                "r": 510.0,
                "b": bottom,
                "coord_origin": "BOTTOMLEFT",
                "item_id": item_id,
            }
        ],
    }
    return citation


def test_merge_same_pdf_highlight_citation_runs_merges_adjacent_aliases():
    ctx = CitationContext(turn_id="turn_merge")
    ctx.register_spans([
        _mk_span("doc_x", "Resa was investigated for food stamp fraud.", 0),
        _mk_span("doc_x", "She was investigated by OCS on two occasions.", 1),
        _mk_span("doc_x", "A different paragraph supports this point.", 2),
    ])
    answer = "The custody conflict escalated through several events {[S1]}{[S2]}{[S3]}."
    citations, invalid = build_answer_citations(
        answer_text=answer, context=ctx, message_id="msg-merge", thread_id="thr-1",
    )
    assert invalid == []
    citations = [
        _with_pdf_box(citations[0]),
        _with_pdf_box(citations[1]),
        _with_pdf_box(citations[2], item_id="#/texts/2"),
    ]

    rewritten, merged = merge_same_pdf_highlight_citation_runs(answer, citations)

    assert rewritten == "The custody conflict escalated through several events {[S1]}{[S3]}."
    assert [c["display_number"] for c in merged] == [1, 3]
    assert merged[0]["quote"] == (
        "Resa was investigated for food stamp fraud. "
        "She was investigated by OCS on two occasions."
    )
    assert merged[0]["target"]["exact"] == merged[0]["quote"]
    assert merged[0]["target"]["bboxes"] == citations[0]["target"]["bboxes"]


def test_merge_same_pdf_highlight_citation_runs_merges_cross_page_same_item():
    ctx = CitationContext(turn_id="turn_cross_page")
    ctx.register_spans([
        _mk_span("doc_x", "Brad became enraged with Resa once she began seeing another man,", 0),
        _mk_span("doc_x", "and engaged in unlawful behavior.", 1),
        _mk_span("doc_x", "A later unrelated paragraph starts here.", 2),
    ])
    answer = "The brief says the conduct crossed a page break {[S1]}{[S2]}{[S3]}."
    citations, invalid = build_answer_citations(
        answer_text=answer, context=ctx, message_id="msg-cross-page", thread_id="thr-1",
    )
    assert invalid == []
    citations = [
        _with_pdf_box(citations[0], item_id="#/texts/43", page=8, top=327.9, bottom=93.8),
        _with_pdf_box(citations[1], item_id="#/texts/43", page=9, top=714.3, bottom=641.1),
        _with_pdf_box(citations[2], item_id="#/texts/44", page=9, top=610.0, bottom=580.0),
    ]

    rewritten, merged = merge_same_pdf_highlight_citation_runs(answer, citations)

    assert rewritten == "The brief says the conduct crossed a page break {[S1]}{[S3]}."
    assert [c["display_number"] for c in merged] == [1, 3]
    assert merged[0]["quote"] == (
        "Brad became enraged with Resa once she began seeing another man, "
        "and engaged in unlawful behavior."
    )
    assert merged[0]["target"]["page"] == 8
    assert [box["page"] for box in merged[0]["target"]["bboxes"]] == [8, 9]
    assert [box["item_id"] for box in merged[0]["target"]["bboxes"]] == ["#/texts/43", "#/texts/43"]


def test_merge_same_pdf_highlight_citation_runs_keeps_separate_clauses():
    ctx = CitationContext(turn_id="turn_no_merge")
    ctx.register_spans([
        _mk_span("doc_x", "First fact in a Docling paragraph.", 0),
        _mk_span("doc_x", "Second fact in the same Docling paragraph.", 1),
    ])
    answer = "First fact is cited here {[S1]}. A later clause cites the second fact {[S2]}."
    citations, invalid = build_answer_citations(
        answer_text=answer, context=ctx, message_id="msg-no-merge", thread_id="thr-1",
    )
    assert invalid == []
    citations = [_with_pdf_box(c) for c in citations]

    rewritten, merged = merge_same_pdf_highlight_citation_runs(answer, citations)

    assert rewritten == answer
    assert [c["display_number"] for c in merged] == [1, 2]


def test_merge_same_pdf_highlight_citation_runs_keeps_alias_used_elsewhere():
    ctx = CitationContext(turn_id="turn_repeated")
    ctx.register_spans([
        _mk_span("doc_x", "Food stamp fraud was alleged.", 0),
        _mk_span("doc_x", "Simple battery was charged later.", 1),
    ])
    answer = "The events are grouped here {[S1]}{[S2]}. Battery is cited again later {[S2]}."
    citations, invalid = build_answer_citations(
        answer_text=answer, context=ctx, message_id="msg-repeat", thread_id="thr-1",
    )
    assert invalid == []
    citations = [_with_pdf_box(c) for c in citations]

    rewritten, merged = merge_same_pdf_highlight_citation_runs(answer, citations)

    assert rewritten == "The events are grouped here {[S1]}. Battery is cited again later {[S2]}."
    assert [c["display_number"] for c in merged] == [1, 2]
    assert merged[0]["quote"] == "Food stamp fraud was alleged. Simple battery was charged later."
    assert merged[1]["quote"] == "Simple battery was charged later."


def test_register_spans_stops_at_cap_and_warns(caplog):
    ctx = CitationContext(turn_id="turn_cap", max_aliases=2)
    spans = [_mk_span("doc_x", f"Sentence number {i} here.", i) for i in range(4)]
    with caplog.at_level("WARNING"):
        registered = ctx.register_spans(spans)
    assert len(registered) == 2
    assert len(ctx.aliases) == 2
    assert any("alias cap reached" in r.message for r in caplog.records)
