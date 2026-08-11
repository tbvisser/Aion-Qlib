import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# Chunk size constants
MIN_CHUNK_SIZE = 400
TARGET_CHUNK_SIZE = 600
MAX_CHUNK_SIZE = 800
MAX_HEADING_LENGTH = 200

# Markdown-aware separators (ordered by preference)
MARKDOWN_SEPARATORS = [
    "\n## ", "\n### ", "\n#### ", "\n##### ", "\n###### ",
    "```\n\n", "\n\n***\n\n", "\n\n---\n\n", "\n\n___\n\n",
    "\n\n", "\n", ". ", " ", "",
]


@dataclass
class HierarchyNode:
    title: str
    level: int


@dataclass
class Section:
    title: str
    level: int
    hierarchy_stack: list[HierarchyNode]
    content: str
    original_title: str


@dataclass
class ChunkData:
    content: str
    section_title: str
    section_level: int
    hierarchy_stack: list[HierarchyNode]
    original_section_title: str
    chunk_index_in_section: int
    total_chunks_in_section: int
    is_split: bool
    split_part_number: int | None
    size: int
    is_merged: bool = False
    merged_chunk_count: int = 1
    original_chunks: list | None = None
    # Verbatim source slice for citations: the raw split piece before any
    # synthetic heading / "(Part N)" / document-headline enrichment is applied.
    citable_text: str = ""


@dataclass
class ProcessedChunk:
    chunk: str
    chunk_metadata: dict = field(default_factory=dict)
    citable_text: str = ""


class SmartMarkdownChunker:
    """Markdown-aware text chunker that preserves document structure."""

    def __init__(
        self,
        min_chunk_size: int = MIN_CHUNK_SIZE,
        max_chunk_size: int = MAX_CHUNK_SIZE,
        target_chunk_size: int = TARGET_CHUNK_SIZE,
    ):
        self.min_chunk_size = min_chunk_size
        self.max_chunk_size = max_chunk_size
        self.target_chunk_size = target_chunk_size

    def parse_markdown_sections(
        self, markdown: str, heading_levels: list[int] | None = None
    ) -> list[Section]:
        """Step 1: Parse markdown by headings into sections with hierarchy tracking."""
        if heading_levels is None:
            heading_levels = [1, 2, 3, 4, 5, 6]

        lines = markdown.split("\n")
        sections: list[Section] = []
        current_section: Section | None = None
        current_content: list[str] = []
        hierarchy_stack: list[HierarchyNode] = []
        preamble_lines: list[str] = []  # Content before first heading

        for line in lines:
            heading_match = re.match(r"^(#+)\s*(.*)$", line)

            if heading_match:
                level = len(heading_match.group(1))

                if level in heading_levels:
                    # Save previous section
                    if current_section is not None and current_content:
                        current_section.content = "\n".join(current_content)
                        sections.append(current_section)
                    elif current_section is None and current_content:
                        # Save preamble content (before any heading)
                        preamble_lines = current_content

                    original_title = heading_match.group(2).strip()
                    display_title = original_title
                    if len(display_title) > MAX_HEADING_LENGTH:
                        display_title = display_title[: MAX_HEADING_LENGTH - 3] + "..."

                    # Update hierarchy stack
                    while len(hierarchy_stack) >= level:
                        hierarchy_stack.pop()
                    hierarchy_stack.append(HierarchyNode(display_title, level))

                    current_section = Section(
                        title=display_title,
                        level=level,
                        hierarchy_stack=[
                            HierarchyNode(n.title, n.level) for n in hierarchy_stack
                        ],
                        content="",
                        original_title=original_title,
                    )
                    current_content = [line]
                else:
                    current_content.append(line)
            else:
                current_content.append(line)

        # Don't forget the last section
        if current_section is not None and current_content:
            current_section.content = "\n".join(current_content)
            sections.append(current_section)

        # Prepend preamble content to first section if present
        if preamble_lines and sections:
            preamble_text = "\n".join(preamble_lines).strip()
            if preamble_text:
                sections[0].content = preamble_text + "\n\n" + sections[0].content

        # If no headings found, treat entire document as one section
        if not sections:
            sections.append(
                Section(
                    title="Document",
                    level=1,
                    hierarchy_stack=[HierarchyNode("Document", 1)],
                    content=markdown,
                    original_title="Document",
                )
            )

        return sections

    def recursive_markdown_split(
        self, text: str, separators: list[str] | None = None
    ) -> list[str]:
        """Step 2: Recursive markdown-aware splitting within sections."""
        if separators is None:
            separators = MARKDOWN_SEPARATORS
        if len(text) <= self.max_chunk_size:
            return [text]

        for sep_idx, separator in enumerate(separators):
            if separator == "":
                # Character-by-character splitting as last resort
                chunks = []
                for i in range(0, len(text), self.max_chunk_size):
                    chunks.append(text[i : i + self.max_chunk_size])
                return chunks

            if separator in text:
                parts = text.split(separator)
                chunks: list[str] = []
                current_chunk = ""

                for i, part in enumerate(parts):
                    # Re-attach separator for all parts except a non-empty first part
                    piece = part if (i == 0 and part) else separator + part

                    if len(current_chunk) + len(piece) <= self.max_chunk_size:
                        current_chunk += piece
                    else:
                        if current_chunk:
                            chunks.append(current_chunk)

                        # If this piece is still too large, recursively split it
                        if len(piece) > self.max_chunk_size:
                            chunks.extend(
                                self.recursive_markdown_split(
                                    piece, separators[sep_idx + 1 :]
                                )
                            )
                            current_chunk = ""
                        else:
                            current_chunk = piece

                if current_chunk:
                    chunks.append(current_chunk)
                return [c for c in chunks if c.strip()]

        return [text]

    def split_section_into_chunks(self, section: Section) -> list[ChunkData]:
        """Split a single section into appropriately sized chunks."""
        raw_chunks = self.recursive_markdown_split(section.content)

        results: list[ChunkData] = []
        for index, chunk_content in enumerate(raw_chunks):
            final_content = chunk_content.strip()
            # Capture the verbatim slice now, before the synthetic heading /
            # "(Part N)" enrichment below mutates final_content. Strings are
            # immutable, so this keeps the pre-enrichment value.
            citable_text = final_content

            # For split chunks, add the original section heading with part number
            if len(raw_chunks) > 1:
                heading_prefix = "#" * section.level

                if index == 0:
                    original_heading = (
                        f"{heading_prefix} {section.original_title} (Part {index + 1})"
                    )
                    lines = final_content.split("\n")
                    if re.match(r"^#+\s", lines[0]):
                        lines[0] = original_heading
                        final_content = "\n".join(lines)
                    else:
                        final_content = f"{original_heading}\n\n{final_content}"
                else:
                    title_for_heading = section.original_title
                    part_suffix = f" (Part {index + 1})"
                    max_title_length = (
                        MAX_HEADING_LENGTH - len(heading_prefix) - len(part_suffix) - 1
                    )
                    if len(title_for_heading) > max_title_length:
                        title_for_heading = (
                            title_for_heading[: max_title_length - 3] + "..."
                        )
                    original_heading = (
                        f"{heading_prefix} {title_for_heading}{part_suffix}"
                    )
                    final_content = f"{original_heading}\n\n{final_content}"

            results.append(
                ChunkData(
                    content=final_content,
                    section_title=section.title,
                    section_level=section.level,
                    hierarchy_stack=section.hierarchy_stack,
                    original_section_title=section.original_title,
                    chunk_index_in_section=index,
                    total_chunks_in_section=len(raw_chunks),
                    is_split=len(raw_chunks) > 1,
                    split_part_number=index + 1 if len(raw_chunks) > 1 else None,
                    size=len(final_content),
                    citable_text=citable_text,
                )
            )

        return results

    def merge_small_chunks(self, chunks: list[ChunkData]) -> list[ChunkData]:
        """Step 3: Merge small chunks intelligently to meet minimum size."""
        result: list[ChunkData] = []
        i = 0

        while i < len(chunks):
            current = chunks[i]

            if current.size >= self.min_chunk_size:
                result.append(current)
                i += 1
                continue

            # Try to merge with next chunk(s)
            merged_content = current.content
            merged_citable = current.citable_text
            merged_size = current.size
            chunks_to_merge = [current]
            j = i + 1

            hard_cap = self.max_chunk_size * 2  # Absolute upper bound for merges
            while j < len(chunks) and merged_size < self.min_chunk_size:
                next_chunk = chunks[j]
                test_size = merged_size + next_chunk.size + 2  # +2 for \n\n

                # Stop if we'd exceed the hard cap
                if test_size > hard_cap:
                    break

                if (
                    test_size <= self.max_chunk_size * 1.2
                    or merged_size < self.min_chunk_size
                ):
                    merged_content += "\n\n" + next_chunk.content
                    merged_citable += "\n\n" + next_chunk.citable_text
                    merged_size = test_size
                    chunks_to_merge.append(next_chunk)
                    j += 1
                else:
                    break

            split_chunk = next(
                (c for c in chunks_to_merge if c.is_split), None
            )

            merged = ChunkData(
                content=merged_content,
                section_title=current.section_title,
                section_level=current.section_level,
                hierarchy_stack=current.hierarchy_stack,
                original_section_title=current.original_section_title,
                chunk_index_in_section=current.chunk_index_in_section,
                total_chunks_in_section=current.total_chunks_in_section,
                is_split=split_chunk.is_split if split_chunk else current.is_split,
                split_part_number=(
                    split_chunk.split_part_number
                    if split_chunk
                    else current.split_part_number
                ),
                size=merged_size,
                is_merged=len(chunks_to_merge) > 1,
                merged_chunk_count=len(chunks_to_merge),
                original_chunks=chunks_to_merge if len(chunks_to_merge) > 1 else None,
                citable_text=merged_citable,
            )

            result.append(merged)
            i = j

        return result

    @staticmethod
    def add_document_headline(
        chunks: list[ChunkData], headline: str | None
    ) -> list[ChunkData]:
        """Step 4: Insert document headline after the first heading line in each chunk."""
        if not headline:
            return chunks

        for chunk in chunks:
            lines = chunk.content.split("\n", 1)
            if re.match(r"^#+\s", lines[0]):
                # Insert headline after the heading line
                if len(lines) > 1:
                    chunk.content = f"{lines[0]}\n{headline}\n{lines[1]}"
                else:
                    chunk.content = f"{lines[0]}\n{headline}"
            else:
                chunk.content = headline + chunk.content
            chunk.size = len(chunk.content)

        return chunks

    @staticmethod
    def create_chunk_metadata(chunks: list[ChunkData]) -> list[ProcessedChunk]:
        """Build metadata dict per chunk with indexing and hierarchy info."""
        results: list[ProcessedChunk] = []

        for index, chunk in enumerate(chunks):
            metadata: dict = {
                "chunk_index": index,
                "content_length": len(chunk.content),
            }

            # Cascading path from hierarchy stack
            metadata["cascading_path"] = (
                " > ".join(node.title for node in chunk.hierarchy_stack)
                if chunk.hierarchy_stack
                else chunk.section_title
            )

            # Split part information
            if chunk.is_split and chunk.split_part_number:
                metadata["split_part_number"] = chunk.split_part_number
                metadata["total_chunks_in_section"] = chunk.total_chunks_in_section

            results.append(
                ProcessedChunk(
                    chunk=chunk.content,
                    chunk_metadata=metadata,
                    citable_text=chunk.citable_text,
                )
            )

        return results

    def chunk_text(self, markdown_content: str) -> list[ProcessedChunk]:
        """Main entry point: parse, split, merge, and build metadata."""
        # Step 1: Parse markdown by headings
        sections = self.parse_markdown_sections(
            markdown_content, [1, 2, 3, 4, 5, 6]
        )
        logger.info("Smart chunker: parsed %d sections", len(sections))

        # Step 2: Split sections into chunks
        all_chunks: list[ChunkData] = []
        for section in sections:
            all_chunks.extend(self.split_section_into_chunks(section))
        logger.info("Smart chunker: split into %d chunks", len(all_chunks))

        # Step 3: Merge small chunks
        merged_chunks = self.merge_small_chunks(all_chunks)
        logger.info("Smart chunker: after merge %d chunks", len(merged_chunks))

        # Step 4: Create metadata (headline is applied separately by caller)
        return self.create_chunk_metadata(merged_chunks)
