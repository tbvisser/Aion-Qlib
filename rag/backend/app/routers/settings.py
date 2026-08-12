"""Settings router for metadata schema configuration."""
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from postgrest.exceptions import APIError

from app.dependencies import get_current_user, get_admin_user, User
from app.db.supabase import get_supabase_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])


class MetadataSchemaResponse(BaseModel):
    metadata_schema: list | None = None


class MetadataSchemaUpdate(BaseModel):
    metadata_schema: list


def get_global_settings_row() -> dict | None:
    """Get the single global settings row."""
    supabase = get_supabase_client()
    try:
        result = supabase.table("global_settings").select("*").limit(1).maybe_single().execute()
        return result.data if result else None
    except APIError as e:
        if e.code == "204":
            return None
        raise


@router.get("/metadata-schema", response_model=MetadataSchemaResponse)
async def get_metadata_schema(current_user: User = Depends(get_current_user)):
    """Get the metadata schema configuration."""
    data = get_global_settings_row()
    return MetadataSchemaResponse(
        metadata_schema=data.get("metadata_schema") if data else None,
    )


@router.put("/metadata-schema", response_model=MetadataSchemaResponse)
async def update_metadata_schema(
    schema_data: MetadataSchemaUpdate,
    current_user: User = Depends(get_admin_user),
):
    """Update metadata schema. Admin only."""
    supabase = get_supabase_client()

    # Validate each field against MetadataFieldDefinition
    from app.models.metadata import MetadataFieldDefinition
    validated_schema = []
    for field_data in schema_data.metadata_schema:
        field = MetadataFieldDefinition(**field_data)
        validated_schema.append(field.model_dump())

    existing = get_global_settings_row()
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Global settings row not found"
        )

    result = supabase.table("global_settings").update(
        {"metadata_schema": validated_schema}
    ).eq("id", existing["id"]).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save metadata schema"
        )

    saved = result.data[0]
    return MetadataSchemaResponse(
        metadata_schema=saved.get("metadata_schema"),
    )


class ModelOption(BaseModel):
    id: str


class AvailableModelsResponse(BaseModel):
    provider: str
    models: list[ModelOption]
    error: str | None = None


# Small in-memory TTL cache — provider catalogs (esp. OpenRouter's ~300 models)
# are large and change slowly, so don't hit the provider on every dialog open.
_models_cache: dict[str, tuple[float, AvailableModelsResponse]] = {}
_MODELS_CACHE_TTL = 600.0  # seconds


@router.get("/models", response_model=AvailableModelsResponse)
async def list_available_models(current_user: User = Depends(get_current_user)):
    """List models available for the env-configured LLM provider.

    Powers the composer's model picker. The provider's API key stays server-side —
    only model ids are returned. Degrades to an empty list (error="unavailable")
    so the UI can fall back to free-text entry.
    """
    from app.config import get_settings
    from app.services.llm_service import get_global_llm_settings
    from app.services.langsmith import get_traced_async_openai_client

    cfg = get_settings()
    provider = (cfg.llm_provider or "").lower()

    # Codex (ChatGPT subscription) models aren't enumerable via a standard
    # endpoint — surface the configured model so the picker isn't empty.
    if provider == "codex":
        ids = [cfg.codex_model] if cfg.codex_model else []
        return AvailableModelsResponse(provider="codex", models=[ModelOption(id=i) for i in ids])

    label = provider or "openai"
    cache_key = f"{label}|{cfg.llm_base_url}"
    now = time.time()
    hit = _models_cache.get(cache_key)
    if hit and now - hit[0] < _MODELS_CACHE_TTL:
        return hit[1]

    try:
        llm = get_global_llm_settings()
        client = get_traced_async_openai_client(base_url=llm["base_url"], api_key=llm["api_key"])
        page = await client.models.list()
        ids = sorted({m.id for m in (page.data or []) if getattr(m, "id", None)})
        result = AvailableModelsResponse(provider=label, models=[ModelOption(id=i) for i in ids])
        _models_cache[cache_key] = (now, result)
        return result
    except Exception as e:  # provider unreachable / no key / unexpected shape
        logger.warning(f"Could not list models for provider={label}: {e}")
        return AvailableModelsResponse(provider=label, models=[], error="unavailable")
