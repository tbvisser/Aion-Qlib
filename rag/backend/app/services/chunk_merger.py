from app.services.hierarchy_extractor import HierarchySection


class ChunkSectionMerger:
    """Merges section hierarchy data into chunk metadata (childRange, parentRange)."""

    @staticmethod
    def merge_data(
        sections: list[HierarchySection],
        chunks: list[dict],
    ) -> list[dict]:
        """For each chunk, compute childRange and parentRange from mapped sections.

        Args:
            sections: Output of HierarchyExtractor.map_sections_to_chunks()
            chunks: List of dicts with 'chunk' and 'chunk_metadata' keys
                    (output of SmartMarkdownChunker.create_chunk_metadata)

        Returns:
            Enhanced chunks with 'childRange' and 'parentRange' added to chunk_metadata.
        """
        # Build map: chunk_index -> list of sections that reference it
        chunk_to_sections: dict[int, list[HierarchySection]] = {}
        for section in sections:
            for idx in section.chunk_indices:
                chunk_to_sections.setdefault(idx, []).append(section)

        enhanced: list[dict] = []
        for chunk in chunks:
            meta = dict(chunk["chunk_metadata"])
            chunk_index = meta["chunk_index"]
            sections_for_chunk = chunk_to_sections.get(chunk_index, [])

            child_range = None
            parent_range = None

            if sections_for_chunk:
                # Compute absolute child range across all sections referencing this chunk
                section_ranges = [
                    s.chunk_range
                    for s in sections_for_chunk
                    if s.chunk_range is not None
                ]
                if section_ranges:
                    all_starts = [r[0] for r in section_ranges]
                    all_ends = [r[1] for r in section_ranges]
                    child_range = [min(all_starts), max(all_ends)]

                # Compute absolute parent range
                parent_ranges = [
                    s.parent_range
                    for s in sections_for_chunk
                    if s.parent_range is not None
                ]
                if parent_ranges:
                    all_p_starts = [r[0] for r in parent_ranges]
                    all_p_ends = [r[1] for r in parent_ranges]
                    parent_range = [min(all_p_starts), max(all_p_ends)]

            meta["childRange"] = child_range
            meta["parentRange"] = parent_range

            enhanced.append({"chunk": chunk["chunk"], "chunk_metadata": meta})

        return enhanced
