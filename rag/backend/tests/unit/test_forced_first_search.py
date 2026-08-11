"""Unit tests for round-1 forced document retrieval (grounded-by-default fix).

Background: with tool_choice="auto" the chat model frequently answered from
general knowledge and skipped search_documents, so answers weren't grounded and
no citations were produced. The fix forces search_documents on the first tool
round for substantive questions when the user has documents.

Tests validate:
- _message_warrants_search() skips greetings/acks/empty but allows real questions
- astream_chat_response threads tool_choice into the provider request kwargs
"""

import pytest

pytestmark = pytest.mark.unit


# ===========================================================================
# _message_warrants_search heuristic
# ===========================================================================


@pytest.mark.parametrize(
    "content",
    [
        "Based on the survey findings, what characterizes firms needing export help?",
        "Summarize the report's conclusions about UKTI support.",
        "what is pgvector",
        "Compare A and B.",
    ],
)
def test_warrants_search_true_for_questions(content):
    from app.routers.chat import _message_warrants_search

    assert _message_warrants_search(content) is True


@pytest.mark.parametrize(
    "content",
    [
        None,
        "",
        "   ",
        "hi",
        "Hello",
        "hey!",
        "thanks",
        "Thank you.",
        "ok",
        "cool",
        "ty",
    ],
)
def test_warrants_search_false_for_greetings_and_empty(content):
    from app.routers.chat import _message_warrants_search

    assert _message_warrants_search(content) is False


# ===========================================================================
# tool_choice plumbing into the provider request
# ===========================================================================


@pytest.mark.asyncio
async def test_astream_passes_tool_choice_into_request_kwargs(monkeypatch):
    """When tool_choice is provided alongside tools, it must be forwarded to the
    OpenAI-compatible chat.completions.create call."""
    from app.services import llm_service

    captured = {}

    class _FakeStream:
        def __aiter__(self):
            async def _gen():
                return
                yield  # pragma: no cover - empty async generator
            return _gen()

        async def close(self):
            pass

    class _FakeCompletions:
        async def create(self, **kwargs):
            captured.update(kwargs)
            return _FakeStream()

    class _FakeChat:
        completions = _FakeCompletions()

    class _FakeClient:
        chat = _FakeChat()

    # Force the OpenAI-compatible (non-codex) path with a stub client.
    monkeypatch.setattr(llm_service, "codex_chat_client_for", lambda *a, **k: None)
    monkeypatch.setattr(
        llm_service, "get_global_llm_settings",
        lambda: {"model": "gpt-4o", "base_url": "http://x", "api_key": "k"},
    )
    monkeypatch.setattr(
        llm_service, "get_traced_async_openai_client",
        lambda **kwargs: _FakeClient(),
    )

    forced = {"type": "function", "function": {"name": "search_documents"}}
    tools = [{"type": "function", "function": {"name": "search_documents"}}]

    gen = llm_service.astream_chat_response(
        [{"role": "user", "content": "q"}],
        tools=tools,
        system_prompt="sys",
        tool_choice=forced,
    )
    async for _ in gen:
        pass

    assert captured.get("tool_choice") == forced
    # And without tool_choice it must NOT be set (preserves auto default).
    captured.clear()
    gen2 = llm_service.astream_chat_response(
        [{"role": "user", "content": "q"}],
        tools=tools,
        system_prompt="sys",
    )
    async for _ in gen2:
        pass
    assert "tool_choice" not in captured
