"""Unit tests for web_search_service raw_content capture."""

from types import SimpleNamespace

import pytest

from app.services import web_search_service


class _FakeResp:
    def __init__(self, data):
        self._data = data

    def raise_for_status(self):
        return None

    def json(self):
        return self._data


class _FakeClient:
    """Minimal async context-manager stand-in for httpx.AsyncClient."""

    last_json: dict | None = None

    def __init__(self, data):
        self._data = data

    def __call__(self, *args, **kwargs):  # not used; constructed directly
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None):
        _FakeClient.last_json = json
        return _FakeResp(self._data)


@pytest.mark.asyncio
async def test_web_search_captures_and_caps_raw_content(monkeypatch):
    data = {
        "results": [
            {
                "title": "Galway Weather",
                "url": "https://example.com/galway",
                "content": "short snippet",
                "raw_content": "Y" * 500,
            }
        ]
    }
    monkeypatch.setattr(
        web_search_service,
        "get_web_search_settings",
        lambda: {"provider": "tavily", "api_key": "k", "enabled": True},
    )
    monkeypatch.setattr(
        web_search_service,
        "get_settings",
        lambda: SimpleNamespace(
            web_search_include_raw_content=True,
            web_search_max_snapshot_chars=100,
            web_search_depth="advanced",
        ),
    )
    monkeypatch.setattr(
        web_search_service.httpx, "AsyncClient", lambda *a, **k: _FakeClient(data)
    )

    results = await web_search_service.web_search("galway weather", max_results=3)

    assert _FakeClient.last_json["include_raw_content"] is True
    assert _FakeClient.last_json["search_depth"] == "advanced"
    assert results[0]["content"] == "short snippet"  # snippet preserved for LLM
    assert results[0]["raw_content"] == "Y" * 100  # capped at max_snapshot_chars


@pytest.mark.asyncio
async def test_web_search_respects_include_raw_content_off(monkeypatch):
    data = {"results": [{"title": "T", "url": "https://e.com", "content": "c", "raw_content": "z"}]}
    monkeypatch.setattr(
        web_search_service,
        "get_web_search_settings",
        lambda: {"provider": "tavily", "api_key": "k", "enabled": True},
    )
    monkeypatch.setattr(
        web_search_service,
        "get_settings",
        lambda: SimpleNamespace(
            web_search_include_raw_content=False,
            web_search_max_snapshot_chars=200_000,
            web_search_depth="advanced",
        ),
    )
    monkeypatch.setattr(
        web_search_service.httpx, "AsyncClient", lambda *a, **k: _FakeClient(data)
    )

    await web_search_service.web_search("q")
    assert _FakeClient.last_json["include_raw_content"] is False
