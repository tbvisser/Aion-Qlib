"""Unit tests for thread title generation."""

from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.unit


class _FakeCompletions:
    def __init__(self):
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="SSO Reset Help")
                )
            ]
        )


class _FakeUpdateQuery:
    def __init__(self, sink):
        self.sink = sink

    def update(self, payload):
        self.sink["update"] = payload
        return self

    def eq(self, key, value):
        self.sink.setdefault("eq", []).append((key, value))
        return self

    def execute(self):
        return SimpleNamespace(data=[self.sink.get("update", {})])


class _FakeSupabase:
    def __init__(self):
        self.sink = {}

    def table(self, name):
        self.sink["table"] = name
        return _FakeUpdateQuery(self.sink)


async def test_generate_title_cloud_fallback_without_assistant_context(monkeypatch):
    from app.routers import threads

    completions = _FakeCompletions()
    fake_client = SimpleNamespace(
        chat=SimpleNamespace(completions=completions)
    )
    fake_supabase = _FakeSupabase()

    monkeypatch.setattr(threads, "get_local_llm_settings", lambda: None)
    monkeypatch.setattr(
        threads,
        "get_global_llm_settings",
        lambda: {"model": "gpt-from-llm-model", "base_url": None, "api_key": "test-key"},
    )
    monkeypatch.setattr(
        threads,
        "get_traced_async_openai_client",
        lambda **_kwargs: fake_client,
    )
    monkeypatch.setattr(threads, "get_supabase_client", lambda: fake_supabase)

    title = await threads.generate_title_for_thread(
        "thread-1",
        "How do I reset SSO for a teammate?",
    )

    assert title == "SSO Reset Help"
    request = completions.calls[0]
    assert request["model"] == "gpt-from-llm-model"
    assert request["messages"][1]["content"] == (
        "User message: How do I reset SSO for a teammate?"
    )
    assert "Assistant response:" not in request["messages"][1]["content"]
    assert fake_supabase.sink["table"] == "threads"
    assert fake_supabase.sink["update"]["title"] == "SSO Reset Help"
