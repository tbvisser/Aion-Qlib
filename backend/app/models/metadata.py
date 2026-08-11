"""Metadata schema definition and validation utilities."""
from typing import Literal
from pydantic import BaseModel
from postgrest.exceptions import APIError

from app.db.supabase import get_supabase_client


class MetadataFieldDefinition(BaseModel):
    name: str
    type: Literal["string", "list", "enum", "number", "boolean"]
    required: bool = True
    description: str
    enum_values: list[str] | None = None


MetadataSchema = list[MetadataFieldDefinition]


def get_metadata_schema() -> MetadataSchema:
    """Load metadata schema from global_settings."""
    supabase = get_supabase_client()
    try:
        result = supabase.table("global_settings").select(
            "metadata_schema"
        ).limit(1).maybe_single().execute()
        data = result.data if result else None
    except APIError as e:
        if e.code == "204":
            return _default_schema()
        raise

    if not data or not data.get("metadata_schema"):
        return _default_schema()

    raw_schema = data["metadata_schema"]
    return [MetadataFieldDefinition(**field) for field in raw_schema]


def validate_metadata(data: dict, schema: MetadataSchema) -> dict:
    """
    Validate extracted metadata against the schema.
    Applies defaults for missing required fields.
    """
    validated = {}

    for field in schema:
        value = data.get(field.name)

        if value is None:
            if field.required:
                validated[field.name] = _default_for_type(field)
            continue

        # Type coercion/validation
        if field.type == "string":
            validated[field.name] = str(value) if value else _default_for_type(field)
        elif field.type == "list":
            if isinstance(value, list):
                validated[field.name] = [str(v) for v in value]
            else:
                validated[field.name] = [str(value)]
        elif field.type == "enum":
            str_val = str(value)
            if field.enum_values and str_val in field.enum_values:
                validated[field.name] = str_val
            else:
                validated[field.name] = field.enum_values[0] if field.enum_values else "other"
        elif field.type == "number":
            try:
                validated[field.name] = float(value)
            except (ValueError, TypeError):
                validated[field.name] = 0
        elif field.type == "boolean":
            validated[field.name] = bool(value)

    return validated


def _default_for_type(field: MetadataFieldDefinition):
    """Return a sensible default value for a field type."""
    if field.type == "string":
        return "Unknown"
    elif field.type == "list":
        return []
    elif field.type == "enum":
        return field.enum_values[0] if field.enum_values else "other"
    elif field.type == "number":
        return 0
    elif field.type == "boolean":
        return False
    return None


def _default_schema() -> MetadataSchema:
    """Fallback schema if nothing in DB."""
    return [
        MetadataFieldDefinition(name="title", type="string", required=True, description="A concise, descriptive title for the document"),
        MetadataFieldDefinition(name="summary", type="string", required=True, description="A 1-3 sentence summary of the document content"),
        MetadataFieldDefinition(name="document_type", type="enum", required=True, description="The category of this document", enum_values=["article", "tutorial", "reference", "notes", "report", "essay", "code", "other"]),
        MetadataFieldDefinition(name="topics", type="list", required=True, description="3-7 key topics or themes covered in the document"),
        MetadataFieldDefinition(name="language", type="string", required=False, description="ISO 639-1 language code of the document (e.g. en, es, fr)"),
        MetadataFieldDefinition(name="document_headline", type="string", required=False, description="A brief phrase describing what this document is (e.g., 'a quarterly sales report for Q3 2025', 'an employee handbook for new hires'). Used to contextualize chunks during retrieval."),
    ]
