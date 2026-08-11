"""Tests for Markdown structure normalization helpers."""

from app.services.markdown_structure import normalize_docling_markdown_headings


def test_normalizes_flat_docling_numbered_headings():
    markdown = """## Sample Document

## 1. Heading Level 1 (H1)

## 1.1 Heading Level 2 (H2)

## 1.1.1 Heading Level 3 (H3)

## 1.1.1.1.1.1 Heading Level 6 (H6)
"""

    normalized = normalize_docling_markdown_headings(markdown)

    assert normalized.startswith("# Sample Document")
    assert "\n# 1. Heading Level 1 (H1)" in normalized
    assert "\n## 1.1 Heading Level 2 (H2)" in normalized
    assert "\n### 1.1.1 Heading Level 3 (H3)" in normalized
    assert "\n###### 1.1.1.1.1.1 Heading Level 6 (H6)" in normalized


def test_leaves_existing_markdown_hierarchy_unchanged():
    markdown = """# Title

## 1. Existing Child

### 1.1 Existing Grandchild
"""

    assert normalize_docling_markdown_headings(markdown) == markdown


def test_leaves_flat_unnumbered_headings_unchanged():
    markdown = """## Overview

## Details
"""

    assert normalize_docling_markdown_headings(markdown) == markdown
