"""Unit tests for metadata_service.py."""
from app.models.metadata import MetadataFieldDefinition
from app.services.metadata_service import _build_json_schema


def _schema():
    return [
        MetadataFieldDefinition(
            name="title", type="string", required=True, description="t"
        ),
        MetadataFieldDefinition(
            name="document_type",
            type="enum",
            required=True,
            description="d",
            enum_values=["article", "report", "other"],
        ),
        MetadataFieldDefinition(
            name="topics", type="list", required=True, description="k"
        ),
        MetadataFieldDefinition(
            name="language", type="string", required=False, description="l"
        ),
        MetadataFieldDefinition(
            name="headline_enum",
            type="enum",
            required=False,
            description="h",
            enum_values=["a", "b"],
        ),
    ]


def test_strict_schema_requires_every_property():
    """OpenAI strict mode: every key in properties must be in required."""
    js = _build_json_schema(_schema())

    assert set(js["required"]) == set(js["properties"].keys())
    assert js["additionalProperties"] is False
    for name in ("title", "document_type", "topics", "language", "headline_enum"):
        assert name in js["required"]


def test_required_fields_keep_single_type():
    js = _build_json_schema(_schema())
    assert js["properties"]["title"]["type"] == "string"
    assert js["properties"]["document_type"]["type"] == "string"
    assert js["properties"]["document_type"]["enum"] == ["article", "report", "other"]
    assert js["properties"]["topics"]["type"] == "array"


def test_optional_string_is_nullable():
    js = _build_json_schema(_schema())
    assert js["properties"]["language"]["type"] == ["string", "null"]


def test_optional_enum_is_nullable_and_allows_null():
    js = _build_json_schema(_schema())
    prop = js["properties"]["headline_enum"]
    assert prop["type"] == ["string", "null"]
    assert None in prop["enum"]
    # original values preserved
    assert "a" in prop["enum"] and "b" in prop["enum"]
