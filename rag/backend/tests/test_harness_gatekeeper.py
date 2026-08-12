"""Tests for harness gatekeeper, post-harness summary, and phase context block."""
import json
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from app.services.harness_engine import (
    HarnessDefinition,
    HarnessPrerequisites,
    PhaseDefinition,
    PhaseType,
)
from app.routers.chat import _build_phase_context_block


# ---------------------------------------------------------------------------
# Unit tests — HarnessPrerequisites dataclass
# ---------------------------------------------------------------------------

class TestHarnessPrerequisites:
    def test_defaults(self):
        p = HarnessPrerequisites()
        assert p.requires_upload is False
        assert p.upload_description == ""
        assert p.harness_intro == ""

    def test_custom_values(self):
        p = HarnessPrerequisites(
            requires_upload=True,
            upload_description="a PDF",
            harness_intro="Hello",
        )
        assert p.requires_upload is True
        assert p.upload_description == "a PDF"
        assert p.harness_intro == "Hello"

    def test_harness_definition_with_prerequisites(self):
        prereqs = HarnessPrerequisites(requires_upload=True)
        hd = HarnessDefinition(
            harness_type="test",
            display_name="Test",
            phases=[],
            prerequisites=prereqs,
        )
        assert hd.prerequisites is not None
        assert hd.prerequisites.requires_upload is True

    def test_harness_definition_without_prerequisites(self):
        hd = HarnessDefinition(
            harness_type="test",
            display_name="Test",
            phases=[],
        )
        assert hd.prerequisites is None

    def test_contract_review_has_prerequisites(self):
        from app.services.harnesses.contract_review import CONTRACT_REVIEW_HARNESS
        assert CONTRACT_REVIEW_HARNESS.prerequisites is not None
        assert CONTRACT_REVIEW_HARNESS.prerequisites.requires_upload is True
        assert "contract" in CONTRACT_REVIEW_HARNESS.prerequisites.upload_description.lower()


# ---------------------------------------------------------------------------
# Unit tests — _build_phase_context_block
# ---------------------------------------------------------------------------

class TestBuildPhaseContextBlock:
    def test_small_results_included_fully(self):
        phase_results = {
            "0": {"full_text": "some text", "page_count": 1, "format": "text/plain"},
            "1": {"contract_type": "NDA", "parties": [{"name": "A", "role": "Discloser"}]},
        }
        # Register a mock harness for this test
        from app.services.harnesses import HARNESS_REGISTRY
        result = _build_phase_context_block(phase_results, "contract_review")
        assert "Phase 0" in result
        assert "Phase 1" in result
        assert "NDA" in result

    def test_large_results_truncated(self):
        """When total exceeds 30k chars, earlier phases should be truncated."""
        # Create large phase results
        large_text = "x" * 10000
        phase_results = {
            "0": {"data": large_text},
            "1": {"data": large_text},
            "2": {"data": large_text},
            "3": {"data": large_text},
        }
        result = _build_phase_context_block(phase_results, "contract_review")
        # Last 2 phases should have full data
        assert "Phase 3" in result
        assert "Phase 2" in result
        # Earlier phases should be truncated
        assert "(truncated)" in result

    def test_unknown_harness_mode_graceful(self):
        """Should not crash if harness mode is unrecognized."""
        phase_results = {"0": {"key": "value"}}
        result = _build_phase_context_block(phase_results, "nonexistent_harness")
        assert "Phase 0" in result
        assert "value" in result

    def test_empty_results(self):
        result = _build_phase_context_block({}, "contract_review")
        assert result == ""

    def test_phases_ordered_by_index(self):
        phase_results = {
            "2": {"step": "two"},
            "0": {"step": "zero"},
            "1": {"step": "one"},
        }
        result = _build_phase_context_block(phase_results, "contract_review")
        idx_0 = result.index("Phase 0")
        idx_1 = result.index("Phase 1")
        idx_2 = result.index("Phase 2")
        assert idx_0 < idx_1 < idx_2


# ---------------------------------------------------------------------------
# Unit tests — Sentinel detection
# ---------------------------------------------------------------------------

class TestSentinelDetection:
    """Test the sentinel stripping logic used in the gatekeeper."""

    def test_sentinel_at_end(self):
        from app.routers.chat import _GATEKEEPER_SENTINEL
        text = f"I see you've uploaded your contract. Let's begin! {_GATEKEEPER_SENTINEL}"
        assert text.rstrip().endswith(_GATEKEEPER_SENTINEL)
        clean = text.rstrip()[:-len(_GATEKEEPER_SENTINEL)].rstrip()
        assert _GATEKEEPER_SENTINEL not in clean
        assert "Let's begin!" in clean

    def test_no_sentinel(self):
        from app.routers.chat import _GATEKEEPER_SENTINEL
        text = "Please upload a contract document to get started."
        assert not text.rstrip().endswith(_GATEKEEPER_SENTINEL)

    def test_sentinel_with_trailing_whitespace(self):
        from app.routers.chat import _GATEKEEPER_SENTINEL
        text = f"Ready to go! {_GATEKEEPER_SENTINEL}  \n"
        assert text.rstrip().endswith(_GATEKEEPER_SENTINEL)


@pytest.mark.asyncio
class TestGatekeeperBuffering:
    """Test sentinel buffering with chunked text_delta events."""

    async def test_sentinel_stripped_from_chunked_stream(self):
        """Sentinel arriving across multiple chunks should be detected and stripped."""
        from app.routers.chat import _run_gatekeeper, _GATEKEEPER_SENTINEL, _SENTINEL_BUFFER_SIZE

        # Simulate LLM streaming: text arrives in small chunks, sentinel at the end
        full_response = f"Your contract is uploaded. Starting analysis now! {_GATEKEEPER_SENTINEL}"
        # Split into small chunks to simulate streaming
        chunk_size = 5
        chunks = [full_response[i:i+chunk_size] for i in range(0, len(full_response), chunk_size)]

        async def mock_astream(*args, **kwargs):
            for chunk in chunks:
                yield {"type": "text_delta", "content": chunk}
            yield {"type": "response_complete", "full_response": full_response}

        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value = MagicMock(data=[
            {"file_path": "contract.pdf", "content_type": "application/pdf", "size_bytes": 1000}
        ])

        harness_def = MagicMock()
        harness_def.display_name = "Test"
        harness_def.prerequisites = MagicMock()
        harness_def.prerequisites.harness_intro = "Test intro"
        harness_def.prerequisites.upload_description = "a document"

        gatekeeper_result = {}

        with patch("app.services.llm_service.astream_chat_response", side_effect=mock_astream):
            collected_text = ""
            async for sse_line in _run_gatekeeper(
                "t1", "u1", harness_def, [], mock_supabase, gatekeeper_result
            ):
                # Parse emitted text
                if sse_line.startswith("data: "):
                    evt = json.loads(sse_line[6:].strip())
                    if evt.get("type") == "text_delta":
                        collected_text += evt["content"]

            # Sentinel should be stripped
            assert _GATEKEEPER_SENTINEL not in collected_text
            assert "Starting analysis now!" in collected_text
            assert gatekeeper_result["trigger"] is True
            assert _GATEKEEPER_SENTINEL not in gatekeeper_result["message"]

    async def test_no_sentinel_flushes_buffer(self):
        """When no sentinel present, all text should be emitted."""
        from app.routers.chat import _run_gatekeeper, _GATEKEEPER_SENTINEL

        full_response = "Please upload your contract document to begin."

        async def mock_astream(*args, **kwargs):
            yield {"type": "text_delta", "content": full_response}
            yield {"type": "response_complete", "full_response": full_response}

        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value = MagicMock(data=[])

        harness_def = MagicMock()
        harness_def.display_name = "Test"
        harness_def.prerequisites = MagicMock()
        harness_def.prerequisites.harness_intro = "Test"
        harness_def.prerequisites.upload_description = "a doc"

        gatekeeper_result = {}

        with patch("app.services.llm_service.astream_chat_response", side_effect=mock_astream):
            collected_text = ""
            async for sse_line in _run_gatekeeper(
                "t1", "u1", harness_def, [], mock_supabase, gatekeeper_result
            ):
                if sse_line.startswith("data: "):
                    evt = json.loads(sse_line[6:].strip())
                    if evt.get("type") == "text_delta":
                        collected_text += evt["content"]

            assert collected_text == full_response
            assert gatekeeper_result["trigger"] is False
            assert gatekeeper_result["message"] == full_response


# ---------------------------------------------------------------------------
# Integration-style tests (mocked LLM, real routing logic)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
class TestGatekeeperRouting:
    """Test the state-based routing in _run_harness_flow."""

    async def test_completed_run_emits_followup(self):
        """When a completed run exists, should emit harness_followup event."""
        mock_supabase = MagicMock()
        completed_run = {
            "id": "run-1",
            "status": "completed",
            "phase_results": {"0": {"full_text": "test"}, "5": {"overall_risk": "GREEN"}},
        }

        with patch("app.services.harness_engine.get_harness_run_any", new_callable=AsyncMock, return_value=completed_run):
            from app.routers.chat import _run_harness_flow

            events = []
            async for line in _run_harness_flow(
                thread_id="t1", user_id="u1", harness_mode="contract_review",
                messages=[], supabase=mock_supabase,
            ):
                events.append(line)

            # Should have the followup event + done
            assert len(events) == 2
            followup_line = events[0]
            assert "harness_followup" in followup_line
            parsed = json.loads(followup_line.split("data: ")[1].strip())
            assert parsed["type"] == "harness_followup"
            assert "phase_results" in parsed

    async def test_no_prerequisites_skips_gatekeeper(self):
        """Harness without prerequisites should create run immediately."""
        from app.services.harnesses import HARNESS_REGISTRY

        test_harness = HarnessDefinition(
            harness_type="test_no_prereq",
            display_name="Test No Prereq",
            phases=[
                PhaseDefinition(
                    name="Test Phase",
                    description="test",
                    phase_type=PhaseType.programmatic,
                    system_prompt_template="",
                    executor=AsyncMock(return_value={"result": "ok"}),
                ),
            ],
            prerequisites=None,  # No gatekeeper
        )
        HARNESS_REGISTRY["test_no_prereq"] = test_harness

        mock_supabase = MagicMock()
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value = MagicMock(data=[])

        mock_run = {
            "id": "run-new",
            "harness_type": "test_no_prereq",
            "status": "running",
            "current_phase": 0,
            "phase_results": {},
        }

        with patch("app.services.harness_engine.get_harness_run_any", new_callable=AsyncMock, return_value=None), \
             patch("app.services.harness_engine.create_harness_run", new_callable=AsyncMock, return_value=mock_run), \
             patch("app.services.todo_service.write_todos", new_callable=AsyncMock), \
             patch("app.services.harness_engine.HarnessEngine.run") as mock_engine_run:

            async def fake_engine_run(start_phase=0):
                yield {"type": "harness_complete", "harness_type": "test_no_prereq", "overall_result": "done"}
            mock_engine_run.side_effect = fake_engine_run

            from app.routers.chat import _run_harness_flow

            events = []
            async for line in _run_harness_flow(
                thread_id="t1", user_id="u1", harness_mode="test_no_prereq",
                messages=[], supabase=mock_supabase,
            ):
                events.append(line)

            # Should have created run (no gatekeeper), and engine ran
            assert any("harness_complete" in e for e in events)

        # Cleanup
        del HARNESS_REGISTRY["test_no_prereq"]
