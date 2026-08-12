"""API tests for Story 3.1: Deep Agent Service — task tool registration and dispatch.

Tests validate:
- AC2: task tool available in deep mode, excluded in standard mode
- AC2: Sub-agent tool set excludes task, write_todos, read_todos
- AC4: task dispatch returns AsyncGenerator
"""
import pytest

pytestmark = pytest.mark.api


class TestTaskToolAvailability:
    """Test that the task tool is gated on deep_mode."""

    def test_task_tool_in_deep_mode_assembly(self):
        """[3.1-API-001] task tool is included when deep_mode=True."""
        from app.services.llm_service import (
            build_rag_tools,
            build_workspace_tools,
            build_planning_tools,
            build_delegation_tools,
        )

        tools = build_rag_tools(include_web_search=False, include_sql=False, include_code_execution=False)
        tools.extend(build_workspace_tools())
        tools.extend(build_planning_tools())
        tools.extend(build_delegation_tools())

        tool_names = {t["function"]["name"] for t in tools}
        assert "task" in tool_names

    def test_task_tool_not_in_standard_mode(self):
        """[3.1-API-002] task tool is NOT included when deep_mode=False."""
        from app.services.llm_service import (
            build_rag_tools,
            build_workspace_tools,
        )

        tools = build_rag_tools(include_web_search=False, include_sql=False, include_code_execution=False)
        tools.extend(build_workspace_tools())
        # NOT adding planning or delegation tools (standard mode)

        tool_names = {t["function"]["name"] for t in tools}
        assert "task" not in tool_names

    def test_task_tool_schema_structure(self):
        """[3.1-API-003] task tool has correct schema with description and context_files params."""
        from app.services.llm_service import build_delegation_tools

        tools = build_delegation_tools()
        assert len(tools) == 1
        task_tool = tools[0]
        assert task_tool["type"] == "function"
        func = task_tool["function"]
        assert func["name"] == "task"
        assert "description" in func["parameters"]["properties"]
        assert "context_files" in func["parameters"]["properties"]
        assert func["parameters"]["required"] == ["description"]


class TestTaskDispatch:
    """Test that tool_executor dispatches task correctly."""

    @pytest.mark.asyncio
    async def test_task_dispatch_returns_async_generator(self):
        """[3.1-API-004] task tool dispatch returns an AsyncGenerator."""
        from unittest.mock import patch, AsyncMock, MagicMock

        from app.services.tool_executor import execute_tool_call

        # Mock the deep agent service to return a simple generator
        async def mock_generator(*args, **kwargs):
            yield {"type": "sub_agent_start", "sub_agent_id": "test-id", "description": "test"}
            yield {"type": "sub_agent_complete", "sub_agent_id": "test-id", "result_summary": "done"}

        with patch("app.services.deep_agent_service.run_task_agent", side_effect=mock_generator):
            tool_call = {
                "name": "task",
                "arguments": '{"description": "test task"}',
            }
            result = await execute_tool_call(
                tool_call, "user-1", thread_id="thread-1", tools=[]
            )

            # Result should be an async generator
            assert hasattr(result, "__anext__")

            # Consume the generator
            events = []
            async for event in result:
                events.append(event)

            assert len(events) == 2
            assert events[0]["type"] == "sub_agent_start"
            assert events[1]["type"] == "sub_agent_complete"

    @pytest.mark.asyncio
    async def test_task_dispatch_requires_thread_id(self):
        """[3.1-API-005] task tool returns error when no thread_id."""
        from app.services.tool_executor import execute_tool_call

        tool_call = {
            "name": "task",
            "arguments": '{"description": "test task"}',
        }
        result = await execute_tool_call(tool_call, "user-1", thread_id=None)
        assert isinstance(result, str)
        assert "Error" in result

    @pytest.mark.asyncio
    async def test_task_dispatch_requires_description(self):
        """[3.1-API-006] task tool returns error when no description."""
        from app.services.tool_executor import execute_tool_call

        tool_call = {
            "name": "task",
            "arguments": '{}',
        }
        result = await execute_tool_call(tool_call, "user-1", thread_id="thread-1")
        assert isinstance(result, str)
        assert "Error" in result


class TestSubAgentToolFiltering:
    """Test that the sub-agent receives filtered tools."""

    def test_sub_agent_tools_exclude_delegation_and_planning(self):
        """[3.1-API-007] Sub-agent tool set excludes task, write_todos, read_todos."""
        from app.services.deep_agent_service import _filter_tools

        parent_tools = [
            {"function": {"name": "search_documents"}},
            {"function": {"name": "write_file"}},
            {"function": {"name": "read_file"}},
            {"function": {"name": "edit_file"}},
            {"function": {"name": "list_files"}},
            {"function": {"name": "task"}},
            {"function": {"name": "write_todos"}},
            {"function": {"name": "read_todos"}},
            {"function": {"name": "web_search"}},
        ]

        sub_tools = _filter_tools(parent_tools)
        sub_names = {t["function"]["name"] for t in sub_tools}

        # Excluded
        assert "task" not in sub_names
        assert "write_todos" not in sub_names
        assert "read_todos" not in sub_names

        # Preserved
        assert "search_documents" in sub_names
        assert "write_file" in sub_names
        assert "read_file" in sub_names
        assert "edit_file" in sub_names
        assert "list_files" in sub_names
        assert "web_search" in sub_names


class TestDelegationToolBuilder:
    """Test build_delegation_tools function."""

    def test_build_delegation_tools_returns_copy(self):
        """[3.1-API-008] build_delegation_tools() returns a new list each call."""
        from app.services.llm_service import build_delegation_tools

        a = build_delegation_tools()
        b = build_delegation_tools()
        assert a is not b
        assert a == b

    def test_delegation_tools_not_in_planning_tools(self):
        """[3.1-API-009] task tool is separate from planning tools."""
        from app.services.llm_service import build_planning_tools, build_delegation_tools

        planning_names = {t["function"]["name"] for t in build_planning_tools()}
        delegation_names = {t["function"]["name"] for t in build_delegation_tools()}

        assert planning_names.isdisjoint(delegation_names)
