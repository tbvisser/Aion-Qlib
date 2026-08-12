"""Reranking service supporting Cohere API and compatible endpoints."""
import logging

import httpx

from app.config import get_settings
from app.services.langsmith import traceable

logger = logging.getLogger(__name__)


def get_rerank_settings() -> dict | None:
    """
    Read reranking config from environment settings.

    Returns dict with keys: model, base_url, api_key, top_n
    Returns None if reranking is not configured (no base_url).
    """
    settings = get_settings()

    if not settings.rerank_base_url:
        return None

    return {
        "model": settings.rerank_model or "rerank-v3.5",
        "base_url": settings.rerank_base_url.rstrip("/"),
        "api_key": settings.rerank_api_key or None,
        "top_n": settings.rerank_top_n or 5,
    }


@traceable(name="rerank_documents", run_type="chain")
async def rerank_documents(
    query: str,
    documents: list[dict],
    top_n: int | None = None,
) -> list[dict]:
    """
    Rerank documents using a Cohere-compatible reranking endpoint.

    POSTs to {base_url}/rerank with Cohere request format.
    Falls back to returning input unchanged if unconfigured or on error.

    Args:
        query: The search query
        documents: List of chunk dicts (must have 'content' key)
        top_n: Override for number of results (uses settings default if None)

    Returns:
        Reranked list of chunk dicts with added 'rerank_score' field
    """
    settings = get_rerank_settings()
    if not settings:
        return documents

    if not documents:
        return documents

    effective_top_n = top_n or settings["top_n"]

    # Build Cohere-compatible request
    texts = [doc.get("content", "") for doc in documents]
    request_body = {
        "model": settings["model"],
        "query": query,
        "documents": texts,
        "top_n": effective_top_n,
    }

    headers = {"Content-Type": "application/json"}
    if settings["api_key"]:
        headers["Authorization"] = f"Bearer {settings['api_key']}"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{settings['base_url']}/rerank",
                json=request_body,
                headers=headers,
            )
            response.raise_for_status()

        data = response.json()
        results = data.get("results", [])

        # Map reranked indices back to original documents
        reranked = []
        for item in results:
            idx = item["index"]
            if idx < len(documents):
                doc = documents[idx].copy()
                doc["rerank_score"] = item.get("relevance_score", 0.0)
                reranked.append(doc)

        return reranked

    except Exception as e:
        logger.warning(f"Reranking failed, returning original results: {e}")
        return documents
