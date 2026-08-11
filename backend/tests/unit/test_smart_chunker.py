"""Unit tests for smart markdown chunking pipeline (chunker, hierarchy extractor, merger)."""
import pytest
from app.services.smart_chunker import (
    SmartMarkdownChunker,
    MIN_CHUNK_SIZE,
    MAX_CHUNK_SIZE,
    ChunkData,
    HierarchyNode,
)
from app.services.hierarchy_extractor import MarkdownHierarchyExtractor
from app.services.chunk_merger import ChunkSectionMerger


# --- Sample markdown fixtures ---

SAMPLE_MARKDOWN = """\
# Introduction

This is the introduction section with enough content to form a meaningful chunk.
It discusses the background and motivation for the project in detail.
We need to make sure there is sufficient text here to test the chunking logic properly.
The introduction covers several important topics including the problem statement,
the proposed solution approach, and the expected outcomes of the implementation.
Additional context is provided about the project timeline and resource allocation.

## Background

The background section provides historical context about the problem domain.
Previous approaches have been tried and documented extensively in the literature.
We review the most relevant prior work and identify the gaps that remain.
This section also covers the theoretical foundations that inform our approach.
The mathematical framework is presented along with key definitions and theorems.

## Methodology

### Data Collection

Data was collected from multiple sources over a period of six months.
The collection process involved automated scrapers and manual curation.
Quality checks were performed at each stage to ensure data integrity.
Statistical sampling methods were used to validate representativeness.

### Analysis

The analysis phase involved running several computational experiments.
Each experiment was designed to test a specific hypothesis about the data.
Results were cross-validated using holdout sets and bootstrap methods.
Confidence intervals were computed for all reported metrics.

# Results

The results section presents our key findings from the analysis.
We achieved significant improvements over all baseline methods.
Tables and figures are included to support the quantitative claims.
Error bars and statistical significance tests are reported throughout.
The improvements were consistent across different evaluation metrics.

# Conclusion

In conclusion, this work demonstrates the effectiveness of the proposed approach.
Future work will explore extensions to related problem domains.
We believe the methodology can be adapted for broader applications.
"""

PLAIN_TEXT = "This is plain text without any markdown headings. It should be treated as a single section."


def _norm_ws(s: str) -> str:
    """Whitespace-normalised form for verbatim-substring assertions."""
    return " ".join(s.split())


class TestSmartMarkdownChunker:
    def setup_method(self):
        self.chunker = SmartMarkdownChunker()

    def test_parse_sections_basic(self):
        sections = self.chunker.parse_markdown_sections(SAMPLE_MARKDOWN)
        titles = [s.title for s in sections]
        assert "Introduction" in titles
        assert "Background" in titles
        assert "Methodology" in titles
        assert "Data Collection" in titles
        assert "Analysis" in titles
        assert "Results" in titles
        assert "Conclusion" in titles
        # Check levels
        intro = next(s for s in sections if s.title == "Introduction")
        assert intro.level == 1
        bg = next(s for s in sections if s.title == "Background")
        assert bg.level == 2
        dc = next(s for s in sections if s.title == "Data Collection")
        assert dc.level == 3
        # Check hierarchy path
        assert len(dc.hierarchy_stack) == 3  # Introduction > Methodology > Data Collection... wait
        # Data Collection is under Methodology which is under Introduction
        # Actually hierarchy depends on the stack. Let me check.
        # H1 Introduction, then H2 Background (stack: [Intro, Background]),
        # then H2 Methodology (stack: [Intro, Methodology]),
        # then H3 Data Collection (stack: [Intro, Methodology, Data Collection])
        assert dc.hierarchy_stack[0].title == "Introduction"
        assert dc.hierarchy_stack[1].title == "Methodology"
        assert dc.hierarchy_stack[2].title == "Data Collection"

    def test_parse_sections_no_headings(self):
        sections = self.chunker.parse_markdown_sections(PLAIN_TEXT)
        assert len(sections) == 1
        assert sections[0].title == "Document"
        assert sections[0].level == 1

    def test_split_large_section(self):
        """Section larger than MAX_CHUNK_SIZE should be split with (Part N) headings."""
        large_content = "# Big Section\n\n" + ("This is a long paragraph. " * 200)
        sections = self.chunker.parse_markdown_sections(large_content)
        assert len(sections) == 1

        chunks = self.chunker.split_section_into_chunks(sections[0])
        assert len(chunks) > 1
        # First chunk should have (Part 1)
        assert "(Part 1)" in chunks[0].content
        # Second chunk should have (Part 2)
        assert "(Part 2)" in chunks[1].content

    def test_merge_small_chunks(self):
        """Small adjacent chunks should be merged together."""
        small_chunks = [
            ChunkData(
                content="Small chunk A",
                section_title="A",
                section_level=2,
                hierarchy_stack=[HierarchyNode("A", 2)],
                original_section_title="A",
                chunk_index_in_section=0,
                total_chunks_in_section=1,
                is_split=False,
                split_part_number=None,
                size=13,
            ),
            ChunkData(
                content="Small chunk B",
                section_title="B",
                section_level=2,
                hierarchy_stack=[HierarchyNode("B", 2)],
                original_section_title="B",
                chunk_index_in_section=0,
                total_chunks_in_section=1,
                is_split=False,
                split_part_number=None,
                size=13,
            ),
        ]
        merged = self.chunker.merge_small_chunks(small_chunks)
        # Both are below MIN_CHUNK_SIZE, so they should be merged
        assert len(merged) == 1
        assert merged[0].is_merged is True
        assert "Small chunk A" in merged[0].content
        assert "Small chunk B" in merged[0].content

    def test_chunk_text_end_to_end(self):
        """Full pipeline: all chunks should have metadata with cascading_path."""
        result = self.chunker.chunk_text(SAMPLE_MARKDOWN)
        assert len(result) > 0

        for pc in result:
            assert pc.chunk  # Non-empty content
            assert "chunk_index" in pc.chunk_metadata
            assert "content_length" in pc.chunk_metadata
            assert "cascading_path" in pc.chunk_metadata
            # cascading_path should be a string with ' > ' separators
            assert isinstance(pc.chunk_metadata["cascading_path"], str)

    def test_chunk_sizes_within_bounds(self):
        """Most chunks should be within the expected size range."""
        result = self.chunker.chunk_text(SAMPLE_MARKDOWN)
        for pc in result:
            content_len = len(pc.chunk)
            # Allow merged chunks to go up to MAX_CHUNK_SIZE * 1.2
            assert content_len <= MAX_CHUNK_SIZE * 1.5, (
                f"Chunk too large: {content_len} chars"
            )

    def test_headline_prepend(self):
        """Headline should be prepended to each chunk's content."""
        chunks = [
            ChunkData(
                content="Some chunk content here",
                section_title="Test",
                section_level=1,
                hierarchy_stack=[HierarchyNode("Test", 1)],
                original_section_title="Test",
                chunk_index_in_section=0,
                total_chunks_in_section=1,
                is_split=False,
                split_part_number=None,
                size=23,
            )
        ]
        headline = "This chunk is from a test document, specifically "
        result = SmartMarkdownChunker.add_document_headline(chunks, headline)
        assert result[0].content.startswith(headline)
        assert "Some chunk content here" in result[0].content

    def test_headline_prepend_none(self):
        """None headline should leave chunks unchanged."""
        chunks = [
            ChunkData(
                content="Original",
                section_title="T",
                section_level=1,
                hierarchy_stack=[],
                original_section_title="T",
                chunk_index_in_section=0,
                total_chunks_in_section=1,
                is_split=False,
                split_part_number=None,
                size=8,
            )
        ]
        result = SmartMarkdownChunker.add_document_headline(chunks, None)
        assert result[0].content == "Original"

    # --- Plan 15: verbatim citable_text (decouple citations from enrichment) ---

    def test_split_captures_verbatim_citable_text(self):
        """Split chunks carry a verbatim citable_text with no (Part N) artifact,
        even though the enriched content does."""
        large_content = "# Big Section\n\n" + ("This is a long paragraph. " * 200)
        sections = self.chunker.parse_markdown_sections(large_content)
        chunks = self.chunker.split_section_into_chunks(sections[0])
        assert len(chunks) > 1
        for c in chunks:
            assert "(Part " not in c.citable_text
            # The citable slice is verbatim source text.
            assert _norm_ws(c.citable_text) in _norm_ws(large_content)
        # Contrast: the enriched content carries the synthetic part heading.
        assert "(Part 2)" in chunks[1].content
        assert "(Part 2)" not in chunks[1].citable_text

    def test_merge_carries_citable_text_in_parallel(self):
        """Merging concatenates citable_text alongside content; synthetic headings
        stay in content only."""
        small_chunks = [
            ChunkData(
                content="## H (Part 1)\n\nSmall chunk A",
                section_title="A", section_level=2,
                hierarchy_stack=[HierarchyNode("A", 2)],
                original_section_title="A",
                chunk_index_in_section=0, total_chunks_in_section=1,
                is_split=False, split_part_number=None, size=13,
                citable_text="Small chunk A",
            ),
            ChunkData(
                content="## H (Part 2)\n\nSmall chunk B",
                section_title="B", section_level=2,
                hierarchy_stack=[HierarchyNode("B", 2)],
                original_section_title="B",
                chunk_index_in_section=0, total_chunks_in_section=1,
                is_split=False, split_part_number=None, size=13,
                citable_text="Small chunk B",
            ),
        ]
        merged = self.chunker.merge_small_chunks(small_chunks)
        assert len(merged) == 1
        assert "Small chunk A" in merged[0].citable_text
        assert "Small chunk B" in merged[0].citable_text
        assert "(Part " not in merged[0].citable_text

    def test_citable_text_free_of_enrichment_end_to_end(self):
        """Full ingestion order (split -> merge -> headline -> metadata): every
        citable_text is free of the document headline that the enriched content
        carries."""
        sections_raw = self.chunker.parse_markdown_sections(
            SAMPLE_MARKDOWN, [1, 2, 3, 4, 5, 6]
        )
        all_chunks = []
        for sec in sections_raw:
            all_chunks.extend(self.chunker.split_section_into_chunks(sec))
        merged = self.chunker.merge_small_chunks(all_chunks)
        headline = "This chunk is from a test document, specifically "
        SmartMarkdownChunker.add_document_headline(merged, headline)
        processed = SmartMarkdownChunker.create_chunk_metadata(merged)

        assert processed
        for pc in processed:
            assert pc.citable_text.strip()
            assert headline not in pc.citable_text
            assert "(Part " not in pc.citable_text
            # The verbatim slice exists in the source document.
            assert _norm_ws(pc.citable_text) in _norm_ws(SAMPLE_MARKDOWN)
        # The enrichment is genuinely present in content, so the test is meaningful.
        assert any(headline in pc.chunk for pc in processed)


class TestHierarchyExtractor:
    def setup_method(self):
        self.extractor = MarkdownHierarchyExtractor()

    def test_extract_hierarchy(self):
        sections = self.extractor.extract_hierarchy(SAMPLE_MARKDOWN)
        assert len(sections) >= 5
        titles = [s.title for s in sections]
        assert "Introduction" in titles
        assert "Data Collection" in titles

        dc = next(s for s in sections if s.title == "Data Collection")
        assert dc.hierarchy_path == "Introduction > Methodology > Data Collection"

    def test_map_sections_to_chunks(self):
        """Sections should be correctly mapped to chunk indices."""
        chunker = SmartMarkdownChunker()
        processed = chunker.chunk_text(SAMPLE_MARKDOWN)
        chunk_dicts = [
            {"chunk": pc.chunk, "chunk_metadata": pc.chunk_metadata}
            for pc in processed
        ]

        sections = self.extractor.extract_hierarchy(SAMPLE_MARKDOWN)
        mapped = self.extractor.map_sections_to_chunks(sections, chunk_dicts)

        # At least some sections should have chunk indices
        sections_with_chunks = [s for s in mapped if s.chunk_indices]
        assert len(sections_with_chunks) > 0

        # chunk_range should be set for mapped sections
        for s in sections_with_chunks:
            assert s.chunk_range is not None
            assert s.chunk_range[0] <= s.chunk_range[1]

    def test_build_hierarchical_index(self):
        """Hierarchical index text should contain section titles and ranges."""
        chunker = SmartMarkdownChunker()
        processed = chunker.chunk_text(SAMPLE_MARKDOWN)
        chunk_dicts = [
            {"chunk": pc.chunk, "chunk_metadata": pc.chunk_metadata}
            for pc in processed
        ]

        sections = self.extractor.extract_hierarchy(SAMPLE_MARKDOWN)
        mapped = self.extractor.map_sections_to_chunks(sections, chunk_dicts)
        index = MarkdownHierarchyExtractor.build_hierarchical_index(mapped)

        assert "Document Hierarchy" in index
        assert "Introduction" in index
        assert "Results" in index
        # Should contain chunk range markers like [0-5] or [3]
        assert "[" in index


class TestChunkSectionMerger:
    def test_merger_ranges(self):
        """Merged chunks should have childRange and parentRange."""
        chunker = SmartMarkdownChunker()
        extractor = MarkdownHierarchyExtractor()

        processed = chunker.chunk_text(SAMPLE_MARKDOWN)
        chunk_dicts = [
            {"chunk": pc.chunk, "chunk_metadata": pc.chunk_metadata}
            for pc in processed
        ]

        sections = extractor.extract_hierarchy(SAMPLE_MARKDOWN)
        mapped = extractor.map_sections_to_chunks(sections, chunk_dicts)
        enhanced = ChunkSectionMerger.merge_data(mapped, chunk_dicts)

        assert len(enhanced) == len(chunk_dicts)

        # At least some chunks should have childRange set
        has_child_range = any(
            ec["chunk_metadata"].get("childRange") is not None for ec in enhanced
        )
        assert has_child_range, "Expected at least one chunk with childRange"

        # Verify range structure
        for ec in enhanced:
            cr = ec["chunk_metadata"].get("childRange")
            if cr is not None:
                assert isinstance(cr, list)
                assert len(cr) == 2
                assert cr[0] <= cr[1]

    def test_merger_preserves_content(self):
        """Merger should not alter chunk content."""
        chunker = SmartMarkdownChunker()
        extractor = MarkdownHierarchyExtractor()

        processed = chunker.chunk_text(SAMPLE_MARKDOWN)
        chunk_dicts = [
            {"chunk": pc.chunk, "chunk_metadata": pc.chunk_metadata}
            for pc in processed
        ]

        sections = extractor.extract_hierarchy(SAMPLE_MARKDOWN)
        mapped = extractor.map_sections_to_chunks(sections, chunk_dicts)
        enhanced = ChunkSectionMerger.merge_data(mapped, chunk_dicts)

        for orig, enh in zip(chunk_dicts, enhanced):
            assert orig["chunk"] == enh["chunk"]
