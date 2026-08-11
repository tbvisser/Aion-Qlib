"""Unit tests for Codex stream translation + 401 retry (Responses -> Chat chunks). Plan 12, task 4."""
import httpx
import pytest
from openai import AuthenticationError

from app.services.codex_client import CodexChatClient


class _StubAuth:
    def __init__(self):
        self.calls = []

    def account_id(self):
        return "acct-test"

    async def get_access_token(self, *, force_refresh=False):
        self.calls.append(force_refresh)
        return "tok"


class _FakeStream:
    def __init__(self, events):
        self._events = list(events)

    def __aiter__(self):
        self._it = iter(self._events)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration

    async def close(self):
        pass


class _FakeResponses:
    def __init__(self, events, fail_first_401=False):
        self._events = events
        self._fail_first_401 = fail_first_401
        self.calls = 0

    async def create(self, **kwargs):
        self.calls += 1
        if self._fail_first_401 and self.calls == 1:
            resp = httpx.Response(401, request=httpx.Request("POST", "https://x/responses"))
            raise AuthenticationError("unauthorized", response=resp, body=None)
        return _FakeStream(self._events)


class _FakeInner:
    def __init__(self, responses):
        self.responses = responses


def _client_with(events, fail_first_401=False):
    auth = _StubAuth()
    client = CodexChatClient(model="gpt-5.5", base_url="http://x", auth=auth)
    fake_responses = _FakeResponses(events, fail_first_401=fail_first_401)
    client._build_inner = lambda token: _FakeInner(fake_responses)
    return client, auth, fake_responses


async def _collect(client, **kwargs):
    stream = await client.chat.completions.create(stream=True, **kwargs)
    return [chunk async for chunk in stream]


async def test_text_stream_translation():
    events = [
        {"type": "response.output_text.delta", "delta": "Hello"},
        {"type": "response.output_text.delta", "delta": " world"},
        {"type": "response.completed", "response": {"usage": {"input_tokens": 10, "output_tokens": 5}}},
    ]
    client, _, _ = _client_with(events)
    chunks = await _collect(client, model="gpt-5.5", messages=[{"role": "user", "content": "hi"}])

    text = "".join(c.choices[0].delta.content or "" for c in chunks)
    assert text == "Hello world"
    final = chunks[-1]
    assert final.choices[0].finish_reason == "stop"
    assert final.usage.prompt_tokens == 10
    assert final.usage.completion_tokens == 5
    assert final.usage.total_tokens == 15


async def test_tool_call_stream_translation():
    events = [
        {"type": "response.output_item.added", "output_index": 0,
         "item": {"type": "function_call", "call_id": "call_1", "name": "search", "arguments": ""}},
        {"type": "response.function_call_arguments.delta", "output_index": 0, "delta": '{"q":'},
        {"type": "response.function_call_arguments.delta", "output_index": 0, "delta": '"x"}'},
        {"type": "response.completed", "response": {"usage": {"input_tokens": 3, "output_tokens": 7}}},
    ]
    client, _, _ = _client_with(events)
    chunks = await _collect(client, model="gpt-5.5", messages=[{"role": "user", "content": "go"}],
                            tools=[{"type": "function", "function": {"name": "search", "parameters": {}}}])

    # Reconstruct the tool call the way the app's streaming loops do.
    buffer: dict[int, dict] = {}
    for c in chunks:
        for tc in (c.choices[0].delta.tool_calls or []):
            slot = buffer.setdefault(tc.index, {"id": None, "name": None, "arguments": ""})
            if tc.id:
                slot["id"] = tc.id
            if tc.function and tc.function.name:
                slot["name"] = tc.function.name
            if tc.function and tc.function.arguments:
                slot["arguments"] += tc.function.arguments

    assert buffer[0] == {"id": "call_1", "name": "search", "arguments": '{"q":"x"}'}
    assert chunks[-1].choices[0].finish_reason == "tool_calls"


async def test_401_triggers_single_refresh_and_retry():
    events = [
        {"type": "response.output_text.delta", "delta": "ok"},
        {"type": "response.completed", "response": {"usage": {"input_tokens": 1, "output_tokens": 1}}},
    ]
    client, auth, fake_responses = _client_with(events, fail_first_401=True)
    chunks = await _collect(client, model="gpt-5.5", messages=[{"role": "user", "content": "hi"}])

    assert "".join(c.choices[0].delta.content or "" for c in chunks) == "ok"
    assert fake_responses.calls == 2  # failed once, retried once
    assert auth.calls == [False, True]  # second acquisition forced a refresh


async def test_stream_error_event_raises():
    events = [{"type": "response.failed", "response": {"error": {"message": "boom"}}}]
    client, _, _ = _client_with(events)
    with pytest.raises(RuntimeError, match="boom"):
        await _collect(client, model="gpt-5.5", messages=[{"role": "user", "content": "hi"}])
