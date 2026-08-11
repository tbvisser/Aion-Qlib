"""Tests for harness engine — unit and integration."""
import json
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from pydantic import BaseModel

from app.services.harness_engine import (
    HarnessEngine,
    HarnessDefinition,
    PhaseDefinition,
    PhaseType,
    create_harness_run,
    get_harness_run,
    update_harness_phase,
    complete_harness_run,
    fail_harness_run,
    pause_harness_run,
)
from app.services.harnesses import get_harness, list_harnesses, HARNESS_REGISTRY
from app.services.harnesses.contract_review import (
    ContractText,
    ContractClassification,
    ClauseExtraction,
    RiskAnalysis,
    RedlineReport,
    ExecutiveSummary,
    Party,
    Clause,
    ClauseAssessment,
    Redline,
)


# ---------------------------------------------------------------------------
# Unit tests — Phase definitions
# ---------------------------------------------------------------------------

class TestPhaseDefinitions:
    def test_contract_review_harness_registered(self):
        assert "contract_review" in HARNESS_REGISTRY
        harness = get_harness("contract_review")
        assert harness.display_name == "Contract Review"
        assert len(harness.phases) == 8

    def test_list_harnesses(self):
        result = list_harnesses()
        assert len(result) >= 1
        cr = next(h for h in result if h["harness_type"] == "contract_review")
        assert cr["phase_count"] == 8

    def test_unknown_harness_raises(self):
        with pytest.raises(ValueError, match="Unknown harness type"):
            get_harness("nonexistent")

    def test_phase_types(self):
        harness = get_harness("contract_review")
        assert harness.phases[0].phase_type == PhaseType.programmatic  # Document Intake
        assert harness.phases[1].phase_type == PhaseType.llm_single  # Classification
        assert harness.phases[2].phase_type == PhaseType.llm_human_input  # Gather Context
        assert harness.phases[3].phase_type == PhaseType.llm_agent  # Load Playbook
        assert harness.phases[4].phase_type == PhaseType.programmatic  # Clause Extraction
        assert harness.phases[5].phase_type == PhaseType.llm_batch_agents  # Risk Analysis
        assert harness.phases[6].phase_type == PhaseType.llm_batch_agents  # Redline Generation
        assert harness.phases[7].phase_type == PhaseType.llm_single  # Executive Summary

    def test_workspace_io_configured(self):
        harness = get_harness("contract_review")
        # Phase 0 writes contract-text.md
        assert harness.phases[0].workspace_output == "contract-text.md"
        # Phase 1 reads contract-text.md
        assert "contract-text.md" in harness.phases[1].workspace_inputs
        # Phase 5 reads clauses, playbook, review context
        assert harness.phases[5].batch_items_file == "clauses.md"
        assert "playbook-context.md" in harness.phases[5].workspace_inputs

    def test_new_phase_type_enum_values(self):
        assert PhaseType.llm_batch_agents.value == "llm_batch_agents"
        assert PhaseType.llm_human_input.value == "llm_human_input"

    def test_phase_definition_batch_fields(self):
        harness = get_harness("contract_review")
        risk_phase = harness.phases[5]  # Risk Analysis
        assert risk_phase.batch_size == 5
        assert risk_phase.batch_items_file == "clauses.md"
        assert risk_phase.workspace_output == "risk-analysis.md"

    def test_redline_phase_has_filter(self):
        harness = get_harness("contract_review")
        redline_phase = harness.phases[6]
        assert redline_phase.batch_item_filter is not None
        # Should filter to YELLOW/RED only
        assert redline_phase.batch_item_filter({"risk_level": "RED"}) is True
        assert redline_phase.batch_item_filter({"risk_level": "GREEN"}) is False

    def test_phase_definition_post_execute_field(self):
        """PhaseDefinition accepts post_execute callable and defaults to None."""
        phase = PhaseDefinition(
            name="test", description="test", phase_type=PhaseType.llm_single,
            system_prompt_template="",
        )
        assert phase.post_execute is None

        async def dummy(**kwargs):
            yield {}

        phase_with = PhaseDefinition(
            name="test", description="test", phase_type=PhaseType.llm_single,
            system_prompt_template="", post_execute=dummy,
        )
        assert phase_with.post_execute is dummy

    def test_phase_7_has_post_execute(self):
        """Contract review Executive Summary phase has post_execute wired up."""
        harness = get_harness("contract_review")
        summary_phase = next(p for p in harness.phases if p.name == "Executive Summary")
        assert summary_phase.post_execute is not None

    def test_docx_script_syntax_valid(self):
        """docx_report_script.py compiles without syntax errors."""
        from pathlib import Path
        script_path = Path(__file__).parent.parent / "app" / "services" / "harnesses" / "docx_report_script.py"
        script_text = script_path.read_text(encoding="utf-8")
        compile(script_text, "docx_report_script.py", "exec")


# ---------------------------------------------------------------------------
# Unit tests — Output schema validation
# ---------------------------------------------------------------------------

class TestOutputSchemas:
    def test_contract_text_valid(self):
        ct = ContractText(full_text="x" * 200, page_count=1, format="text/plain")
        assert ct.page_count == 1

    def test_classification_requires_two_parties(self):
        with pytest.raises(Exception):
            ContractClassification(
                contract_type="SaaS",
                parties=[Party(name="A", role="Provider")],
            )

    def test_classification_valid(self):
        cc = ContractClassification(
            contract_type="SaaS",
            parties=[Party(name="A", role="Provider"), Party(name="B", role="Customer")],
            governing_law="Delaware",
        )
        assert cc.contract_type == "SaaS"

    def test_clause_extraction_requires_three(self):
        with pytest.raises(Exception):
            ClauseExtraction(clauses=[
                Clause(category="IP", title="IP", text="text", section_ref="1"),
            ])

    def test_executive_summary_valid_risk(self):
        es = ExecutiveSummary(
            overall_risk="YELLOW",
            recommendation="Negotiate",
            key_findings=["Finding 1"],
            risk_breakdown={"GREEN": 3, "YELLOW": 2, "RED": 1},
            detailed_report="Report content",
        )
        assert es.overall_risk == "YELLOW"

    def test_executive_summary_invalid_risk(self):
        with pytest.raises(Exception):
            ExecutiveSummary(
                overall_risk="PURPLE",
                recommendation="x",
                key_findings=[],
                risk_breakdown={},
                detailed_report="x",
            )


# ---------------------------------------------------------------------------
# Unit tests — HarnessEngine phase transition
# ---------------------------------------------------------------------------

class TestHarnessEngineUnit:
    def test_engine_creation(self):
        harness_def = get_harness("contract_review")
        engine = HarnessEngine(
            harness_def=harness_def,
            run_id="test-run-id",
            thread_id="test-thread-id",
            user_id="test-user-id",
        )
        assert engine.harness_def.harness_type == "contract_review"
        assert len(engine.harness_def.phases) == 8

    def test_build_progress_md_with_summaries(self):
        harness_def = get_harness("contract_review")
        engine = HarnessEngine(
            harness_def=harness_def,
            run_id="test-run-id",
            thread_id="test-thread-id",
            user_id="test-user-id",
        )
        statuses = {0: "completed", 1: "completed", 2: "running"}
        phase_results = {
            "0": {"_summary": "Extracted 10,000 chars from PDF"},
            "1": {"_summary": "SaaS Agreement between Acme and Beta"},
        }
        md = engine._build_progress_md(statuses, phase_results=phase_results)
        assert "Extracted 10,000 chars from PDF" in md
        assert "SaaS Agreement between Acme and Beta" in md
        assert "2/8 completed" in md

    def test_build_progress_md_1_indexed_display(self):
        harness_def = get_harness("contract_review")
        engine = HarnessEngine(
            harness_def=harness_def,
            run_id="test-run-id",
            thread_id="test-thread-id",
            user_id="test-user-id",
        )
        statuses = {0: "completed"}
        md = engine._build_progress_md(statuses)
        # Phase display should be 1-indexed
        assert "| 1 | Document Intake" in md
        assert "| 2 | Contract Classification" in md

    def test_build_phase_prompt_workspace_vars(self):
        harness_def = get_harness("contract_review")
        engine = HarnessEngine(
            harness_def=harness_def,
            run_id="test-run-id",
            thread_id="test-thread-id",
            user_id="test-user-id",
        )
        phase = harness_def.phases[1]  # Classification
        workspace_ctx = {"contract-text.md": "This is contract text content"}
        prompt = engine._build_phase_prompt(phase, {}, "", workspace_ctx)
        assert "This is contract text content" in prompt

    @pytest.mark.asyncio
    async def test_post_execute_called_after_phase_completion(self):
        """post_execute hook is called and its events are yielded after phase completes."""
        post_execute_called = False

        async def mock_post_execute(run_id, thread_id, user_id, prior_results):
            nonlocal post_execute_called
            post_execute_called = True
            yield {"type": "text_delta", "content": "post_execute event"}

        phase = PhaseDefinition(
            name="Test Phase", description="test", phase_type=PhaseType.programmatic,
            system_prompt_template="",
            executor=AsyncMock(return_value={"result": "ok"}),
            post_execute=mock_post_execute,
        )
        harness_def = HarnessDefinition(
            harness_type="test", display_name="Test", phases=[phase],
        )
        engine = HarnessEngine(
            harness_def=harness_def, run_id="r1", thread_id="t1", user_id="u1",
        )

        events = []
        with patch.object(engine, "_get_prior_results", new_callable=AsyncMock, return_value={}), \
             patch("app.services.harness_engine.update_harness_phase", new_callable=AsyncMock), \
             patch("app.services.harness_engine.complete_harness_run", new_callable=AsyncMock), \
             patch.object(engine, "_write_progress", new_callable=AsyncMock, return_value=None):
            async for event in engine.run():
                events.append(event)

        assert post_execute_called
        post_events = [e for e in events if e.get("content") == "post_execute event"]
        assert len(post_events) == 1

    @pytest.mark.asyncio
    async def test_post_execute_failure_non_fatal(self):
        """post_execute failure does not prevent harness completion."""
        async def failing_post_execute(run_id, thread_id, user_id, prior_results):
            raise RuntimeError("DOCX generation exploded")
            yield  # make it an async generator

        phase = PhaseDefinition(
            name="Test Phase", description="test", phase_type=PhaseType.programmatic,
            system_prompt_template="",
            executor=AsyncMock(return_value={"result": "ok"}),
            post_execute=failing_post_execute,
        )
        harness_def = HarnessDefinition(
            harness_type="test", display_name="Test", phases=[phase],
        )
        engine = HarnessEngine(
            harness_def=harness_def, run_id="r1", thread_id="t1", user_id="u1",
        )

        events = []
        with patch.object(engine, "_get_prior_results", new_callable=AsyncMock, return_value={}), \
             patch("app.services.harness_engine.update_harness_phase", new_callable=AsyncMock), \
             patch("app.services.harness_engine.complete_harness_run", new_callable=AsyncMock), \
             patch.object(engine, "_write_progress", new_callable=AsyncMock, return_value=None):
            async for event in engine.run():
                events.append(event)

        # Harness should still complete despite post_execute failure
        complete_events = [e for e in events if e.get("type") == "harness_complete"]
        assert len(complete_events) == 1

    def test_build_batch_item_description(self):
        harness_def = get_harness("contract_review")
        engine = HarnessEngine(
            harness_def=harness_def,
            run_id="test-run-id",
            thread_id="test-thread-id",
            user_id="test-user-id",
        )
        phase = harness_def.phases[5]  # Risk Analysis
        item = {"category": "Liability", "title": "Liability Cap", "text": "The total liability...", "section_ref": "5.1"}
        workspace_ctx = {"playbook-context.md": "Playbook data here"}
        desc = engine._build_batch_item_description(phase, item, workspace_ctx)
        assert "Liability Cap" in desc
        assert "5.1" in desc
        assert "The total liability..." in desc


# ---------------------------------------------------------------------------
# Unit tests — Workspace service append_file
# ---------------------------------------------------------------------------

class TestAppendFile:
    @pytest.mark.asyncio
    async def test_append_creates_new_file(self):
        """append_file on nonexistent file should create it."""
        from app.services.workspace_service import append_file
        with patch("app.services.workspace_service.read_file", side_effect=FileNotFoundError("not found")), \
             patch("app.services.workspace_service.write_file", new_callable=AsyncMock) as mock_write, \
             patch("app.services.workspace_service.verify_thread_ownership", return_value=True):
            mock_write.return_value = {"id": "test", "file_path": "test.md"}
            result = await append_file("thread-1", "test.md", "new content", "user-1")
            mock_write.assert_called_once_with("thread-1", "test.md", "new content", "user-1")

    @pytest.mark.asyncio
    async def test_append_to_existing_file(self):
        """append_file on existing file should concatenate content."""
        from app.services.workspace_service import append_file
        with patch("app.services.workspace_service.read_file", new_callable=AsyncMock, return_value="existing "), \
             patch("app.services.workspace_service.write_file", new_callable=AsyncMock) as mock_write, \
             patch("app.services.workspace_service.verify_thread_ownership", return_value=True):
            mock_write.return_value = {"id": "test", "file_path": "test.md"}
            result = await append_file("thread-1", "test.md", "appended", "user-1")
            mock_write.assert_called_once_with("thread-1", "test.md", "existing appended", "user-1")


# ---------------------------------------------------------------------------
# Unit tests — format_phase_result V2
# ---------------------------------------------------------------------------

class TestFormatPhaseResult:
    def test_gather_context(self):
        from app.services.harness_engine import format_phase_result
        result = format_phase_result("Gather Context", {"user_response": "I'm the customer, focus on data protection"})
        assert "User context captured" in result
        assert "data protection" in result

    def test_load_playbook(self):
        from app.services.harness_engine import format_phase_result
        result = format_phase_result("Load Playbook", {"playbook_docs": [
            {"title": "Contract Standards", "summary": "Standard positions for SaaS"},
        ]})
        assert "1 playbook documents" in result

    def test_risk_analysis_v2(self):
        from app.services.harness_engine import format_phase_result
        result = format_phase_result("Risk Analysis", {"assessments": [
            {"risk_level": "GREEN", "clause_ref": "1.1", "category": "IP"},
            {"risk_level": "YELLOW", "clause_ref": "2.1", "category": "Liability", "rationale": "Cap too low"},
        ]})
        assert "2 clauses" in result
        assert "1 GREEN" in result
        assert "1 YELLOW" in result

    def test_executive_summary_v2(self):
        from app.services.harness_engine import format_phase_result
        result = format_phase_result("Executive Summary", {
            "overall_risk": "YELLOW",
            "recommendation": "Negotiate",
            "key_findings": ["Low liability cap"],
            "risk_breakdown": {"GREEN": 5, "YELLOW": 2},
        })
        assert "YELLOW" in result
        assert "Negotiate" in result


# ---------------------------------------------------------------------------
# Integration test — Harness CRUD (requires real Supabase)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_harness_crud(api1):
    """Test harness run CRUD operations via API."""
    # Create a thread first
    response = await api1.post("/threads", json={"title": "Harness Test"})
    assert response.status_code == 201
    thread_id = response.json()["id"]

    try:
        # Create harness run
        response = await api1.post(f"/threads/{thread_id}/harness", json={
            "harness_type": "contract_review",
            "input_file_ids": [],
            "config": {},
        })
        assert response.status_code == 201
        run = response.json()
        assert run["harness_type"] == "contract_review"
        assert run["status"] == "running"
        assert len(run["phases"]) == 8

        # Get harness run
        response = await api1.get(f"/threads/{thread_id}/harness")
        assert response.status_code == 200
        run = response.json()
        assert run["status"] == "running"

        # Duplicate should fail
        response = await api1.post(f"/threads/{thread_id}/harness", json={
            "harness_type": "contract_review",
        })
        assert response.status_code == 409

        # Cancel
        response = await api1.delete(f"/threads/{thread_id}/harness")
        assert response.status_code == 200

        # After cancel, should be able to create new one
        response = await api1.get(f"/threads/{thread_id}/harness")
        assert response.status_code == 200
        run = response.json()
        assert run["status"] == "failed"  # Most recent was cancelled

    finally:
        # Cleanup
        await api1.delete(f"/threads/{thread_id}")
