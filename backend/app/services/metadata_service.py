"""Metadata extraction using LLM with dynamic schema."""
import asyncio
import json
import logging

from app.config import get_settings
from app.models.metadata import get_metadata_schema, validate_metadata, MetadataSchema
from app.services.langsmith import get_traced_async_openai_client, traceable
from app.services.redaction_service import get_local_llm_settings

logger = logging.getLogger(__name__)

MAX_TEXT_CHARS = 8000


def _build_extraction_prompt(schema: MetadataSchema) -> str:
    """Build a dynamic extraction prompt from the schema fields."""
    lines = ["Extract the following metadata fields from the document.\n"]

    for i, field in enumerate(schema, 1):
        type_desc = field.type
        if field.type == "enum" and field.enum_values:
            type_desc = f"enum: {' | '.join(field.enum_values)}"
        elif field.type == "list":
            type_desc = "list of strings"

        required = "required" if field.required else "optional"
        lines.append(f"{i}. {field.name} ({type_desc}, {required}): {field.description}")

    lines.append("\nRespond with ONLY a valid JSON object containing these keys. No markdown, no explanation, no code fences. Just the raw JSON object.")
    return "\n".join(lines)


def _extract_json_from_text(text: str) -> dict:
    """Extract a JSON object from LLM response text, handling code fences and extra text."""
    text = text.strip()

    # Try direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strip markdown code fences
    if "```" in text:
        import re
        match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1).strip())
            except json.JSONDecodeError:
                pass

    # Try to find JSON object boundaries
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass

    raise ValueError(f"Could not extract JSON from response: {text[:200]}")


@traceable(name="extract_metadata", run_type="chain")
async def extract_metadata(text: str, user_id: str) -> dict:
    """
    Extract structured metadata from document text using the LLM.

    Uses the first MAX_TEXT_CHARS characters of the document.
    Falls back to defaults on any failure.
    """
    schema = get_metadata_schema()

    if not schema:
        return {}

    # Try local LLM first (keeps PII local), fall back to cloud
    local_settings = get_local_llm_settings()
    if local_settings:
        model = local_settings["model"]
        base_url = local_settings["base_url"]
        api_key = "not-needed"
        logger.info("Using local LLM for metadata extraction")
    else:
        # Fall back to cloud LLM
        settings = get_settings()
        api_key = settings.llm_api_key

        if not api_key:
            logger.warning("LLM not configured, skipping metadata extraction")
            return {f.name: _default_for_field(f) for f in schema if f.required}

        model = settings.llm_model or "gpt-4o"
        base_url = settings.llm_base_url or None
        logger.info("Using cloud LLM for metadata extraction")

    client = get_traced_async_openai_client(base_url=base_url, api_key=api_key)

    # Truncate text
    truncated_text = text[:MAX_TEXT_CHARS]
    prompt = _build_extraction_prompt(schema)

    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": truncated_text},
    ]

    # Build JSON schema from metadata field definitions
    json_schema = _build_json_schema(schema)

    try:
        timeout = max(
            1,
            int(getattr(get_settings(), "metadata_extraction_timeout_seconds", 45)),
        )
        response = await asyncio.wait_for(
            client.chat.completions.create(
                model=model,
                messages=messages,
                response_format={
                    "type": "json_schema",
                    "json_schema": {
                        "name": "document_metadata",
                        "strict": True,
                        "schema": json_schema,
                    },
                },
                temperature=0.0,
            ),
            timeout=timeout,
        )

        content = response.choices[0].message.content
        if not content:
            raise ValueError("Empty response from LLM")

        raw_metadata = _extract_json_from_text(content)
        return validate_metadata(raw_metadata, schema)

    except Exception as e:
        # Log with traceback so a schema/provider mismatch is visible instead of
        # silently degrading every upload to placeholder defaults.
        logger.exception(f"Metadata extraction failed, falling back to defaults: {e}")
        # Return defaults for required fields
        return validate_metadata({}, schema)


def _build_json_schema(schema: MetadataSchema) -> dict:
    """Convert MetadataSchema into a JSON Schema object for structured output.

    OpenAI strict structured outputs require EVERY key in ``properties`` to also
    appear in ``required``. To express an "optional" field under that constraint we
    follow OpenAI's documented pattern: keep the field in ``required`` but make its
    type nullable so the model is allowed to emit ``null`` when the value is absent.
    """
    properties = {}
    required = []

    for field in schema:
        # Base JSON type for the field (single string, e.g. "string"/"array").
        if field.type == "string":
            prop = {"type": "string", "description": field.description}
        elif field.type == "number":
            prop = {"type": "number", "description": field.description}
        elif field.type == "boolean":
            prop = {"type": "boolean", "description": field.description}
        elif field.type == "list":
            prop = {
                "type": "array",
                "items": {"type": "string"},
                "description": field.description,
            }
        elif field.type == "enum" and field.enum_values:
            prop = {
                "type": "string",
                "enum": list(field.enum_values),
                "description": field.description,
            }
        else:
            prop = {"type": "string", "description": field.description}

        # Optional fields must stay nullable so strict mode (which forces every key
        # into ``required``) can still represent "no value" as ``null``.
        if not field.required:
            base_type = prop["type"]
            prop["type"] = [base_type, "null"]
            if "enum" in prop and None not in prop["enum"]:
                prop["enum"] = [*prop["enum"], None]

        properties[field.name] = prop
        required.append(field.name)

    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


def _default_for_field(field):
    """Quick default value for a field."""
    from app.models.metadata import _default_for_type
    return _default_for_type(field)
