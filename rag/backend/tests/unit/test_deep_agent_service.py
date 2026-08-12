"""Unit tests for deep_agent_service.py."""
import pytest
from unittest.mock import AsyncMock, patch, MagicMock


@pytest.fixture(autouse=True)
def _disable_codex_for_existing_deep_agent_tests(monkeypatch):
    monkeypatch.setattr(
        "app.services.deep_agent_service.codex_chat_client_for",
        lambda *args, **kwargs: None,
    )


class MockAsyncStream:
    """Helper for mocking OpenAI async streaming responses."""

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


class TestFilterTools:
    """Test tool filtering logic."""

    def test_excludes_task_write_todos_read_todos(self):
        from app.services.deep_agent_service import _filter_tools

        parent_tools = [
            {"function": {"name": "search_documents"}},
            {"function": {"name": "task"}},
            {"function": {"name": "write_todos"}},
            {"function": {"name": "read_todos"}},
            {"function": {"name": "write_file"}},
            {"function": {"name": "read_file"}},
        ]
        result = _filter_tools(parent_tools)
        names = [t["function"]["name"] for t in result]
        assert "task" not in names
        assert "write_todos" not in names
        assert "read_todos" not in names
        assert "search_documents" in names
        assert "write_file" in names
        assert "read_file" in names

    def test_preserves_all_other_tools(self):
        from app.services.deep_agent_service import _filter_tools

        parent_tools = [
            {"function": {"name": "search_documents"}},
            {"function": {"name": "web_search"}},
            {"function": {"name": "execute_code"}},
            {"function": {"name": "write_file"}},
        ]
        result = _filter_tools(parent_tools)
        assert len(result) == 4

    def test_empty_tools(self):
        from app.services.deep_agent_service import _filter_tools

        assert _filter_tools([]) == []


class TestBuildSubAgentContext:
    """Test context building for sub-agent."""

    @pytest.mark.asyncio
    async def test_description_only(self):
        from app.services.deep_agent_service import _build_sub_agent_context

        result = await _build_sub_agent_context(
            "Do something", None, "thread-1", "user-1"
        )
        assert result == "Do something"

    @pytest.mark.asyncio
    async def test_with_context_files(self):
        from app.services.deep_agent_service import _build_sub_agent_context

        with patch("app.services.workspace_service.read_file", new_callable=AsyncMock) as mock_read:
            mock_read.return_value = "file content here"
            result = await _build_sub_agent_context(
                "Analyze these files", ["notes/data.md"], "thread-1", "user-1"
            )
            assert "Analyze these files" in result
            assert "notes/data.md" in result
            assert "file content here" in result
            mock_read.assert_called_once_with("thread-1", "notes/data.md", "user-1")

    @pytest.mark.asyncio
    async def test_missing_context_file_handled_gracefully(self):
        from app.services.deep_agent_service import _build_sub_agent_context

        with patch("app.services.workspace_service.read_file", new_callable=AsyncMock) as mock_read:
            mock_read.side_effect = FileNotFoundError("not found")
            result = await _build_sub_agent_context(
                "Analyze these files", ["missing.md"], "thread-1", "user-1"
            )
            assert "Analyze these files" in result
            assert "missing.md" in result
            assert "File not found" in result


class TestRunTaskAgent:
    """Test the main run_task_agent generator."""

    @pytest.mark.asyncio
    async def test_yields_sub_agent_start_event(self):
        from app.services.deep_agent_service import run_task_agent

        # Mock the LLM to return a simple "stop" response
        mock_chunk = MagicMock()
        mock_chunk.choices = [MagicMock()]
        mock_chunk.choices[0].delta.content = "Done!"
        mock_chunk.choices[0].delta.tool_calls = None
        mock_chunk.choices[0].finish_reason = "stop"
        mock_chunk.usage = None

        mock_stream = AsyncMock()
        mock_stream.__aiter__ = MagicMock(return_value=iter([mock_chunk]))

        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_stream)

        with patch("app.services.deep_agent_service.get_sub_agent_llm_settings", return_value={
            "model": "test-model", "base_url": None, "api_key": "test-key",
        }), patch("app.services.deep_agent_service.get_traced_async_openai_client", return_value=mock_client), \
             patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"):

            events = []
            async for event in run_task_agent(
                description="test task",
                context_files=None,
                thread_id="thread-1",
                user_id="user-1",
                parent_tools=[],
            ):
                events.append(event)

            # Should have sub_agent_start, text_delta, sub_agent_complete
            types = [e["type"] for e in events]
            assert "sub_agent_start" in types
            assert "sub_agent_complete" in types
            assert events[0]["type"] == "sub_agent_start"
            assert events[0]["description"] == "test task"
            assert "sub_agent_id" in events[0]

    @pytest.mark.asyncio
    async def test_error_handling_returns_safe_message(self):
        from app.services.deep_agent_service import run_task_agent

        with patch("app.services.deep_agent_service.get_sub_agent_llm_settings", return_value={
            "model": "test-model", "base_url": None, "api_key": "test-key",
        }), patch("app.services.deep_agent_service.get_traced_async_openai_client") as mock_client_fn:
            mock_client = AsyncMock()
            mock_client.chat.completions.create = AsyncMock(
                side_effect=Exception("LLM connection failed")
            )
            mock_client_fn.return_value = mock_client

            with patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"):
                events = []
                async for event in run_task_agent(
                    description="test task",
                    context_files=None,
                    thread_id="thread-1",
                    user_id="user-1",
                    parent_tools=[],
                ):
                    events.append(event)

                types = [e["type"] for e in events]
                assert "error" in types
                assert "sub_agent_complete" in types

                # Error event should have the error message
                error_event = next(e for e in events if e["type"] == "error")
                assert "LLM connection failed" in error_event["error"]

                # Complete event should have the safe error message
                complete_event = next(e for e in events if e["type"] == "sub_agent_complete")
                assert "Sub-agent failed" in complete_event["result"]
                assert "retry" in complete_event["result"]


class TestLoopExhaustion:
    """Test iteration limit and forced summarization."""

    @pytest.mark.asyncio
    async def test_forced_summarization_on_loop_exhaustion(self):
        """When max_rounds is hit, sub-agent forces a summary and returns it."""
        from app.services.deep_agent_service import run_task_agent

        # Build a mock chunk that always returns a tool call
        def make_tool_call_chunk():
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = None
            chunk.choices[0].delta.tool_calls = [MagicMock()]
            chunk.choices[0].delta.tool_calls[0].index = 0
            chunk.choices[0].delta.tool_calls[0].id = "call_1"
            chunk.choices[0].delta.tool_calls[0].function.name = "search_documents"
            chunk.choices[0].delta.tool_calls[0].function.arguments = '{"query":"test"}'
            chunk.choices[0].finish_reason = None
            return chunk

        def make_tool_call_finish():
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = None
            chunk.choices[0].delta.tool_calls = None
            chunk.choices[0].finish_reason = "tool_calls"
            return chunk

        # Summary chunk for forced summarization
        def make_summary_chunk():
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = "Here is my summary."
            chunk.choices[0].delta.tool_calls = None
            chunk.choices[0].finish_reason = "stop"
            return chunk

        tool_stream = MockAsyncStream([make_tool_call_chunk(), make_tool_call_finish()])
        summary_stream = MockAsyncStream([make_summary_chunk()])

        mock_client = AsyncMock()
        # First call returns tool_calls, second call (forced summary) returns stop
        mock_client.chat.completions.create = AsyncMock(
            side_effect=[tool_stream, summary_stream]
        )

        with patch("app.services.deep_agent_service.get_sub_agent_llm_settings", return_value={
            "model": "test-model", "base_url": None, "api_key": "test-key",
        }), patch("app.services.deep_agent_service.get_traced_async_openai_client", return_value=mock_client), \
             patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"), \
             patch("app.services.deep_agent_service.get_settings") as mock_settings, \
             patch("app.services.tool_executor.execute_tool_call", new_callable=AsyncMock, return_value="search result"):
            mock_settings.return_value.max_sub_agent_rounds = 1  # Force exhaustion after 1 round

            events = []
            async for event in run_task_agent(
                description="test task",
                context_files=None,
                thread_id="thread-1",
                user_id="user-1",
                parent_tools=[{"function": {"name": "search_documents"}}],
            ):
                events.append(event)

            types = [e["type"] for e in events]
            assert "sub_agent_start" in types
            assert "sub_agent_complete" in types
            assert "text_delta" in types

            complete_event = next(e for e in events if e["type"] == "sub_agent_complete")
            assert "summary" in complete_event["result"].lower()


class TestUnexpectedFinishReason:
    """Test handling of unexpected finish reasons like 'length'."""

    @pytest.mark.asyncio
    async def test_finish_reason_length_stops_loop(self):
        """When LLM returns finish_reason='length', sub-agent stops gracefully."""
        from app.services.deep_agent_service import run_task_agent

        # Chunk that returns partial text with finish_reason="length"
        chunk = MagicMock()
        chunk.choices = [MagicMock()]
        chunk.choices[0].delta.content = "Partial response..."
        chunk.choices[0].delta.tool_calls = None
        chunk.choices[0].finish_reason = "length"

        mock_stream = MockAsyncStream([chunk])

        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_stream)

        with patch("app.services.deep_agent_service.get_sub_agent_llm_settings", return_value={
            "model": "test-model", "base_url": None, "api_key": "test-key",
        }), patch("app.services.deep_agent_service.get_traced_async_openai_client", return_value=mock_client), \
             patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"):

            events = []
            async for event in run_task_agent(
                description="test task",
                context_files=None,
                thread_id="thread-1",
                user_id="user-1",
                parent_tools=[],
            ):
                events.append(event)

            types = [e["type"] for e in events]
            assert "sub_agent_start" in types
            assert "text_delta" in types
            assert "sub_agent_complete" in types

            complete_event = next(e for e in events if e["type"] == "sub_agent_complete")
            assert "Partial response..." in complete_event["result"]

            # Verify LLM was only called once (no infinite loop)
            assert mock_client.chat.completions.create.call_count == 1


class TestNestedAsyncGenerator:
    """Test handling of nested async generators from sub-agent tool calls."""

    @pytest.mark.asyncio
    async def test_nested_generator_consumed_and_result_used(self):
        """When a tool returns an AsyncGenerator, its result is extracted correctly."""
        from app.services.deep_agent_service import run_task_agent

        # First chunk: tool call
        tc_chunk = MagicMock()
        tc_chunk.choices = [MagicMock()]
        tc_chunk.choices[0].delta.content = None
        tc_chunk.choices[0].delta.tool_calls = [MagicMock()]
        tc_chunk.choices[0].delta.tool_calls[0].index = 0
        tc_chunk.choices[0].delta.tool_calls[0].id = "call_nested"
        tc_chunk.choices[0].delta.tool_calls[0].function.name = "analyze_document"
        tc_chunk.choices[0].delta.tool_calls[0].function.arguments = '{"document_id":"doc1","query":"summarize"}'
        tc_chunk.choices[0].finish_reason = None

        tc_finish = MagicMock()
        tc_finish.choices = [MagicMock()]
        tc_finish.choices[0].delta.content = None
        tc_finish.choices[0].delta.tool_calls = None
        tc_finish.choices[0].finish_reason = "tool_calls"

        # Second chunk: stop with final text
        stop_chunk = MagicMock()
        stop_chunk.choices = [MagicMock()]
        stop_chunk.choices[0].delta.content = "Analysis complete."
        stop_chunk.choices[0].delta.tool_calls = None
        stop_chunk.choices[0].finish_reason = "stop"

        stream1 = MockAsyncStream([tc_chunk, tc_finish])
        stream2 = MockAsyncStream([stop_chunk])

        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=[stream1, stream2])

        # Mock execute_tool_call to return an async generator
        async def mock_nested_generator(*args, **kwargs):
            yield {"type": "sub_agent_reasoning", "content": "thinking..."}
            yield {"type": "sub_agent_complete", "result": "Document summary here"}

        with patch("app.services.deep_agent_service.get_sub_agent_llm_settings", return_value={
            "model": "test-model", "base_url": None, "api_key": "test-key",
        }), patch("app.services.deep_agent_service.get_traced_async_openai_client", return_value=mock_client), \
             patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"), \
             patch("app.services.tool_executor.execute_tool_call", side_effect=mock_nested_generator):

            events = []
            async for event in run_task_agent(
                description="analyze doc",
                context_files=None,
                thread_id="thread-1",
                user_id="user-1",
                parent_tools=[{"function": {"name": "analyze_document"}}],
            ):
                events.append(event)

            # Verify the tool_call_complete event has the nested result
            tc_complete = [e for e in events if e["type"] == "tool_call_complete"]
            assert len(tc_complete) == 1
            assert "Document summary here" in tc_complete[0]["result"]

            # Verify final completion
            complete_event = next(e for e in events if e["type"] == "sub_agent_complete")
            assert "Analysis complete." in complete_event["result"]


class TestToolFilteringExactness:
    """Verify exactly which tools are excluded."""

    def test_excluded_tools_set(self):
        from app.services.deep_agent_service import _EXCLUDED_TOOLS

        assert _EXCLUDED_TOOLS == frozenset((
            "analyze_document",
            "explore_knowledge_base",
            "task",
            "write_todos",
            "read_todos",
            "ask_user",
        ))


class TestResultKeyConsistency:
    """Verify sub_agent_complete events use 'result' key (not 'result_summary')."""

    @pytest.mark.asyncio
    async def test_success_path_uses_result_key(self):
        from app.services.deep_agent_service import run_task_agent

        mock_chunk = MagicMock()
        mock_chunk.choices = [MagicMock()]
        mock_chunk.choices[0].delta.content = "Task done!"
        mock_chunk.choices[0].delta.tool_calls = None
        mock_chunk.choices[0].finish_reason = "stop"
        mock_chunk.usage = None

        mock_stream = MockAsyncStream([mock_chunk])

        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_stream)

        with patch("app.services.deep_agent_service.get_sub_agent_llm_settings", return_value={
            "model": "test-model", "base_url": None, "api_key": "test-key",
        }), patch("app.services.deep_agent_service.get_traced_async_openai_client", return_value=mock_client), \
             patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"):

            events = []
            async for event in run_task_agent(
                description="test task",
                context_files=None,
                thread_id="thread-1",
                user_id="user-1",
                parent_tools=[],
            ):
                events.append(event)

            complete_event = next(e for e in events if e["type"] == "sub_agent_complete")
            assert "result" in complete_event
            assert "result_summary" not in complete_event
            assert complete_event["result"] == "Task done!"

    @pytest.mark.asyncio
    async def test_error_path_uses_result_key(self):
        from app.services.deep_agent_service import run_task_agent

        with patch("app.services.deep_agent_service.get_sub_agent_llm_settings", return_value={
            "model": "test-model", "base_url": None, "api_key": "test-key",
        }), patch("app.services.deep_agent_service.get_traced_async_openai_client") as mock_client_fn:
            mock_client = AsyncMock()
            mock_client.chat.completions.create = AsyncMock(
                side_effect=Exception("LLM error")
            )
            mock_client_fn.return_value = mock_client

            with patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"):
                events = []
                async for event in run_task_agent(
                    description="test task",
                    context_files=None,
                    thread_id="thread-1",
                    user_id="user-1",
                    parent_tools=[],
                ):
                    events.append(event)

                complete_event = next(e for e in events if e["type"] == "sub_agent_complete")
                assert "result" in complete_event
                assert "result_summary" not in complete_event


class TestSetupErrorHandling:
    """Test that exceptions during context building (before first yield) are caught."""

    @pytest.mark.asyncio
    async def test_context_building_exception_yields_structured_error(self):
        from app.services.deep_agent_service import run_task_agent

        with patch("app.services.deep_agent_service._build_sub_agent_context", new_callable=AsyncMock) as mock_ctx:
            mock_ctx.side_effect = RuntimeError("workspace connection failed")

            with patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"):
                events = []
                async for event in run_task_agent(
                    description="test task",
                    context_files=["bad/file.md"],
                    thread_id="thread-1",
                    user_id="user-1",
                    parent_tools=[],
                ):
                    events.append(event)

                types = [e["type"] for e in events]
                # Should still yield sub_agent_start, error, and sub_agent_complete
                assert "sub_agent_start" in types
                assert "error" in types
                assert "sub_agent_complete" in types

                error_event = next(e for e in events if e["type"] == "error")
                assert "workspace connection failed" in error_event["error"]

                complete_event = next(e for e in events if e["type"] == "sub_agent_complete")
                assert "result" in complete_event
                assert "Sub-agent failed during setup" in complete_event["result"]

    @pytest.mark.asyncio
    async def test_system_prompt_exception_yields_structured_error(self):
        from app.services.deep_agent_service import run_task_agent

        with patch("app.services.deep_agent_service.get_system_prompt", side_effect=ValueError("bad config")):
            events = []
            async for event in run_task_agent(
                description="test task",
                context_files=None,
                thread_id="thread-1",
                user_id="user-1",
                parent_tools=[],
            ):
                events.append(event)

            types = [e["type"] for e in events]
            assert "error" in types
            assert "sub_agent_complete" in types

            complete_event = next(e for e in events if e["type"] == "sub_agent_complete")
            assert "bad config" in complete_event["result"]


class TestEventContractShape:
    """Contract tests: verify SSE events have the fields the frontend depends on."""

    @pytest.mark.asyncio
    async def test_sub_agent_start_contains_sub_agent_id_and_description(self):
        """AC #1: sub_agent_start must contain sub_agent_id and description."""
        from app.services.deep_agent_service import run_task_agent

        mock_chunk = MagicMock()
        mock_chunk.choices = [MagicMock()]
        mock_chunk.choices[0].delta.content = "Done"
        mock_chunk.choices[0].delta.tool_calls = None
        mock_chunk.choices[0].finish_reason = "stop"
        mock_chunk.usage = None

        mock_stream = MockAsyncStream([mock_chunk])
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_stream)

        with patch("app.services.deep_agent_service.get_sub_agent_llm_settings", return_value={
            "model": "test-model", "base_url": None, "api_key": "test-key",
        }), patch("app.services.deep_agent_service.get_traced_async_openai_client", return_value=mock_client), \
             patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"):

            events = []
            async for event in run_task_agent(
                description="search for documents about AI",
                context_files=None,
                thread_id="thread-1",
                user_id="user-1",
                parent_tools=[],
            ):
                events.append(event)

            start_event = next(e for e in events if e["type"] == "sub_agent_start")
            assert "sub_agent_id" in start_event, "sub_agent_start must have sub_agent_id"
            assert isinstance(start_event["sub_agent_id"], str)
            assert len(start_event["sub_agent_id"]) > 0
            assert "description" in start_event, "sub_agent_start must have description"
            assert start_event["description"] == "search for documents about AI"

    @pytest.mark.asyncio
    async def test_progress_events_include_sub_agent_id(self):
        """AC #2: text_delta events during sub-agent execution include sub_agent_id."""
        from app.services.deep_agent_service import run_task_agent

        mock_chunk = MagicMock()
        mock_chunk.choices = [MagicMock()]
        mock_chunk.choices[0].delta.content = "Working on it..."
        mock_chunk.choices[0].delta.tool_calls = None
        mock_chunk.choices[0].finish_reason = "stop"
        mock_chunk.usage = None

        mock_stream = MockAsyncStream([mock_chunk])
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_stream)

        with patch("app.services.deep_agent_service.get_sub_agent_llm_settings", return_value={
            "model": "test-model", "base_url": None, "api_key": "test-key",
        }), patch("app.services.deep_agent_service.get_traced_async_openai_client", return_value=mock_client), \
             patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"):

            events = []
            async for event in run_task_agent(
                description="test task",
                context_files=None,
                thread_id="thread-1",
                user_id="user-1",
                parent_tools=[],
            ):
                events.append(event)

            text_deltas = [e for e in events if e["type"] == "text_delta"]
            assert len(text_deltas) > 0, "Should have at least one text_delta event"
            for td in text_deltas:
                assert "sub_agent_id" in td, "text_delta must have sub_agent_id"

    @pytest.mark.asyncio
    async def test_sub_agent_complete_contains_sub_agent_id_and_result(self):
        """AC #3: sub_agent_complete must contain sub_agent_id and result."""
        from app.services.deep_agent_service import run_task_agent

        mock_chunk = MagicMock()
        mock_chunk.choices = [MagicMock()]
        mock_chunk.choices[0].delta.content = "Final answer"
        mock_chunk.choices[0].delta.tool_calls = None
        mock_chunk.choices[0].finish_reason = "stop"
        mock_chunk.usage = None

        mock_stream = MockAsyncStream([mock_chunk])
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_stream)

        with patch("app.services.deep_agent_service.get_sub_agent_llm_settings", return_value={
            "model": "test-model", "base_url": None, "api_key": "test-key",
        }), patch("app.services.deep_agent_service.get_traced_async_openai_client", return_value=mock_client), \
             patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"):

            events = []
            async for event in run_task_agent(
                description="test task",
                context_files=None,
                thread_id="thread-1",
                user_id="user-1",
                parent_tools=[],
            ):
                events.append(event)

            complete_event = next(e for e in events if e["type"] == "sub_agent_complete")
            assert "sub_agent_id" in complete_event, "sub_agent_complete must have sub_agent_id"
            assert "result" in complete_event, "sub_agent_complete must have result"
            assert isinstance(complete_event["result"], str)

    @pytest.mark.asyncio
    async def test_sub_agent_id_consistent_across_all_events(self):
        """All events from a single task sub-agent use the same sub_agent_id."""
        from app.services.deep_agent_service import run_task_agent

        mock_chunk = MagicMock()
        mock_chunk.choices = [MagicMock()]
        mock_chunk.choices[0].delta.content = "Result text"
        mock_chunk.choices[0].delta.tool_calls = None
        mock_chunk.choices[0].finish_reason = "stop"
        mock_chunk.usage = None

        mock_stream = MockAsyncStream([mock_chunk])
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_stream)

        with patch("app.services.deep_agent_service.get_sub_agent_llm_settings", return_value={
            "model": "test-model", "base_url": None, "api_key": "test-key",
        }), patch("app.services.deep_agent_service.get_traced_async_openai_client", return_value=mock_client), \
             patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"):

            events = []
            async for event in run_task_agent(
                description="test task",
                context_files=None,
                thread_id="thread-1",
                user_id="user-1",
                parent_tools=[],
            ):
                events.append(event)

            events_with_id = [e for e in events if "sub_agent_id" in e]
            assert len(events_with_id) >= 2  # At least start + complete
            ids = set(e["sub_agent_id"] for e in events_with_id)
            assert len(ids) == 1, f"All events should share the same sub_agent_id, got: {ids}"


class TestReduceDeepAgentEvents:
    """Test _reduce_deep_agent_events uses correct key."""

    def test_extracts_result_from_complete_event(self):
        from app.services.deep_agent_service import _reduce_deep_agent_events

        events = [
            {"type": "sub_agent_start", "sub_agent_id": "abc"},
            {"type": "text_delta", "content": "hello"},
            {"type": "sub_agent_complete", "sub_agent_id": "abc", "result": "final answer"},
        ]
        reduced = _reduce_deep_agent_events(events)
        assert reduced == {"result": "final answer"}

    def test_does_not_use_result_summary_key(self):
        from app.services.deep_agent_service import _reduce_deep_agent_events

        events = [
            {"type": "sub_agent_complete", "sub_agent_id": "abc", "result_summary": "old key value"},
        ]
        # result_summary is not read anymore - result key is empty
        reduced = _reduce_deep_agent_events(events)
        assert reduced == {"result": ""}


class TestRunTaskAgentRedaction:
    """run_task_agent must anonymize its input and de-anonymize its output when a
    redaction service is active (Ep3 PII leak fix). Mirrors run_sub_agent behaviour."""

    @pytest.mark.asyncio
    async def test_anonymizes_input_and_deanonymizes_output(self):
        from app.services.deep_agent_service import run_task_agent

        # LLM produces a response containing the SURROGATE (it ran in surrogate space).
        mock_chunk = MagicMock()
        mock_chunk.choices = [MagicMock()]
        mock_chunk.choices[0].delta.content = "Summary about SURROGATE_NAME."
        mock_chunk.choices[0].delta.tool_calls = None
        mock_chunk.choices[0].finish_reason = "stop"
        mock_chunk.usage = None

        mock_stream = MockAsyncStream([mock_chunk])
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_stream)

        # Real-space context the sub-agent is given (tool_executor already de-anonymized
        # the task args, and context files hold real values).
        real_context = "Investigate the matter for Alice Smith."

        redaction_svc = MagicMock()
        redaction_svc.anonymize = AsyncMock(return_value="Investigate the matter for SURROGATE_NAME.")
        redaction_svc.deanonymize_llm_response = AsyncMock(return_value="Summary about Alice Smith.")

        with patch("app.services.deep_agent_service.get_sub_agent_llm_settings", return_value={
            "model": "test-model", "base_url": None, "api_key": "test-key",
        }), patch("app.services.deep_agent_service.get_traced_async_openai_client", return_value=mock_client), \
             patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"), \
             patch("app.services.deep_agent_service._build_sub_agent_context", AsyncMock(return_value=real_context)):

            events = []
            async for event in run_task_agent(
                description="anything",
                context_files=None,
                thread_id="thread-1",
                user_id="user-1",
                parent_tools=[],
                redaction_svc=redaction_svc,
            ):
                events.append(event)

        # Input was anonymized before the LLM saw it (no real PII to the cloud).
        redaction_svc.anonymize.assert_awaited_once_with(real_context)
        # Output was de-anonymized before emission.
        redaction_svc.deanonymize_llm_response.assert_awaited_once_with("Summary about SURROGATE_NAME.")

        complete = next(e for e in events if e["type"] == "sub_agent_complete")
        # The user-facing result shows the REAL value, not the surrogate.
        assert complete["result"] == "Summary about Alice Smith."
        assert "SURROGATE_NAME" not in complete["result"]

    @pytest.mark.asyncio
    async def test_no_redaction_service_is_passthrough(self):
        from app.services.deep_agent_service import run_task_agent

        mock_chunk = MagicMock()
        mock_chunk.choices = [MagicMock()]
        mock_chunk.choices[0].delta.content = "Plain result."
        mock_chunk.choices[0].delta.tool_calls = None
        mock_chunk.choices[0].finish_reason = "stop"
        mock_chunk.usage = None

        mock_stream = MockAsyncStream([mock_chunk])
        mock_client = AsyncMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_stream)

        with patch("app.services.deep_agent_service.get_sub_agent_llm_settings", return_value={
            "model": "test-model", "base_url": None, "api_key": "test-key",
        }), patch("app.services.deep_agent_service.get_traced_async_openai_client", return_value=mock_client), \
             patch("app.services.deep_agent_service.get_system_prompt", return_value="system prompt"), \
             patch("app.services.deep_agent_service._build_sub_agent_context", AsyncMock(return_value="ctx")):

            events = []
            async for event in run_task_agent(
                description="anything",
                context_files=None,
                thread_id="thread-1",
                user_id="user-1",
                parent_tools=[],
                redaction_svc=None,
            ):
                events.append(event)

        complete = next(e for e in events if e["type"] == "sub_agent_complete")
        assert complete["result"] == "Plain result."
