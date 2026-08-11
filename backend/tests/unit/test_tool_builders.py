"""Unit tests for Story 2.6: Decoupled workspace and planning tool builders.

Tests validate:
- AC1: build_workspace_tools() returns exactly 4 workspace tool definitions
- AC2: build_planning_tools() returns only write_todos, read_todos
- AC3: get_workspace_prompt() included unconditionally, get_deep_mode_prompt() has no workspace section
"""

from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.unit


# ===========================================================================
# AC1/AC2: Tool Builder Functions
# ===========================================================================


def test_build_workspace_tools_returns_four_tools():
    """[2.6-UNIT-001] build_workspace_tools() returns exactly 4 workspace tools."""
    from app.services.llm_service import build_workspace_tools

    tools = build_workspace_tools()
    assert len(tools) == 4
    names = {t["function"]["name"] for t in tools}
    assert names == {"write_file", "read_file", "edit_file", "list_files"}


def test_build_workspace_tools_schema_structure():
    """[2.6-UNIT-002] Each workspace tool has valid schema structure."""
    from app.services.llm_service import build_workspace_tools

    for tool in build_workspace_tools():
        assert tool["type"] == "function"
        func = tool["function"]
        assert "name" in func
        assert "description" in func
        assert "parameters" in func
        assert func["parameters"]["type"] == "object"


def test_workspace_read_tool_mentions_binary_extraction_and_ranges():
    from app.services.llm_service import build_workspace_tools

    tools = {tool["function"]["name"]: tool["function"] for tool in build_workspace_tools()}
    assert "extracted text for supported binary uploads" in tools["read_file"]["description"]
    assert "start_line/end_line" in tools["read_file"]["description"]


def test_build_planning_tools_returns_planning_tools():
    """[2.6-UNIT-003] build_planning_tools() returns write_todos, read_todos, and ask_user."""
    from app.services.llm_service import build_planning_tools

    tools = build_planning_tools()
    names = {t["function"]["name"] for t in tools}
    assert names == {"write_todos", "read_todos", "ask_user"}


def test_build_planning_tools_no_workspace_tools():
    """[2.6-UNIT-004] build_planning_tools() does not contain any workspace tools."""
    from app.services.llm_service import build_planning_tools

    workspace_names = {"write_file", "read_file", "edit_file", "list_files"}
    tools = build_planning_tools()
    names = {t["function"]["name"] for t in tools}
    assert names.isdisjoint(workspace_names), (
        f"Planning tools should not contain workspace tools, found: {names & workspace_names}"
    )


def test_build_workspace_tools_no_planning_tools():
    """[2.6-UNIT-005] build_workspace_tools() does not contain any planning tools."""
    from app.services.llm_service import build_workspace_tools

    planning_names = {"write_todos", "read_todos"}
    tools = build_workspace_tools()
    names = {t["function"]["name"] for t in tools}
    assert names.isdisjoint(planning_names), (
        f"Workspace tools should not contain planning tools, found: {names & planning_names}"
    )


# ===========================================================================
# AC3: System Prompt Functions
# ===========================================================================


def test_get_workspace_prompt_contains_workspace_section():
    """[2.6-UNIT-006] get_workspace_prompt() contains workspace instructions."""
    from app.services.llm_service import get_workspace_prompt

    prompt = get_workspace_prompt()
    assert "## Workspace" in prompt
    assert "write_file" in prompt
    assert "read_file" in prompt
    assert "edit_file" in prompt
    assert "list_files" in prompt


def test_get_workspace_prompt_routes_chat_attachments_to_workspace(monkeypatch):
    """Uploaded chat files should be treated as workspace files, not KB documents."""
    from app.services import llm_service

    monkeypatch.setattr(
        llm_service,
        "get_settings",
        lambda: SimpleNamespace(sandbox_enabled=True),
    )

    prompt = llm_service.get_workspace_prompt()
    assert "uploaded, attached" in prompt
    assert "thread workspace files" in prompt
    assert "not knowledge-base Documents" in prompt
    assert "/sandbox/workspace/<file_path>" in prompt


def test_get_workspace_prompt_no_deep_mode_reference():
    """[2.6-UNIT-007] get_workspace_prompt() does not reference 'Deep Mode'."""
    from app.services.llm_service import get_workspace_prompt

    prompt = get_workspace_prompt()
    assert "Deep Mode" not in prompt


def test_get_deep_mode_prompt_no_workspace_section():
    """[2.6-UNIT-008] get_deep_mode_prompt() no longer contains workspace section."""
    from app.services.llm_service import get_deep_mode_prompt

    prompt = get_deep_mode_prompt()
    assert "## Deep Mode: Workspace" not in prompt
    assert "write_file" not in prompt
    assert "read_file" not in prompt
    assert "edit_file" not in prompt
    assert "list_files" not in prompt


def test_get_deep_mode_prompt_retains_planning():
    """[2.6-UNIT-009] get_deep_mode_prompt() still contains planning section."""
    from app.services.llm_service import get_deep_mode_prompt

    prompt = get_deep_mode_prompt()
    assert "Planning with Todos" in prompt
    assert "write_todos" in prompt
    assert "read_todos" in prompt


def test_get_deep_mode_prompt_retains_delegation():
    """[2.6-UNIT-010] get_deep_mode_prompt() still contains delegation section."""
    from app.services.llm_service import get_deep_mode_prompt

    prompt = get_deep_mode_prompt()
    assert "Delegation" in prompt


def test_system_prompt_always_includes_workspace():
    """[2.6-UNIT-011] get_system_prompt() includes workspace section regardless of deep_mode."""
    from app.services.llm_service import get_system_prompt

    # Standard mode
    standard_prompt = get_system_prompt(deep_mode=False)
    assert "## Workspace" in standard_prompt

    # Deep mode
    deep_prompt = get_system_prompt(deep_mode=True)
    assert "## Workspace" in deep_prompt


def test_system_prompt_deep_mode_includes_planning():
    """[2.6-UNIT-012] get_system_prompt(deep_mode=True) includes planning section."""
    from app.services.llm_service import get_system_prompt

    prompt = get_system_prompt(deep_mode=True)
    assert "Planning with Todos" in prompt


def test_system_prompt_standard_mode_excludes_planning():
    """[2.6-UNIT-013] get_system_prompt(deep_mode=False) excludes planning section."""
    from app.services.llm_service import get_system_prompt

    prompt = get_system_prompt(deep_mode=False)
    assert "Planning with Todos" not in prompt


def test_system_prompt_excludes_sandbox_instructions_when_disabled(monkeypatch):
    """get_system_prompt() omits Code Mode and sandbox guidance when sandbox is disabled."""
    from app.services import llm_service

    monkeypatch.setattr(
        llm_service,
        "get_settings",
        lambda: SimpleNamespace(
            sandbox_enabled=False,
            tool_registry_enabled=False,
            pii_redaction_enabled=False,
            max_tool_rounds=25,
            max_deep_rounds=50,
        ),
    )

    prompt = llm_service.get_system_prompt(deep_mode=True)

    assert "## Workspace" in prompt
    assert "Planning with Todos" in prompt
    assert "calculator" in prompt
    assert "execute_code" not in prompt
    assert "Code Mode" not in prompt
    assert "/sandbox/output" not in prompt
    assert "sandbox filesystem" not in prompt
    assert "code sandbox" not in prompt


def test_system_prompt_includes_sandbox_instructions_when_enabled(monkeypatch):
    """get_system_prompt() includes Code Mode and sandbox guidance when sandbox is enabled."""
    from app.services import llm_service

    monkeypatch.setattr(
        llm_service,
        "get_settings",
        lambda: SimpleNamespace(
            sandbox_enabled=True,
            tool_registry_enabled=False,
            pii_redaction_enabled=False,
            max_tool_rounds=25,
            max_deep_rounds=50,
        ),
    )

    prompt = llm_service.get_system_prompt(deep_mode=True)

    assert "execute_code" in prompt
    assert "Code Mode" in prompt
    assert "/sandbox/output" in prompt
    assert "/sandbox/workspace" in prompt


@pytest.mark.parametrize("tool_registry_enabled", [False, True])
def test_system_tools_section_excludes_sandbox_when_disabled(tool_registry_enabled):
    """Tool sections stay sandbox-free in both inline and registry prompt modes."""
    from app.services.llm_service import _build_system_tools_section

    section = _build_system_tools_section(
        SimpleNamespace(
            sandbox_enabled=False,
            tool_registry_enabled=tool_registry_enabled,
        )
    )

    assert "calculator" in section
    assert "execute_code" not in section
    assert "Code Mode" not in section
    assert "/sandbox/output" not in section


def test_build_rag_tools_sql_tool_is_gated_by_include_sql():
    """The text-to-SQL tool appears only when include_sql is true; the other
    budget/HR demo tools are never emitted (no schema/handler wired)."""
    from app.services.llm_service import build_rag_tools

    with_sql = {
        t["function"]["name"]
        for t in build_rag_tools(
            include_web_search=True,
            include_sql=True,
            include_code_execution=False,
        )
    }
    without_sql = {
        t["function"]["name"]
        for t in build_rag_tools(
            include_web_search=True,
            include_sql=False,
            include_code_execution=False,
        )
    }

    # query_sales_database is gated on include_sql
    assert "query_sales_database" in with_sql
    assert "query_sales_database" not in without_sql

    # The remaining demo tools are never emitted regardless of the flag
    assert {
        "get_team_members",
        "get_expenses",
        "get_budget_by_level",
    }.isdisjoint(with_sql)


def test_document_tools_distinguish_knowledge_base_from_workspace_uploads():
    """KB document tools should not be described as the path for chat attachments."""
    from app.services.llm_service import build_rag_tools

    tools = build_rag_tools(
        include_web_search=False,
        include_sql=False,
        include_code_execution=False,
    )
    descriptions = {
        tool["function"]["name"]: tool["function"]["description"]
        for tool in tools
        if tool["function"]["name"] in {"search_documents", "grep", "glob", "read"}
    }

    assert "knowledge-base/document-library" in descriptions["search_documents"]
    assert "newly attached chat workspace files" in descriptions["search_documents"]
    assert "Do not use for newly attached chat workspace files" in descriptions["grep"]
    assert "Do not use for newly attached chat workspace files" in descriptions["glob"]
    assert "do not use for newly attached chat workspace files" in descriptions["read"]


def test_execute_code_tool_mentions_workspace_mount():
    from app.services.llm_service import build_rag_tools

    tools = build_rag_tools(
        include_web_search=False,
        include_sql=False,
        include_code_execution=True,
    )
    execute_code = next(tool for tool in tools if tool["function"]["name"] == "execute_code")

    assert "binary workspace-file analysis" in execute_code["function"]["description"]
    assert "/sandbox/workspace/<file_path>" in execute_code["function"]["description"]


# ===========================================================================
# Tool Assembly Integration (mirrors chat.py logic)
# ===========================================================================


def test_standard_mode_tool_assembly_includes_workspace_not_planning():
    """[2.6-UNIT-014] Standard mode assembly includes workspace tools, excludes planning tools."""
    from app.services.llm_service import build_rag_tools, build_workspace_tools, build_planning_tools

    # Simulate chat.py tool assembly for standard mode (deep_mode=False)
    tools = build_rag_tools(include_web_search=False, include_sql=True, include_code_execution=False)
    tools.extend(build_workspace_tools())
    # NOT extending with planning tools (deep_mode=false)

    tool_names = {t["function"]["name"] for t in tools}
    # Workspace tools present
    assert {"write_file", "read_file", "edit_file", "list_files"}.issubset(tool_names)
    # Planning tools absent
    assert "write_todos" not in tool_names
    assert "read_todos" not in tool_names


def test_deep_mode_tool_assembly_includes_workspace_and_planning():
    """[2.6-UNIT-015] Deep mode assembly includes both workspace and planning tools."""
    from app.services.llm_service import build_rag_tools, build_workspace_tools, build_planning_tools

    # Simulate chat.py tool assembly for deep mode (deep_mode=True)
    tools = build_rag_tools(include_web_search=False, include_sql=True, include_code_execution=False)
    tools.extend(build_workspace_tools())
    tools.extend(build_planning_tools())

    tool_names = {t["function"]["name"] for t in tools}
    assert {"write_file", "read_file", "edit_file", "list_files"}.issubset(tool_names)
    assert {"write_todos", "read_todos"}.issubset(tool_names)


def test_build_workspace_tools_returns_copy():
    """[2.6-UNIT-016] build_workspace_tools() returns a new list each call (safe from mutation)."""
    from app.services.llm_service import build_workspace_tools

    a = build_workspace_tools()
    b = build_workspace_tools()
    assert a is not b
    assert a == b


def test_build_planning_tools_returns_copy():
    """[2.6-UNIT-017] build_planning_tools() returns a new list each call (safe from mutation)."""
    from app.services.llm_service import build_planning_tools

    a = build_planning_tools()
    b = build_planning_tools()
    assert a is not b
    assert a == b
