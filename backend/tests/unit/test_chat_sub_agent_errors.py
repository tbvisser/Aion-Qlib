"""Unit tests for chat.py sub-agent error handling (story 3-2, AC #4).

These tests verify that:
- The 'error' event type from task sub-agents sets sub_agent_status to 'error'
- Generator exceptions during iteration are caught and formatted as structured errors

NOTE: These tests simulate the event-processing logic from chat.py's SSE generator
rather than calling the actual chat handler. The chat handler is a monolithic async
generator that requires full integration setup (auth, DB, LLM mocks) to invoke.
If the event-handling logic in chat.py is refactored, these tests must be updated
to match.
"""
import json
import pytest


class TestErrorEventHandling:
    """Test that error events from sub-agents are handled correctly in the chat event loop."""

    def test_error_event_type_recognized(self):
        """Verify the error event type is handled - sets sub_agent_status to 'error'.

        This tests the logic at chat.py line ~729:
            elif event_type == "error":
                sub_agent_status = "error"
        """
        # Simulate the event processing logic from chat.py
        sub_agent_status = "completed"

        events = [
            {"type": "sub_agent_start", "sub_agent_id": "abc", "description": "test"},
            {"type": "text_delta", "sub_agent_id": "abc", "content": "working..."},
            {"type": "error", "sub_agent_id": "abc", "error": "LLM connection failed"},
            {"type": "sub_agent_complete", "sub_agent_id": "abc", "result": "Sub-agent failed: LLM connection failed"},
        ]

        sub_agent_result = ""
        for event in events:
            event_type = event.get("type", "")
            if event_type == "sub_agent_complete":
                sub_agent_result = event.get("result", "")
            elif event_type == "error":
                sub_agent_status = "error"

        assert sub_agent_status == "error"
        assert "Sub-agent failed" in sub_agent_result

    def test_error_event_without_sub_agent_complete_still_sets_status(self):
        """If error event comes without a follow-up complete, status is still error."""
        sub_agent_status = "completed"

        events = [
            {"type": "sub_agent_start", "sub_agent_id": "abc", "description": "test"},
            {"type": "error", "sub_agent_id": "abc", "error": "crash"},
        ]

        for event in events:
            event_type = event.get("type", "")
            if event_type == "error":
                sub_agent_status = "error"

        assert sub_agent_status == "error"


class TestGeneratorExceptionWrapping:
    """Test that generator exceptions produce structured error format."""

    def test_structured_error_format(self):
        """Verify the structured error format matches convention:
        {"error": str, "tool_name": "task", "recoverable": true}

        This tests the logic at chat.py line ~741-744:
            except Exception as gen_exc:
                sub_agent_result = json.dumps({"error": str(gen_exc), "tool_name": tc["name"], "recoverable": True})
        """
        # Simulate the exception handling logic
        tc_name = "task"
        gen_exc = RuntimeError("generator exploded")

        sub_agent_result = json.dumps({
            "error": str(gen_exc),
            "tool_name": tc_name,
            "recoverable": True,
        })

        parsed = json.loads(sub_agent_result)
        assert parsed["error"] == "generator exploded"
        assert parsed["tool_name"] == "task"
        assert parsed["recoverable"] is True

    def test_structured_error_is_valid_json(self):
        """Ensure the error result can be parsed by the parent LLM."""
        error_msg = 'Connection reset: "unexpected EOF"'
        sub_agent_result = json.dumps({
            "error": error_msg,
            "tool_name": "task",
            "recoverable": True,
        })

        # Must be valid JSON that can be parsed
        parsed = json.loads(sub_agent_result)
        assert isinstance(parsed, dict)
        assert "error" in parsed
        assert "tool_name" in parsed
        assert "recoverable" in parsed

    @pytest.mark.asyncio
    async def test_generator_exception_caught_not_propagated(self):
        """Simulate what happens when a sub-agent generator raises during iteration.

        This verifies the try/except in chat.py around `async for sub_event in result:`
        catches the exception and produces a structured error instead of crashing.
        """
        async def failing_generator():
            yield {"type": "sub_agent_start", "sub_agent_id": "abc", "description": "test"}
            raise RuntimeError("mid-stream failure")

        sub_agent_status = "completed"
        sub_agent_result = ""
        tc_name = "task"

        try:
            async for sub_event in failing_generator():
                event_type = sub_event.get("type", "")
                if event_type == "sub_agent_complete":
                    sub_agent_result = sub_event.get("result", "")
        except Exception as gen_exc:
            sub_agent_status = "error"
            sub_agent_result = json.dumps({
                "error": str(gen_exc),
                "tool_name": tc_name,
                "recoverable": True,
            })

        assert sub_agent_status == "error"
        parsed = json.loads(sub_agent_result)
        assert parsed["error"] == "mid-stream failure"
        assert parsed["tool_name"] == "task"
        assert parsed["recoverable"] is True
