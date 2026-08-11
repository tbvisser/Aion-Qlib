import re
from dataclasses import dataclass, field

MAX_HEADING_LENGTH = 200


@dataclass
class HierarchyNode:
    title: str
    level: int


@dataclass
class HierarchySection:
    title: str
    original_title: str
    level: int
    hierarchy_stack: list[HierarchyNode]
    hierarchy_path: str
    content: str
    content_length: int
    section_index: int
    # Set after mapping
    mapped_chunk_index: int | None = None
    chunk_range: list[int] | None = None
    chunk_count: int = 0
    chunk_indices: list[int] = field(default_factory=list)
    parent_range: list[int] | None = None


class MarkdownHierarchyExtractor:
    """Extracts document hierarchy from markdown and maps sections to chunks."""

    def __init__(self, max_heading_length: int = MAX_HEADING_LENGTH):
        self.max_heading_length = max_heading_length

    def extract_hierarchy(
        self,
        markdown_content: str,
        heading_levels: list[int] | None = None,
    ) -> list[HierarchySection]:
        """Parse markdown into sections with title, level, hierarchy_path, etc."""
        if heading_levels is None:
            heading_levels = [1, 2, 3, 4, 5, 6]

        lines = markdown_content.split("\n")
        sections: list[HierarchySection] = []
        current_section: HierarchySection | None = None
        current_content: list[str] = []
        hierarchy_stack: list[HierarchyNode] = []

        for line in lines:
            heading_match = re.match(r"^(#+)\s*(.*)$", line)

            if heading_match:
                level = len(heading_match.group(1))

                if level in heading_levels:
                    # Save previous section
                    if current_section is not None and current_content:
                        current_section.content = "\n".join(current_content)
                        current_section.content_length = len(current_section.content)
                        sections.append(current_section)

                    original_title = heading_match.group(2).strip()
                    display_title = original_title
                    if len(display_title) > self.max_heading_length:
                        display_title = (
                            display_title[: self.max_heading_length - 3] + "..."
                        )

                    # Update hierarchy stack
                    while len(hierarchy_stack) >= level:
                        hierarchy_stack.pop()
                    hierarchy_stack.append(HierarchyNode(display_title, level))

                    current_section = HierarchySection(
                        title=display_title,
                        original_title=original_title,
                        level=level,
                        hierarchy_stack=[
                            HierarchyNode(n.title, n.level) for n in hierarchy_stack
                        ],
                        hierarchy_path=" > ".join(n.title for n in hierarchy_stack),
                        content="",
                        content_length=0,
                        section_index=len(sections),
                    )
                    current_content = [line]
                else:
                    current_content.append(line)
            else:
                current_content.append(line)

        # Last section
        if current_section is not None and current_content:
            current_section.content = "\n".join(current_content)
            current_section.content_length = len(current_section.content)
            sections.append(current_section)

        # If no headings found, treat entire document as one section
        if not sections:
            sections.append(
                HierarchySection(
                    title="Document",
                    original_title="Document",
                    level=1,
                    hierarchy_stack=[HierarchyNode("Document", 1)],
                    hierarchy_path="Document",
                    content=markdown_content,
                    content_length=len(markdown_content),
                    section_index=0,
                )
            )

        return sections

    def map_sections_to_chunks(
        self,
        sections: list[HierarchySection],
        chunks: list[dict],
    ) -> list[HierarchySection]:
        """Map each section to its chunk indices by searching for heading patterns.

        Args:
            sections: Output of extract_hierarchy()
            chunks: List of dicts with 'chunk' (content) and 'chunk_metadata' keys
                    (output of SmartMarkdownChunker.chunk_text or create_chunk_metadata)
        """
        if not chunks:
            return sections

        # Sort chunks by index
        sorted_chunks = sorted(chunks, key=lambda c: c["chunk_metadata"]["chunk_index"])

        # Single pass: map each section to chunk indices
        search_start = 0

        for section in sections:
            search_title = section.original_title or section.title
            heading_pattern = f"{'#' * section.level} {search_title}"

            found_chunks: list[int] = []

            for i in range(search_start, len(sorted_chunks)):
                chunk = sorted_chunks[i]
                chunk_content = chunk.get("chunk", "")
                meta = chunk.get("chunk_metadata", {})

                if heading_pattern in chunk_content:
                    found_chunks.append(meta["chunk_index"])

                    if i > search_start:
                        search_start = i

                    # Look for split parts in subsequent chunks
                    for j in range(i + 1, len(sorted_chunks)):
                        next_chunk = sorted_chunks[j]
                        next_content = next_chunk.get("chunk", "")
                        next_meta = next_chunk.get("chunk_metadata", {})

                        if heading_pattern in next_content or (
                            next_meta.get("split_part_number")
                            and next_meta.get("total_chunks_in_section")
                            and section.title in next_content
                        ):
                            found_chunks.append(next_meta["chunk_index"])
                            total_parts = next_meta.get("total_chunks_in_section")
                            if total_parts and len(found_chunks) >= total_parts:
                                break
                        else:
                            break

                    break

            if found_chunks:
                found_chunks.sort()
                section.mapped_chunk_index = found_chunks[0]
                section.chunk_count = len(found_chunks)
                section.chunk_indices = found_chunks
            else:
                section.mapped_chunk_index = None
                section.chunk_count = 0
                section.chunk_indices = []

        # Calculate hierarchical chunk ranges
        for i, section in enumerate(sections):
            if not section.chunk_indices:
                continue

            start_chunk = min(section.chunk_indices)
            end_chunk = max(section.chunk_indices)

            # Extend range to include all child sections
            for j in range(i + 1, len(sections)):
                next_section = sections[j]
                if next_section.level <= section.level:
                    break
                if next_section.chunk_indices:
                    end_chunk = max(end_chunk, max(next_section.chunk_indices))

            section.chunk_range = [start_chunk, end_chunk]

        # Add parent ranges
        for i, section in enumerate(sections):
            for j in range(i - 1, -1, -1):
                potential_parent = sections[j]
                if potential_parent.level < section.level:
                    if potential_parent.chunk_range:
                        section.parent_range = list(potential_parent.chunk_range)
                    break

        return sections

    @staticmethod
    def build_hierarchical_index(sections_with_chunks: list[HierarchySection]) -> str:
        """Build the text TOC string with chunk ranges."""
        lines = ["Document Hierarchy with Chunk Index Ranges", ""]

        for section in sections_with_chunks:
            hashes = "#" * section.level

            if section.chunk_range:
                start, end = section.chunk_range
                chunk_info = f" [{start}]" if start == end else f" [{start}-{end}]"
            else:
                chunk_info = " [no chunks]"

            lines.append(f"{hashes} {section.title}{chunk_info}")

        return "\n".join(lines)
