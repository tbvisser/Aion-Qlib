"""Unit tests for OpenRouter reasoning -> <think> wrapping in the chat stream.

OpenRouter (and other OpenAI-compatible reasoning models) return reasoning in a
separate ``delta.reasoning`` field rather than as ``<think>`` tags in content.
astream_chat_response must wrap those deltas into a ``<think>`` block so the
frontend's existing "Thought process" panel renders them.
"""
from types import SimpleNamespace

import pytest

from app.services import llm_service


def _delta(*, content=None, reasoning=None, tool_calls=None):
    return SimpleNamespace(content=content, reasoning=reasoning, tool_calls=tool_calls)


def _chunk(delta, *, finish_reason=None, usage=None):
    return SimpleNamespace(
        choices=[SimpleNamespace(delta=delta, finish_reason=finish_reason)],
        usage=usage,
    )


class _FakeStream:
    def __init__(self, chunks):
        self._chunks = chunks

    def __aiter__(self):
        async def gen():
            for c in self._chunks:
                yield c

        return gen()

    async def close(self):
        pass


class _FakeClient:
    def __init__(self, chunks):
        self._chunks = chunks
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs):
        return _FakeStream(self._chunks)


@pytest.mark.asyncio
async def test_openrouter_reasoning_wrapped_in_think_tags(monkeypatch):
    usage = SimpleNamespace(prompt_tokens=1, completion_tokens=2, total_tokens=3)
    chunks = [
        _chunk(_delta(reasoning="Let me ")),
        _chunk(_delta(reasoning="think.")),
        _chunk(_delta(content="The answer")),
        _chunk(_delta(content=" is 42."), finish_reason="stop", usage=usage),
    ]

    monkeypatch.setattr(llm_service, "codex_chat_client_for", lambda *a, **k: None)
    monkeypatch.setattr(
        llm_service, "get_global_llm_settings",
        lambda: {"model": "x", "base_url": "https://openrouter.ai/api/v1", "api_key": "k"},
    )
    monkeypatch.setattr(
        llm_service, "get_traced_async_openai_client",
        lambda **k: _FakeClient(chunks),
    )
    monkeypatch.setattr(
        llm_service, "get_settings",
        lambda: SimpleNamespace(llm_reasoning_style="openrouter"),
    )
    monkeypatch.setattr(llm_service, "get_system_prompt", lambda **k: "sys")

    events = [
        e async for e in llm_service.astream_chat_response(
            [{"role": "user", "content": "hi"}],
            thinking=True,
            reasoning_effort="medium",
        )
    ]

    text = "".join(e["content"] for e in events if e["type"] == "text_delta")
    assert text == "<think>Let me think.</think>The answer is 42."

    completed = [e for e in events if e["type"] == "response_completed"]
    assert completed and completed[0]["content"] == "<think>Let me think.</think>The answer is 42."


@pytest.mark.asyncio
async def test_no_reasoning_means_no_think_tags(monkeypatch):
    usage = SimpleNamespace(prompt_tokens=1, completion_tokens=2, total_tokens=3)
    chunks = [
        _chunk(_delta(content="Plain answer.")),
        _chunk(_delta(content=""), finish_reason="stop", usage=usage),
    ]

    monkeypatch.setattr(llm_service, "codex_chat_client_for", lambda *a, **k: None)
    monkeypatch.setattr(
        llm_service, "get_global_llm_settings",
        lambda: {"model": "x", "base_url": "https://openrouter.ai/api/v1", "api_key": "k"},
    )
    monkeypatch.setattr(
        llm_service, "get_traced_async_openai_client",
        lambda **k: _FakeClient(chunks),
    )
    monkeypatch.setattr(
        llm_service, "get_settings",
        lambda: SimpleNamespace(llm_reasoning_style="openrouter"),
    )
    monkeypatch.setattr(llm_service, "get_system_prompt", lambda **k: "sys")

    events = [
        e async for e in llm_service.astream_chat_response(
            [{"role": "user", "content": "hi"}],
            thinking=False,
        )
    ]

    text = "".join(e["content"] for e in events if e["type"] == "text_delta")
    assert "<think>" not in text
    assert text == "Plain answer."
