"""Unit tests for the per-message model + thinking override.

Plan 13 (model config selector): the composer surfaces a model name + a
thinking on/off + effort selector, sent per message and applied to the primary
chat completion. Covers the schema, the provider reasoning mapping, and the
override threading through astream_chat_response.
"""
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.models.schemas import MessageCreate
from app.services.llm_service import build_reasoning_request

pytestmark = pytest.mark.unit


# --------------------------------------------------------------------------
# MessageCreate schema (Task 1)
# --------------------------------------------------------------------------
class TestMessageCreateModelFields:
    def test_defaults_are_backwards_compatible(self):
        m = MessageCreate(content="hi")
        assert m.model is None
        assert m.thinking is False
        assert m.reasoning_effort is None
        assert m.attachment_file_paths == []

    def test_parses_all_fields(self):
        m = MessageCreate(
            content="hi",
            model="anthropic/claude-3.5-sonnet",
            thinking=True,
            reasoning_effort="high",
            attachment_file_paths=["uploads/pasted-image.png"],
        )
        assert m.model == "anthropic/claude-3.5-sonnet"
        assert m.thinking is True
        assert m.reasoning_effort == "high"
        assert m.attachment_file_paths == ["uploads/pasted-image.png"]

    def test_model_is_stripped(self):
        assert MessageCreate(content="x", model="  gpt-4o  ").model == "gpt-4o"

    def test_blank_model_coerced_to_none(self):
        assert MessageCreate(content="x", model="   ").model is None

    def test_overlong_model_rejected(self):
        with pytest.raises(ValidationError):
            MessageCreate(content="x", model="m" * 201)

    def test_invalid_reasoning_effort_rejected(self):
        with pytest.raises(ValidationError):
            MessageCreate(content="x", reasoning_effort="ultra")


# --------------------------------------------------------------------------
# build_reasoning_request mapping table (Task 2)
# --------------------------------------------------------------------------
class TestBuildReasoningRequest:
    @pytest.mark.parametrize("style", ["auto", "openrouter", "openai", "none"])
    def test_thinking_off_is_noop_for_every_style(self, style):
        assert build_reasoning_request("https://openrouter.ai/api/v1", style, False, "high") == {}

    def test_auto_detects_openrouter(self):
        assert build_reasoning_request("https://openrouter.ai/api/v1", "auto", True, "high") == {
            "extra_body": {"reasoning": {"effort": "high"}}
        }

    def test_auto_detects_openai_from_empty_base_url(self):
        assert build_reasoning_request("", "auto", True, "low") == {"reasoning_effort": "low"}

    def test_auto_detects_openai_from_explicit_host(self):
        assert build_reasoning_request("https://api.openai.com/v1", "auto", True, "medium") == {
            "reasoning_effort": "medium"
        }

    def test_auto_unknown_provider_omits(self):
        # LMStudio / other local endpoints: omit to avoid 400s; local reasoning
        # models emit inline <think> without a request flag.
        assert build_reasoning_request("http://localhost:1234/v1", "auto", True, "high") == {}

    def test_explicit_style_overrides_detection(self):
        # OpenRouter base_url but pinned to the OpenAI param shape.
        assert build_reasoning_request("https://openrouter.ai/api/v1", "openai", True, "high") == {
            "reasoning_effort": "high"
        }

    def test_none_style_always_omits(self):
        assert build_reasoning_request("https://openrouter.ai/api/v1", "none", True, "high") == {}

    def test_missing_effort_defaults_medium(self):
        assert build_reasoning_request("https://openrouter.ai/api/v1", "auto", True, None) == {
            "extra_body": {"reasoning": {"effort": "medium"}}
        }

    def test_invalid_effort_defaults_medium(self):
        assert build_reasoning_request("", "openai", True, "bogus") == {"reasoning_effort": "medium"}


# --------------------------------------------------------------------------
# astream_chat_response override threading (Task 3)
# --------------------------------------------------------------------------
class _MockAsyncStream:
    """Mirror of the OpenAI async streaming iterator used elsewhere in tests."""

    def __init__(self, chunks):
        self._chunks = list(chunks)
        self._i = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._i >= len(self._chunks):
            raise StopAsyncIteration
        chunk = self._chunks[self._i]
        self._i += 1
        return chunk


def _stop_chunk():
    return SimpleNamespace(
        usage=None,
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(content="ok", tool_calls=None),
                finish_reason="stop",
            )
        ],
    )


async def _run_astream(monkeypatch, *, base_url, reasoning_style="auto", use_codex=False, **astream_kwargs):
    from app.services import llm_service

    captured: dict = {}
    codex_call: dict = {}

    async def fake_create(**kwargs):
        captured.update(kwargs)
        return _MockAsyncStream([_stop_chunk()])

    fake_client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=fake_create))
    )

    # Control the provider branch directly and record the per-request effort the
    # codex client would be built with.
    def fake_codex_for(role, llm_settings=None, reasoning_effort=None):
        codex_call["role"] = role
        codex_call["reasoning_effort"] = reasoning_effort
        return fake_client if use_codex else None

    monkeypatch.setattr(llm_service, "codex_chat_client_for", fake_codex_for)
    monkeypatch.setattr(
        llm_service,
        "get_global_llm_settings",
        lambda: {"model": "env-model", "base_url": base_url, "api_key": "k"},
    )
    monkeypatch.setattr(
        llm_service, "get_traced_async_openai_client", lambda **_: fake_client
    )
    monkeypatch.setattr(
        llm_service,
        "get_settings",
        lambda: SimpleNamespace(llm_reasoning_style=reasoning_style, codex_model="codex-default"),
    )

    events = []
    async for ev in llm_service.astream_chat_response(
        messages=[{"role": "user", "content": "hi"}],
        system_prompt="sys",  # bypass get_system_prompt (DB/skills lookup)
        **astream_kwargs,
    ):
        events.append(ev)
    return captured, codex_call


@pytest.mark.asyncio
async def test_model_override_used_when_provided(monkeypatch):
    captured, _ = await _run_astream(
        monkeypatch, base_url=None, model_override="anthropic/claude-3.5-sonnet"
    )
    assert captured["model"] == "anthropic/claude-3.5-sonnet"
    assert "reasoning_effort" not in captured
    assert "extra_body" not in captured


@pytest.mark.asyncio
async def test_env_model_used_when_no_override(monkeypatch):
    captured, _ = await _run_astream(monkeypatch, base_url=None)
    assert captured["model"] == "env-model"


@pytest.mark.asyncio
async def test_thinking_on_openrouter_sets_extra_body(monkeypatch):
    captured, _ = await _run_astream(
        monkeypatch,
        base_url="https://openrouter.ai/api/v1",
        thinking=True,
        reasoning_effort="low",
    )
    assert captured["extra_body"] == {"reasoning": {"effort": "low"}}


@pytest.mark.asyncio
async def test_thinking_off_sends_no_reasoning(monkeypatch):
    captured, _ = await _run_astream(
        monkeypatch, base_url="https://openrouter.ai/api/v1", thinking=False
    )
    assert "extra_body" not in captured
    assert "reasoning_effort" not in captured


@pytest.mark.asyncio
async def test_codex_path_uses_override_and_applies_reasoning_at_client(monkeypatch):
    # On the Codex path the model override still wins; reasoning is applied at the
    # client (via reasoning_effort), NOT as an OpenAI-compatible request kwarg.
    captured, codex_call = await _run_astream(
        monkeypatch,
        base_url=None,
        use_codex=True,
        model_override="my/model",
        thinking=True,
        reasoning_effort="high",
    )
    assert captured["model"] == "my/model"
    assert "reasoning_effort" not in captured
    assert "extra_body" not in captured
    # The UI thinking selection drives the codex client's reasoning effort.
    assert codex_call["reasoning_effort"] == "high"


@pytest.mark.asyncio
async def test_codex_thinking_off_passes_no_effort_override(monkeypatch):
    # Thinking off → no per-request effort; the codex client falls back to the
    # CODEX_REASONING_EFFORT env default.
    _, codex_call = await _run_astream(monkeypatch, base_url=None, use_codex=True, thinking=False)
    assert codex_call["reasoning_effort"] is None


@pytest.mark.asyncio
async def test_codex_thinking_on_defaults_effort_to_medium(monkeypatch):
    _, codex_call = await _run_astream(monkeypatch, base_url=None, use_codex=True, thinking=True)
    assert codex_call["reasoning_effort"] == "medium"


@pytest.mark.asyncio
async def test_codex_path_falls_back_to_codex_model(monkeypatch):
    captured, _ = await _run_astream(monkeypatch, base_url=None, use_codex=True)
    assert captured["model"] == "codex-default"


def test_codex_chat_client_for_threads_reasoning_effort(monkeypatch):
    """codex_chat_client_for passes the per-request effort into the codex client."""
    import app.services.codex_client as codex_client
    from app.services import llm_service

    captured: dict = {}

    def fake_build(model=None, reasoning_effort=None):
        captured["model"] = model
        captured["reasoning_effort"] = reasoning_effort
        return object()

    monkeypatch.setattr(codex_client, "build_codex_chat_client", fake_build)
    monkeypatch.setattr(
        llm_service,
        "get_settings",
        lambda: SimpleNamespace(
            llm_provider="codex", codex_model="gpt-5.5", sub_agent_base_url="", sub_agent_api_key=""
        ),
    )

    client = llm_service.codex_chat_client_for("primary", reasoning_effort="high")
    assert client is not None
    assert captured["model"] == "gpt-5.5"
    assert captured["reasoning_effort"] == "high"


# --------------------------------------------------------------------------
# Codex reasoning summary -> visible "Thought process" (<think>) block
# --------------------------------------------------------------------------
class _StubCodexAuth:
    def account_id(self):
        return "acct-test"

    async def get_access_token(self, *, force_refresh=False):
        return "tok"


class _FakeEventStream:
    def __init__(self, events):
        self._events = list(events)

    def __aiter__(self):
        async def gen():
            for e in self._events:
                yield e

        return gen()


def _codex_client_with_reasoning():
    from app.services.codex_client import CodexChatClient

    return CodexChatClient(
        model="gpt-5.5",
        base_url="http://x",
        reasoning_effort="high",
        reasoning_summary="auto",
        auth=_StubCodexAuth(),
    )


def test_codex_requests_reasoning_summary():
    client = _codex_client_with_reasoning()
    rk = client._to_responses_kwargs({"messages": [{"role": "user", "content": "x"}]})
    assert rk["reasoning"] == {"effort": "high", "summary": "auto"}


@pytest.mark.asyncio
async def test_codex_reasoning_summary_wrapped_as_think_block():
    client = _codex_client_with_reasoning()
    events = [
        {"type": "response.reasoning_summary_text.delta", "delta": "Think A. "},
        {"type": "response.reasoning_summary_text.delta", "delta": "Think B."},
        {"type": "response.output_text.delta", "delta": "Final answer"},
        {"type": "response.completed", "response": {"usage": {"input_tokens": 1, "output_tokens": 1}}},
    ]
    chunks = [c async for c in client._translate_events(_FakeEventStream(events))]
    text = "".join((c.choices[0].delta.content or "") for c in chunks)
    assert text == "<think>Think A. Think B.</think>Final answer"
    assert chunks[-1].choices[0].finish_reason == "stop"


# --------------------------------------------------------------------------
# /settings/models endpoint — the provider-driven model dropdown
# --------------------------------------------------------------------------
class _ModelsPage:
    def __init__(self, data):
        self.data = data


def _clear_models_cache():
    from app.routers import settings as settings_router
    settings_router._models_cache.clear()


@pytest.mark.asyncio
async def test_list_models_codex_returns_configured_model(monkeypatch):
    import app.config as app_config
    from app.routers.settings import list_available_models

    _clear_models_cache()
    monkeypatch.setattr(
        app_config,
        "get_settings",
        lambda: SimpleNamespace(llm_provider="codex", codex_model="gpt-5.5", llm_base_url=""),
    )
    res = await list_available_models(current_user=SimpleNamespace(id="u"))
    assert res.provider == "codex"
    assert [m.id for m in res.models] == ["gpt-5.5"]


@pytest.mark.asyncio
async def test_list_models_lists_and_sorts_for_openai_compatible(monkeypatch):
    import app.config as app_config
    import app.services.llm_service as llm_service
    import app.services.langsmith as langsmith
    from app.routers.settings import list_available_models

    _clear_models_cache()

    async def fake_list():
        return _ModelsPage([SimpleNamespace(id="z/model"), SimpleNamespace(id="a/model")])

    fake_client = SimpleNamespace(models=SimpleNamespace(list=fake_list))
    monkeypatch.setattr(
        app_config,
        "get_settings",
        lambda: SimpleNamespace(llm_provider="openrouter", codex_model="", llm_base_url="https://openrouter.ai/api/v1"),
    )
    monkeypatch.setattr(
        llm_service,
        "get_global_llm_settings",
        lambda: {"model": "x", "base_url": "https://openrouter.ai/api/v1", "api_key": "k"},
    )
    monkeypatch.setattr(langsmith, "get_traced_async_openai_client", lambda **_: fake_client)

    res = await list_available_models(current_user=SimpleNamespace(id="u"))
    assert res.provider == "openrouter"
    assert [m.id for m in res.models] == ["a/model", "z/model"]  # de-duped + sorted
    assert res.error is None


@pytest.mark.asyncio
async def test_list_models_degrades_gracefully_on_provider_error(monkeypatch):
    import app.config as app_config
    import app.services.llm_service as llm_service
    import app.services.langsmith as langsmith
    from app.routers.settings import list_available_models

    _clear_models_cache()

    async def boom():
        raise RuntimeError("provider down")

    fake_client = SimpleNamespace(models=SimpleNamespace(list=boom))
    monkeypatch.setattr(
        app_config,
        "get_settings",
        lambda: SimpleNamespace(llm_provider="", codex_model="", llm_base_url="http://localhost:1234/v1"),
    )
    monkeypatch.setattr(
        llm_service,
        "get_global_llm_settings",
        lambda: {"model": "x", "base_url": "http://localhost:1234/v1", "api_key": "k"},
    )
    monkeypatch.setattr(langsmith, "get_traced_async_openai_client", lambda **_: fake_client)

    res = await list_available_models(current_user=SimpleNamespace(id="u"))
    assert res.models == []
    assert res.error == "unavailable"
    assert res.provider == "openai"  # empty provider label defaults to "openai"
