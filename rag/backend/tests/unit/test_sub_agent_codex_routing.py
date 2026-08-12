"""Codex routing for analyze/explorer/task sub-agents."""
from types import SimpleNamespace

import pytest


pytestmark = pytest.mark.unit


class _MockAsyncStream:
    def __init__(self, chunks):
        self._chunks = list(chunks)
        self._index = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._index >= len(self._chunks):
            raise StopAsyncIteration
        chunk = self._chunks[self._index]
        self._index += 1
        return chunk


def _stop_chunk(content="Done"):
    return SimpleNamespace(
        usage=None,
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(content=content, tool_calls=None),
                finish_reason="stop",
            )
        ],
    )


def _fake_client(captured):
    async def fake_create(**kwargs):
        captured["request"] = kwargs
        return _MockAsyncStream([_stop_chunk()])

    return SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=fake_create))
    )


def _fake_codex_for(captured, client):
    def fake_codex_for(role, llm_settings=None, reasoning_effort=None):
        captured["role"] = role
        captured["reasoning_effort"] = reasoning_effort
        if llm_settings is not None:
            llm_settings["model"] = "codex-model"
        return client

    return fake_codex_for


def _raise_settings():
    raise AssertionError("OpenAI-compatible settings should not be loaded on Codex path")


@pytest.mark.asyncio
async def test_analyze_document_uses_codex_model_and_medium_reasoning(monkeypatch):
    from app.services import sub_agent_service
    from app.services.llm_service import CODEX_SUB_AGENT_REASONING_EFFORT

    captured = {}
    client = _fake_client(captured)

    async def fake_document_content(document_id, user_id):
        return {
            "id": document_id,
            "filename": "doc.md",
            "content": "Document body",
            "token_count": 3,
            "fits_context": True,
            "metadata": {},
        }

    monkeypatch.setattr(sub_agent_service, "get_full_document_content", fake_document_content)
    monkeypatch.setattr(sub_agent_service, "codex_chat_client_for", _fake_codex_for(captured, client))
    monkeypatch.setattr(sub_agent_service, "get_global_llm_settings", _raise_settings)

    events = [
        event
        async for event in sub_agent_service.run_sub_agent(
            "doc-1",
            "user-1",
            "summarize",
        )
    ]

    assert any(event["type"] == "sub_agent_complete" for event in events)
    assert captured["role"] == "agent"
    assert captured["reasoning_effort"] == CODEX_SUB_AGENT_REASONING_EFFORT == "medium"
    assert captured["request"]["model"] == "codex-model"


@pytest.mark.asyncio
async def test_explorer_uses_codex_model_and_medium_reasoning(monkeypatch):
    from app.services import explorer_agent_service
    from app.services.llm_service import CODEX_SUB_AGENT_REASONING_EFFORT

    captured = {}
    client = _fake_client(captured)

    monkeypatch.setattr(explorer_agent_service, "get_supabase_client", lambda: object())
    monkeypatch.setattr(explorer_agent_service, "codex_chat_client_for", _fake_codex_for(captured, client))
    monkeypatch.setattr(explorer_agent_service, "get_global_llm_settings", _raise_settings)

    events = [
        event
        async for event in explorer_agent_service.run_explorer_agent(
            "research topic",
            "user-1",
        )
    ]

    assert any(event["type"] == "explorer_complete" for event in events)
    assert captured["role"] == "agent"
    assert captured["reasoning_effort"] == CODEX_SUB_AGENT_REASONING_EFFORT == "medium"
    assert captured["request"]["model"] == "codex-model"


@pytest.mark.asyncio
async def test_task_sub_agent_uses_codex_model_and_medium_reasoning(monkeypatch):
    from app.services import deep_agent_service
    from app.services.llm_service import CODEX_SUB_AGENT_REASONING_EFFORT

    captured = {}
    client = _fake_client(captured)

    monkeypatch.setattr(deep_agent_service, "get_settings", lambda: SimpleNamespace(max_sub_agent_rounds=1))
    monkeypatch.setattr(deep_agent_service, "get_system_prompt", lambda user_id=None, deep_mode=False: "system")
    monkeypatch.setattr(deep_agent_service, "codex_chat_client_for", _fake_codex_for(captured, client))
    monkeypatch.setattr(deep_agent_service, "get_sub_agent_llm_settings", _raise_settings)

    events = [
        event
        async for event in deep_agent_service.run_task_agent(
            description="do task",
            context_files=None,
            thread_id="thread-1",
            user_id="user-1",
            parent_tools=[],
            model_override="non-codex-override",
        )
    ]

    assert any(event["type"] == "sub_agent_complete" for event in events)
    assert captured["role"] == "agent"
    assert captured["reasoning_effort"] == CODEX_SUB_AGENT_REASONING_EFFORT == "medium"
    assert captured["request"]["model"] == "codex-model"
