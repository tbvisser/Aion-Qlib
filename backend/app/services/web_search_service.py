"""Web search service using Tavily API."""
import logging
import httpx
from typing import Any

from app.config import get_settings
from app.services.langsmith import traceable

logger = logging.getLogger(__name__)

TAVILY_API_URL = "https://api.tavily.com/search"


def get_web_search_settings() -> dict[str, Any] | None:
    """
    Get web search settings from environment config.

    Returns:
        Dict with api_key, provider, enabled or None if not configured/disabled
    """
    try:
        settings = get_settings()

        if not settings.web_search_enabled:
            return None

        if not settings.web_search_api_key:
            return None

        return {
            "provider": settings.web_search_provider or "tavily",
            "api_key": settings.web_search_api_key,
            "enabled": True,
        }
    except Exception as e:
        logger.warning(f"Failed to get web search settings: {e}")
        return None


@traceable(name="web_search", run_type="tool")
async def web_search(query: str, max_results: int = 5) -> list[dict[str, str]]:
    """
    Search the web using Tavily API.

    Args:
        query: The search query
        max_results: Maximum number of results to return (default 5)

    Returns:
        List of dicts with 'title', 'url', 'content' keys
    """
    settings = get_web_search_settings()
    if not settings:
        return [{
            "title": "Web Search Not Configured",
            "url": "",
            "content": "Web search is not enabled. Please configure the Tavily API key in settings."
        }]

    app_settings = get_settings()
    include_raw = app_settings.web_search_include_raw_content
    max_snapshot_chars = app_settings.web_search_max_snapshot_chars
    search_depth = app_settings.web_search_depth or "advanced"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                TAVILY_API_URL,
                json={
                    "api_key": settings["api_key"],
                    "query": query,
                    "max_results": max_results,
                    "search_depth": search_depth,
                    "include_answer": False,
                    "include_raw_content": include_raw,
                },
            )
            response.raise_for_status()
            data = response.json()

        results = []
        for item in data.get("results", []):
            # raw_content is the full page text used for citation snapshots.
            # Cap it so a single huge page can't blow up storage. The short
            # snippet (`content`) is what we feed the LLM and cite from.
            raw_content = item.get("raw_content") or ""
            if raw_content and max_snapshot_chars and len(raw_content) > max_snapshot_chars:
                raw_content = raw_content[:max_snapshot_chars]
            results.append({
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "content": item.get("content", ""),
                "raw_content": raw_content,
            })

        if not results:
            return [{
                "title": "No Results",
                "url": "",
                "content": f"No web search results found for: {query}"
            }]

        return results

    except httpx.HTTPStatusError as e:
        logger.error(f"Tavily API error: {e.response.status_code} - {e.response.text}")
        return [{
            "title": "Search Error",
            "url": "",
            "content": f"Web search failed: {e.response.status_code}"
        }]
    except Exception as e:
        logger.error(f"Web search error: {e}")
        return [{
            "title": "Search Error",
            "url": "",
            "content": f"Web search failed: {str(e)}"
        }]


def format_search_results(results: list[dict[str, str]]) -> str:
    """Format search results as a string for LLM context."""
    if not results:
        return "No web search results found."

    formatted = []
    for i, r in enumerate(results, 1):
        title = r.get("title", "Untitled")
        url = r.get("url", "")
        content = r.get("content", "")

        entry = f"[{i}] {title}"
        if url:
            entry += f"\n    URL: {url}"
        if content:
            entry += f"\n    {content}"
        formatted.append(entry)

    return "\n\n".join(formatted)
