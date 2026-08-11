"""Unit tests for get_result_summary (web_search branch regression).

Regression: the web_search summary used to count the substring "Title:", which
format_search_results never emits, so it always reported "No results".
"""

from app.routers.chat import get_result_summary
from app.services.web_search_service import format_search_results


def test_web_search_summary_counts_results():
    results = [
        {"title": f"Result {i}", "url": f"https://e{i}.com", "content": f"snippet {i}"}
        for i in range(5)
    ]
    formatted = format_search_results(results)
    assert get_result_summary("web_search", formatted) == "5 results"


def test_web_search_summary_single_result():
    formatted = format_search_results(
        [{"title": "Only", "url": "https://e.com", "content": "snippet"}]
    )
    assert get_result_summary("web_search", formatted) == "1 result"


def test_web_search_summary_no_results_sentinel():
    formatted = format_search_results(
        [{"title": "No Results", "url": "", "content": "No web search results found for: x"}]
    )
    assert get_result_summary("web_search", formatted) == "No results"


def test_web_search_summary_error_sentinel():
    formatted = format_search_results(
        [{"title": "Search Error", "url": "", "content": "Web search failed: 500"}]
    )
    assert get_result_summary("web_search", formatted) == "Search error"
