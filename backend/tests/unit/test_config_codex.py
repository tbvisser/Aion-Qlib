"""Unit tests for the Codex provider config settings (plan 12, task 1)."""
import pytest
from pydantic import ValidationError

from app.config import Settings

# Settings has three required Supabase fields with no defaults. Pass them as
# init kwargs (highest precedence in pydantic-settings) so these tests are
# hermetic and don't depend on a real .env / environment.
_REQUIRED = dict(
    supabase_url="http://localhost",
    supabase_anon_key="anon",
    supabase_service_role_key="svc",
)


def test_codex_settings_defaults(monkeypatch):
    # conftest loads the real .env into os.environ; clear codex vars so this
    # "defaults" check is hermetic regardless of the developer's local .env.
    for k in ("LLM_PROVIDER", "CODEX_MODEL", "CODEX_REASONING_EFFORT", "CODEX_HOME", "CODEX_BASE_URL"):
        monkeypatch.delenv(k, raising=False)
    s = Settings(_env_file=None, **_REQUIRED)
    assert s.llm_provider == ""
    assert s.codex_model == "gpt-5.5"
    assert s.codex_home == ""
    assert s.codex_reasoning_effort == ""
    assert s.codex_base_url == "https://chatgpt.com/backend-api/codex"


def test_codex_settings_from_env(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "codex")
    monkeypatch.setenv("CODEX_MODEL", "gpt-5.4-mini")
    monkeypatch.setenv("CODEX_REASONING_EFFORT", "xhigh")
    monkeypatch.setenv("CODEX_HOME", "/tmp/codex")
    monkeypatch.setenv("CODEX_BASE_URL", "https://example.test/codex")
    # _env_file=None disables the dotenv file; env vars (monkeypatched) still apply.
    s = Settings(_env_file=None, **_REQUIRED)
    assert s.llm_provider == "codex"
    assert s.codex_model == "gpt-5.4-mini"
    assert s.codex_reasoning_effort == "xhigh"
    assert s.codex_home == "/tmp/codex"
    assert s.codex_base_url == "https://example.test/codex"


def test_llm_provider_rejects_unknown_value():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, llm_provider="bogus", **_REQUIRED)
