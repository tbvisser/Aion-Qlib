"""Embedding service using configured provider."""
import asyncio
import logging
from typing import Any

from fastapi import HTTPException, status

from app.config import get_settings
from app.services.langsmith import get_traced_async_openai_client, traceable

logger = logging.getLogger(__name__)


def get_global_embedding_settings() -> dict[str, Any]:
    """
    Get global embedding settings from environment config.

    Returns dict with keys: model, base_url, api_key, dimensions
    Raises HTTPException(503) if no API key is configured.
    """
    settings = get_settings()

    if not settings.embedding_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Embedding not configured. Set EMBEDDING_API_KEY in environment variables."
        )

    return {
        "model": settings.embedding_model or "text-embedding-3-small",
        "base_url": settings.embedding_base_url or None,
        "api_key": settings.embedding_api_key,
        "dimensions": settings.embedding_dimensions or 1536,
    }


@traceable(name="get_embeddings", run_type="embedding")
async def get_embeddings(texts: list[str], user_id: str | None = None) -> list[list[float]]:
    """Generate embeddings for a list of texts using global settings."""
    if not texts:
        return []

    emb_settings = get_global_embedding_settings()
    model = emb_settings["model"]
    dimensions = emb_settings["dimensions"]

    client = get_traced_async_openai_client(
        base_url=emb_settings["base_url"],
        api_key=emb_settings["api_key"],
    )

    return await _get_embeddings_adaptive(
        client=client,
        texts=texts,
        model=model,
        dimensions=dimensions,
    )


def _should_split_embedding_error(exc: Exception) -> bool:
    """Return True for provider responses that may be batch-size sensitive."""
    return isinstance(exc, ValueError)


async def _get_embeddings_adaptive(
    *,
    client: Any,
    texts: list[str],
    model: str,
    dimensions: int,
) -> list[list[float]]:
    try:
        return await _create_embedding_batch(
            client=client,
            texts=texts,
            model=model,
            dimensions=dimensions,
        )
    except Exception as exc:
        if len(texts) <= 1 or not _should_split_embedding_error(exc):
            raise

        midpoint = max(1, len(texts) // 2)
        logger.warning(
            "Embedding batch of %d inputs failed after retries (%s); "
            "splitting into %d and %d inputs",
            len(texts),
            exc,
            midpoint,
            len(texts) - midpoint,
        )
        left = await _get_embeddings_adaptive(
            client=client,
            texts=texts[:midpoint],
            model=model,
            dimensions=dimensions,
        )
        right = await _get_embeddings_adaptive(
            client=client,
            texts=texts[midpoint:],
            model=model,
            dimensions=dimensions,
        )
        return left + right


async def _create_embedding_batch(
    *,
    client: Any,
    texts: list[str],
    model: str,
    dimensions: int,
) -> list[list[float]]:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = await client.embeddings.create(
                model=model,
                input=texts,
                dimensions=dimensions,
                encoding_format="float",
            )
            embeddings = [item.embedding for item in response.data]
            if len(embeddings) != len(texts):
                raise ValueError(
                    f"Embedding provider returned {len(embeddings)} vectors for "
                    f"{len(texts)} inputs"
                )
            if any(not embedding for embedding in embeddings):
                raise ValueError("Embedding provider returned an empty vector")
            return embeddings
        except Exception as exc:
            last_error = exc
            if attempt == 2:
                break
            delay = 1.5 * (attempt + 1)
            logger.warning(
                "Embedding batch failed on attempt %d/3 (%s); retrying in %.1fs",
                attempt + 1,
                exc,
                delay,
            )
            await asyncio.sleep(delay)

    assert last_error is not None
    raise last_error
