"""Unit tests for chat provider routing (plan 12, task 5)."""
from types import SimpleNamespace

from app.services import codex_client, llm_service
from app.services.codex_client import CodexChatClient


def _patch_settings(monkeypatch, **overrides):
    base = dict(
        llm_provider="",
        codex_model="gpt-5.5",
        codex_base_url="https://chatgpt.com/backend-api/codex",
        codex_reasoning_effort="",
        sub_agent_base_url="",
        sub_agent_api_key="",
    )
    base.update(overrides)
    settings = SimpleNamespace(**base)
    monkeypatch.setattr(llm_service, "get_settings", lambda: settings)
    monkeypatch.setattr(codex_client, "get_settings", lambda: settings)
    return settings


def test_disabled_by_default(monkeypatch):
    _patch_settings(monkeypatch)  # llm_provider=""
    assert llm_service._codex_enabled_for("primary") is False
    assert llm_service._codex_enabled_for("agent") is False
    assert llm_service.codex_chat_client_for("primary") is None
    assert llm_service.codex_chat_client_for("agent") is None


def test_codex_enabled_for_both_roles(monkeypatch):
    _patch_settings(monkeypatch, llm_provider="codex")
    assert llm_service._codex_enabled_for("primary") is True
    assert llm_service._codex_enabled_for("agent") is True
    client = llm_service.codex_chat_client_for("primary")
    assert isinstance(client, CodexChatClient)
    assert client._model == "gpt-5.5"


def test_codex_rewrites_caller_settings_model(monkeypatch):
    _patch_settings(monkeypatch, llm_provider="codex", codex_model="gpt-5.4-mini")
    settings = {"model": "gpt-4o", "base_url": "https://openrouter.ai/api/v1", "api_key": "k"}
    client = llm_service.codex_chat_client_for("agent", settings)
    assert isinstance(client, CodexChatClient)
    # The caller's request_kwargs read llm_settings["model"], so it must be rewritten.
    assert settings["model"] == "gpt-5.4-mini"


def test_agent_role_uses_codex_even_with_sub_agent_override(monkeypatch):
    _patch_settings(
        monkeypatch,
        llm_provider="codex",
        codex_model="gpt-5.4-mini",
        sub_agent_base_url="https://openrouter.ai/api/v1",
        sub_agent_api_key="k",
    )
    assert llm_service._codex_enabled_for("primary") is True
    assert llm_service._codex_enabled_for("agent") is True

    settings = {"model": "sub-agent-model", "base_url": "https://openrouter.ai/api/v1", "api_key": "k"}
    client = llm_service.codex_chat_client_for(
        "agent",
        settings,
        reasoning_effort=llm_service.CODEX_SUB_AGENT_REASONING_EFFORT,
    )

    assert isinstance(client, CodexChatClient)
    assert settings["model"] == "gpt-5.4-mini"
    assert client._model == "gpt-5.4-mini"
    assert client._reasoning_effort == "medium"
