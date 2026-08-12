"""Regression tests: model-supplied search filters must not zero out results.

gpt-5.x tends to auto-fill the optional `filters` arg with empty strings + the
"other" catch-all document_type, which (passed verbatim) becomes a JSONB
containment filter matching zero chunks. _clean_metadata_filter must collapse
those to None. See the daniel@test.com "RESA LATIOLAIS" zero-results trace.
"""
from app.services.tool_executor import _clean_metadata_filter


def test_model_default_filter_collapses_to_none():
    # Exactly the payload from the failing Langfuse trace.
    f = {"title": "", "summary": "", "document_type": "other", "topics": "", "language": ""}
    assert _clean_metadata_filter(f) is None


def test_document_type_other_dropped():
    assert _clean_metadata_filter({"document_type": "other"}) is None
    assert _clean_metadata_filter({"document_type": "OTHER"}) is None


def test_concrete_document_type_kept():
    assert _clean_metadata_filter({"document_type": "legal_brief"}) == {"document_type": "legal_brief"}


def test_blank_fields_stripped_but_meaningful_kept():
    assert _clean_metadata_filter(
        {"title": "Acme Contract", "summary": "   ", "topics": "", "document_type": "other"}
    ) == {"title": "Acme Contract"}


def test_non_dict_and_empty_inputs():
    assert _clean_metadata_filter(None) is None
    assert _clean_metadata_filter("nope") is None
    assert _clean_metadata_filter({}) is None
    assert _clean_metadata_filter({"topics": [], "extra": {}}) is None
