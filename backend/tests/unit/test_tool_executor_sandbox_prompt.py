"""Unit tests for sandbox-specific tool context."""

import json
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.unit


class _FakeQuery:
    def __init__(self, table_name: str):
        self.table_name = table_name

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def execute(self):
        if self.table_name == "skills":
            return SimpleNamespace(
                data=[
                    {
                        "id": "skill-1",
                        "name": "demo-skill",
                        "instructions": "Use the best available tools.",
                        "user_id": None,
                    }
                ]
            )
        if self.table_name == "skill_files":
            return SimpleNamespace(data=[])
        return SimpleNamespace(data=[])


class _FakeSupabase:
    def table(self, table_name: str):
        return _FakeQuery(table_name)


async def _load_skill(monkeypatch, *, sandbox_enabled: bool) -> str:
    from app.services import tool_executor

    monkeypatch.setattr(tool_executor, "get_supabase_client", lambda: _FakeSupabase())
    monkeypatch.setattr(
        tool_executor.app_config,
        "get_settings",
        lambda: SimpleNamespace(sandbox_enabled=sandbox_enabled),
    )

    result = await tool_executor.execute_tool_call(
        {
            "name": "load_skill",
            "arguments": json.dumps({"skill_id": "skill-1"}),
        },
        user_id="user-1",
    )
    assert isinstance(result, str)
    return result


@pytest.mark.asyncio
async def test_load_skill_omits_sandbox_reminder_when_disabled(monkeypatch):
    result = await _load_skill(monkeypatch, sandbox_enabled=False)

    assert "# Skill: demo-skill" in result
    assert "code sandbox" not in result
    assert "Python ONLY" not in result


@pytest.mark.asyncio
async def test_load_skill_includes_sandbox_reminder_when_enabled(monkeypatch):
    result = await _load_skill(monkeypatch, sandbox_enabled=True)

    assert "code sandbox" in result
    assert "Python ONLY" in result
