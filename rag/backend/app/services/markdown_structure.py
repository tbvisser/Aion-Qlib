"""Utilities for preserving Markdown document structure."""

from __future__ import annotations

import re


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_OUTLINE_NUMBER_RE = re.compile(r"^(\d+(?:\.\d+)*)(?:\.)?\s+\S")


def _infer_outline_level(title: str) -> int | None:
    """Infer heading level from prefixes like 1, 1.1, and 1.1.1."""
    match = _OUTLINE_NUMBER_RE.match(title.strip())
    if not match:
        return None

    level = len(match.group(1).split("."))
    return min(max(level, 1), 6)


def normalize_docling_markdown_headings(markdown: str) -> str:
    """Normalize flat Docling heading exports using numbered outline prefixes.

    Some PDFs export from Docling with every heading at the same Markdown level
    even when the visible text contains outline numbering such as 1, 1.1, and
    1.1.1. This keeps regular Markdown alone and only adjusts flat heading sets
    where the numbering provides a clearer hierarchy signal.
    """
    lines = markdown.split("\n")
    headings: list[tuple[int, int, str]] = []

    for line_index, line in enumerate(lines):
        match = _HEADING_RE.match(line)
        if match:
            headings.append((line_index, len(match.group(1)), match.group(2)))

    if not headings:
        return markdown

    heading_levels = {level for _, level, _ in headings}
    if len(heading_levels) != 1:
        return markdown

    has_outline_numbering = any(
        _infer_outline_level(title) is not None for _, _, title in headings
    )
    if not has_outline_numbering:
        return markdown

    first_heading_index = headings[0][0]

    for line_index, _, title in headings:
        inferred_level = _infer_outline_level(title)
        if inferred_level is None and line_index == first_heading_index:
            inferred_level = 1

        if inferred_level is not None:
            lines[line_index] = f"{'#' * inferred_level} {title}"

    return "\n".join(lines)
