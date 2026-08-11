"""Contract review harness V2 — 8-phase workspace-first workflow."""
import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any, AsyncGenerator

from pydantic import BaseModel, field_validator

from app.services.harness_engine import HarnessDefinition, HarnessPrerequisites, PhaseDefinition, PhaseType
from app.services.harnesses import register_harness

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Output schemas (one per phase)
# ---------------------------------------------------------------------------

class ContractText(BaseModel):
    full_text: str
    page_count: int
    format: str


class Party(BaseModel):
    name: str
    role: str  # e.g. "Licensor", "Licensee", "Disclosing Party"


class ContractClassification(BaseModel):
    contract_type: str
    parties: list[Party]
    effective_date: str | None = None
    expiration_date: str | None = None
    governing_law: str | None = None
    jurisdiction: str | None = None

    @field_validator("parties")
    @classmethod
    def at_least_two_parties(cls, v):
        if len(v) < 2:
            raise ValueError("At least 2 parties required")
        return v


class Clause(BaseModel):
    category: str
    title: str
    text: str
    section_ref: str


class ClauseExtraction(BaseModel):
    clauses: list[Clause]

    @field_validator("clauses")
    @classmethod
    def at_least_three_clauses(cls, v):
        if len(v) < 3:
            raise ValueError("At least 3 clauses required")
        return v


class ClauseAssessment(BaseModel):
    clause_ref: str
    category: str
    risk_level: str  # GREEN, YELLOW, RED
    rationale: str
    suggested_language: str | None = None
    market_comparison: str  # Must reference specific knowledge base standards/benchmarks


class RiskAnalysis(BaseModel):
    assessments: list[ClauseAssessment]


class Redline(BaseModel):
    clause_ref: str
    original_text: str
    proposed_text: str
    risk_level: str
    rationale: str


class RedlineReport(BaseModel):
    redlines: list[Redline]


class ExecutiveSummary(BaseModel):
    overall_risk: str  # GREEN, YELLOW, RED
    recommendation: str
    key_findings: list[str]
    risk_breakdown: dict[str, int]
    detailed_report: str

    @field_validator("overall_risk")
    @classmethod
    def valid_risk(cls, v):
        if v.upper() not in ("GREEN", "YELLOW", "RED"):
            raise ValueError("overall_risk must be GREEN, YELLOW, or RED")
        return v.upper()


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------

def validate_contract_text(result: dict):
    if len(result.get("full_text", "")) < 100:
        raise ValueError("Contract text too short (< 100 chars)")


def validate_classification(result: dict):
    if not result.get("contract_type"):
        raise ValueError("contract_type is empty")


def validate_risk_analysis(result: dict):
    assessments = result.get("assessments")
    if not assessments:
        raise ValueError("No assessments provided")
    for a in assessments:
        level = (a.get("risk_level") or "").upper()
        if level in ("YELLOW", "RED") and not a.get("suggested_language"):
            raise ValueError(
                f"Clause {a.get('clause_ref', '?')} is {level} but missing suggested_language"
            )


def validate_redlines(result: dict):
    pass


def validate_summary(result: dict):
    if not result.get("recommendation"):
        raise ValueError("recommendation is empty")


def filter_yellow_red(item: dict) -> bool:
    """Filter batch items to YELLOW/RED risk levels only."""
    level = (item.get("risk_level") or "").upper()
    return level in ("YELLOW", "RED")


# ---------------------------------------------------------------------------
# Phase 0 executor (programmatic) — writes contract-text.md to workspace
# ---------------------------------------------------------------------------

async def execute_document_intake(
    run_id: str,
    thread_id: str,
    user_id: str,
    prior_results: dict[str, Any],
) -> dict:
    """Read uploaded file from workspace, extract text, write to workspace."""
    from app.db.supabase import get_supabase_client
    from app.services.harness_engine import get_harness_run
    from app.services.workspace_service import write_file

    run = await get_harness_run(thread_id, user_id)
    if not run:
        raise ValueError("No active harness run found")

    input_file_ids = run.get("input_file_ids", [])
    if not input_file_ids:
        raise ValueError("No input files provided. Please upload a contract document first.")

    supabase = get_supabase_client()

    file_id = str(input_file_ids[0])
    file_result = (
        supabase.table("workspace_files")
        .select("*")
        .eq("id", file_id)
        .eq("thread_id", thread_id)
        .execute()
    )

    if not file_result.data:
        raise ValueError(f"Input file {file_id} not found in thread {thread_id}")

    file_record = file_result.data[0]
    content_type = file_record.get("content_type", "")
    storage_path = file_record.get("storage_path")
    text_content = file_record.get("content", "")

    if content_type in ("text/plain", "text/markdown") or not storage_path:
        if not text_content or len(text_content) < 100:
            raise ValueError("Contract text too short or empty")
        full_text = text_content
        fmt = content_type or "text/plain"
    else:
        try:
            file_bytes = supabase.storage.from_("workspace-files").download(storage_path)
        except Exception as e:
            raise ValueError(f"Failed to download file from storage: {e}")

        from app.services.text_extraction import extract_text
        full_text = await extract_text(file_bytes, content_type)

        if len(full_text) < 100:
            raise ValueError("Extracted text too short (< 100 chars)")
        fmt = content_type

    page_count = max(1, len(full_text) // 3000)

    # Write contract text to workspace
    await write_file(thread_id, "contract-text.md", full_text, user_id)

    return {
        "full_text": full_text,
        "page_count": page_count,
        "format": fmt,
        "_summary": f"Extracted {len(full_text):,} chars ({page_count} pages) from {fmt}",
    }


# ---------------------------------------------------------------------------
# Phase 4 executor (programmatic with internal LLM) — clause extraction
# ---------------------------------------------------------------------------

async def execute_clause_extraction(
    run_id: str,
    thread_id: str,
    user_id: str,
    prior_results: dict[str, Any],
) -> dict:
    """Extract clauses from contract text, with chunking for large contracts."""
    from app.services.workspace_service import read_file, write_file
    from app.services.token_service import estimate_tokens
    from app.services.llm_service import astream_chat_response

    contract_text = await read_file(thread_id, "contract-text.md", user_id)
    token_count = estimate_tokens(contract_text)

    extraction_prompt = (
        "You are a contract analyst. Extract and categorize every distinct clause "
        "from this contract. For each clause, identify its category, quote the "
        "relevant text, and note the section reference.\n\n"
        "Categories: Liability, Indemnification, IP, Data Protection, Confidentiality, "
        "Warranties, Term/Termination, Governing Law, Insurance, Assignment, "
        "Force Majeure, Payment, Other\n\n"
        "Respond with structured JSON matching this schema:\n"
        '{"clauses": [{"category": "...", "title": "...", "text": "...", "section_ref": "..."}]}'
    )

    response_format = {
        "type": "json_schema",
        "json_schema": {
            "name": "ClauseExtraction",
            "schema": ClauseExtraction.model_json_schema(),
        },
    }

    all_clauses = []

    if token_count < 50000:
        # Small contract — single LLM call
        messages = [{"role": "user", "content": f"Extract all clauses from this contract:\n\n{contract_text}"}]

        full_text = ""
        async for event in astream_chat_response(
            messages=messages,
            tools=None,
            user_id=user_id,
            system_prompt=extraction_prompt,
            response_format=response_format,
        ):
            if event["type"] == "text_delta":
                full_text += event["content"]
            elif event["type"] == "response_complete":
                full_text = event.get("full_response", full_text)

        try:
            data = json.loads(full_text)
            if isinstance(data, list):
                data = {"clauses": data}
            validated = ClauseExtraction.model_validate(data)
            all_clauses = [c.model_dump() for c in validated.clauses]
        except Exception as e:
            raise ValueError(f"Failed to parse clause extraction: {e}")
    else:
        # Large contract — chunk and merge
        paragraphs = contract_text.split("\n\n")
        chunks = []
        current_chunk = ""
        for para in paragraphs:
            if estimate_tokens(current_chunk + "\n\n" + para) > 10000 and current_chunk:
                chunks.append(current_chunk)
                # Overlap: include last 500 tokens worth
                overlap_text = current_chunk[-2000:]  # Approximate 500 tokens
                current_chunk = overlap_text + "\n\n" + para
            else:
                current_chunk = current_chunk + "\n\n" + para if current_chunk else para
        if current_chunk:
            chunks.append(current_chunk)

        for chunk_idx, chunk in enumerate(chunks):
            messages = [{"role": "user", "content": f"Extract all clauses from this section (chunk {chunk_idx + 1}/{len(chunks)}):\n\n{chunk}"}]

            full_text = ""
            try:
                async def _extract_chunk():
                    nonlocal full_text
                    async for event in astream_chat_response(
                        messages=messages,
                        tools=None,
                        user_id=user_id,
                        system_prompt=extraction_prompt,
                        response_format=response_format,
                    ):
                        if event["type"] == "text_delta":
                            full_text += event["content"]
                        elif event["type"] == "response_complete":
                            full_text = event.get("full_response", full_text)

                await asyncio.wait_for(_extract_chunk(), timeout=60.0)
            except asyncio.TimeoutError:
                logger.warning(f"[HARNESS] Clause extraction chunk {chunk_idx} timed out")
                continue

            try:
                data = json.loads(full_text)
                if isinstance(data, list):
                    data = {"clauses": data}
                chunk_clauses = [c.model_dump() for c in ClauseExtraction.model_validate(data).clauses]
                all_clauses.extend(chunk_clauses)
            except Exception as e:
                logger.warning(f"[HARNESS] Chunk {chunk_idx} clause parsing failed: {e}")

        # Deduplicate
        all_clauses = _deduplicate_clauses(all_clauses)

    if len(all_clauses) < 3:
        raise ValueError(f"Only {len(all_clauses)} clauses extracted — at least 3 required")

    # Write clauses to workspace as JSON array
    await write_file(thread_id, "clauses.md", json.dumps(all_clauses, indent=2), user_id)

    # Build summary
    categories = {}
    for c in all_clauses:
        cat = c.get("category", "Other")
        categories[cat] = categories.get(cat, 0) + 1
    cat_breakdown = ", ".join(f"{cat} ({n})" for cat, n in sorted(categories.items()))

    return {
        "clauses": all_clauses,
        "_summary": f"Extracted {len(all_clauses)} clauses ({cat_breakdown})",
    }


def _deduplicate_clauses(clauses: list[dict]) -> list[dict]:
    """Deduplicate clauses by section_ref or text prefix similarity."""
    seen_refs: dict[str, dict] = {}
    no_ref: list[dict] = []

    for c in clauses:
        ref = c.get("section_ref", "")
        if ref:
            if ref in seen_refs:
                # Keep the one with longer text
                if len(c.get("text", "")) > len(seen_refs[ref].get("text", "")):
                    seen_refs[ref] = c
            else:
                seen_refs[ref] = c
        else:
            no_ref.append(c)

    # Deduplicate no-ref clauses by text[:150] normalized comparison
    deduped_no_ref = []
    seen_prefixes: set[str] = set()
    for c in no_ref:
        prefix = " ".join(c.get("text", "")[:150].lower().split())
        if prefix not in seen_prefixes:
            seen_prefixes.add(prefix)
            deduped_no_ref.append(c)

    return list(seen_refs.values()) + deduped_no_ref


# ---------------------------------------------------------------------------
# Post-execute: DOCX report generation (runs after Phase 7 Executive Summary)
# ---------------------------------------------------------------------------

async def post_execute_docx_report(
    run_id: str,
    thread_id: str,
    user_id: str,
    prior_results: dict[str, Any],
) -> AsyncGenerator[dict, None]:
    """Generate a DOCX report from accumulated phase artifacts via sandbox."""
    from app.services.sandbox_service import run_code_execution

    # Extract contract info for filename
    phase_1 = prior_results.get("1", {})
    contract_type = phase_1.get("contract_type", "Contract")
    parties = phase_1.get("parties", [])
    party_name = parties[0].get("name", "Report") if parties else "Report"

    # Sanitize filename
    raw_name = f"Contract_Review_Report_{contract_type}_{party_name}"
    sanitized = re.sub(r"[^\w\s-]", "", raw_name).replace(" ", "_")[:80]
    output_filename = f"{sanitized}.docx"

    # Load the DOCX script
    script_path = Path(__file__).parent / "docx_report_script.py"
    script_code = script_path.read_text(encoding="utf-8")

    # Prepend sys.argv so script receives the filename
    full_code = f"import sys\nsys.argv = ['script', '{output_filename}']\n\n{script_code}"

    yield {"type": "text_delta", "content": "\n\n*Generating DOCX report...*\n"}

    try:
        async for event in run_code_execution(
            code=full_code,
            thread_id=thread_id,
            user_id=user_id,
            output_filenames=[output_filename],
        ):
            event_type = event.get("type", "")
            if event_type == "code_execution_error":
                yield event
                logger.error(f"[HARNESS] DOCX generation failed: {event.get('error', 'unknown')}")
                yield {"type": "text_delta", "content": "\n*DOCX report generation failed — report skipped.*\n"}
                return
            elif event_type == "code_execution_complete":
                # Extract files and emit workspace_file_written so frontend refreshes
                from app.services.workspace_service import get_file as ws_get_file
                files = event.get("files", [])
                for f in files:
                    if "error" not in f and f.get("filename"):
                        try:
                            file_rec = await ws_get_file(thread_id, f["filename"], user_id)
                            if file_rec:
                                yield {"type": "workspace_file_written", "file": file_rec}
                        except Exception:
                            pass
    except Exception as e:
        logger.error(f"[HARNESS] DOCX post_execute sandbox error: {e}")
        yield {"type": "text_delta", "content": "\n*DOCX report generation failed — report skipped.*\n"}
        return

    yield {"type": "text_delta", "content": f"\n*DOCX report generated: {output_filename}*\n"}


# ---------------------------------------------------------------------------
# Phase definitions (V2 — 8 phases, workspace-first)
# ---------------------------------------------------------------------------

# Phase 0 (internal index 0): Document Intake
PHASE_0_INTAKE = PhaseDefinition(
    name="Document Intake",
    description="Extract text from the uploaded contract document",
    phase_type=PhaseType.programmatic,
    system_prompt_template="",
    output_schema=ContractText,
    validator=validate_contract_text,
    executor=execute_document_intake,
    timeout_seconds=60,
    workspace_output="contract-text.md",
)

# Phase 1 (internal index 1): Contract Classification
PHASE_1_CLASSIFICATION = PhaseDefinition(
    name="Contract Classification",
    description="Classify the contract by type, parties, dates, and governing law",
    phase_type=PhaseType.llm_single,
    system_prompt_template=(
        "You are a contract analyst. Classify this contract by type, parties, "
        "effective date, and governing law.\n\n"
        "CONTRACT TEXT:\n$workspace_contract_text\n\n"
        "Respond with structured JSON matching the required schema. "
        "Identify all parties with their roles (e.g., Licensor, Licensee). "
        "Extract dates in ISO format (YYYY-MM-DD) when possible."
    ),
    tools=None,
    output_schema=ContractClassification,
    validator=validate_classification,
    timeout_seconds=120,
    workspace_inputs=["contract-text.md"],
    workspace_output="classification.md",
)

# Phase 2 (internal index 2): Gather Context (human-in-the-loop)
PHASE_2_GATHER_CONTEXT = PhaseDefinition(
    name="Gather Context",
    description="Ask the reviewer for context about their review needs",
    phase_type=PhaseType.llm_human_input,
    system_prompt_template=(
        "You are a contract review assistant preparing to analyze a contract. "
        "Based on the classification below, generate a short, friendly message asking "
        "the reviewer for context that will help you provide a more targeted analysis.\n\n"
        "CLASSIFICATION:\n$workspace_classification\n\n"
        "Ask about:\n"
        "1. Which side they are on (e.g., vendor/customer, licensor/licensee)\n"
        "2. Any deadline pressure\n"
        "3. Specific focus areas or concerns\n"
        "4. Deal context (size, strategic importance, existing relationship)\n\n"
        "Be conversational and brief. Reference what you know about the contract "
        "(type, parties) to show you've already analyzed it."
    ),
    tools=None,
    timeout_seconds=120,
    workspace_inputs=["classification.md"],
    workspace_output="review-context.md",
)

# Phase 3 (internal index 3): Load Playbook (file system discovery)
PHASE_3_LOAD_PLAYBOOK = PhaseDefinition(
    name="Load Playbook",
    description="Find relevant playbook standards and guides in the docs folder",
    phase_type=PhaseType.llm_agent,
    system_prompt_template=(
        "You are a legal research assistant. Your job is to discover and catalog the "
        "firm's playbook materials relevant to this contract type.\n\n"
        "CONTRACT CLASSIFICATION:\n$workspace_classification\n\n"
        "REVIEWER CONTEXT:\n$workspace_review_context\n\n"
        "## Your task\n"
        "The playbook files are stored in the docs/knowledge-base folder. Use the `tree` "
        "and `ls` tools to explore the folder structure and find relevant files. Then use "
        "`read` to read the contents of relevant playbook documents.\n\n"
        "Steps:\n"
        "1. Use `tree` on the docs/ folder to see the full structure\n"
        "2. Use `ls` to explore promising subfolders\n"
        "3. Use `read` to read the first section of relevant playbook files\n"
        "4. For each relevant document, note its path, title, summary, and which clause categories it covers\n\n"
        "## Output\n"
        "When done, provide a structured summary as JSON:\n"
        '{"playbook_docs": [{"doc_id": "...", "title": "...", "path": "...", "summary": "...", '
        '"categories": ["Liability", "IP", ...]}]}\n\n'
        "Focus on finding playbook standards, negotiation guides, and policy documents "
        "relevant to this contract type."
    ),
    tools=["tree", "ls", "read"],
    max_rounds=10,
    timeout_seconds=300,
    workspace_inputs=["classification.md", "review-context.md"],
    workspace_output="playbook-context.md",
)

# Phase 4 (internal index 4): Clause Extraction
PHASE_4_CLAUSE_EXTRACTION = PhaseDefinition(
    name="Clause Extraction",
    description="Extract and categorize every distinct clause from the contract",
    phase_type=PhaseType.programmatic,
    system_prompt_template="",
    output_schema=ClauseExtraction,
    executor=execute_clause_extraction,
    timeout_seconds=120,
    workspace_inputs=["contract-text.md"],
    workspace_output="clauses.md",
)

# Phase 5 (internal index 5): Risk Analysis (batch agents)
PHASE_5_RISK_ANALYSIS = PhaseDefinition(
    name="Risk Analysis",
    description="Analyze each clause against knowledge base standards and flag risks",
    phase_type=PhaseType.llm_batch_agents,
    system_prompt_template=(
        "You are a contract risk analyst. Assess this specific clause against the "
        "firm's playbook standards.\n\n"
        "Clause: $clause_title ($clause_category)\n"
        "Section: $clause_ref\n"
        "Text: $clause_text\n\n"
        "The playbook-context.md workspace file contains paths to relevant playbook "
        "documents. Use the `read` tool to read the relevant playbook files for this "
        "clause category. Assess risk level (GREEN/YELLOW/RED), provide "
        "rationale referencing specific playbook standards, and suggest alternative "
        "language for YELLOW/RED clauses.\n\n"
        "Respond with JSON:\n"
        '{"clause_ref": "...", "category": "...", "risk_level": "GREEN|YELLOW|RED", '
        '"rationale": "...", "suggested_language": "...", "market_comparison": "..."}'
    ),
    tools=["read"],
    output_schema=RiskAnalysis,
    validator=validate_risk_analysis,
    batch_size=5,
    batch_items_file="clauses.md",
    max_rounds=8,
    timeout_seconds=600,
    workspace_inputs=["clauses.md", "playbook-context.md", "review-context.md"],
    workspace_output="risk-analysis.md",
    sub_agent_tools=["read", "search_documents"],
    sub_agent_prompt=(
        "You are a contract risk analyst sub-agent. Your job is to assess a specific "
        "contract clause against the firm's playbook standards.\n\n"
        "## Available Tools\n"
        "- `read` — Read files from the docs/knowledge-base folder. Use paths from playbook-context.md.\n"
        "- `search_documents` — Search the knowledge base for relevant standards.\n\n"
        "## Instructions\n"
        "1. Review the clause details provided in your task description.\n"
        "2. Read the relevant playbook documents using the `read` tool.\n"
        "3. Assess the risk level (GREEN/YELLOW/RED) based on playbook standards.\n"
        "4. For YELLOW/RED clauses, suggest alternative language.\n"
        "5. Respond with a JSON object matching the required schema."
    ),
)

# Phase 6 (internal index 6): Redline Generation (batch agents, YELLOW/RED only)
PHASE_6_REDLINES = PhaseDefinition(
    name="Redline Generation",
    description="Generate redline markup for YELLOW and RED flagged clauses",
    phase_type=PhaseType.llm_batch_agents,
    system_prompt_template=(
        "You are a contract redline specialist. Generate precise redline markup "
        "for this flagged clause.\n\n"
        "Clause Reference: $clause_ref\n"
        "Category: $category\n"
        "Risk Level: $risk_level\n\n"
        "Original Clause Text:\n$clause_text\n\n"
        "Risk Assessment Rationale:\n$rationale\n\n"
        "Suggested Language from Risk Analysis:\n$suggested_language\n\n"
        "Proposed changes should be specific, balanced, and include fallback positions.\n\n"
        "Respond with JSON:\n"
        '{"clause_ref": "...", "original_text": "...", "proposed_text": "...", '
        '"risk_level": "...", "rationale": "..."}'
    ),
    tools=None,
    output_schema=RedlineReport,
    validator=validate_redlines,
    batch_size=5,
    batch_items_file="risk-analysis.md",
    batch_item_filter=filter_yellow_red,
    max_rounds=5,
    timeout_seconds=300,
    workspace_inputs=["risk-analysis.md", "playbook-context.md", "clauses.md"],
    workspace_output="redlines.md",
    sub_agent_tools=["read"],
    sub_agent_prompt=(
        "You are a contract redline specialist sub-agent. Your job is to generate "
        "precise redline markup for a flagged clause.\n\n"
        "## Available Tools\n"
        "- `read` — Read files from the docs/knowledge-base folder. Use paths from playbook-context.md.\n\n"
        "## Instructions\n"
        "1. Review the clause details, original text, and risk assessment in your task description.\n"
        "2. If needed, read relevant playbook documents for standard language.\n"
        "3. Generate a proposed revision that addresses the identified risk.\n"
        "4. Include a rationale and fallback position.\n"
        "5. Respond with a JSON object matching the required schema."
    ),
)

# Phase 7 (internal index 7): Executive Summary
PHASE_7_SUMMARY = PhaseDefinition(
    name="Executive Summary",
    description="Synthesize analysis into executive summary and detailed report",
    phase_type=PhaseType.llm_single,
    system_prompt_template=(
        "You are a contract review report writer. Synthesize the complete analysis "
        "into an executive summary and detailed report.\n\n"
        "PROGRESS:\n$workspace_progress\n\n"
        "RISK ANALYSIS:\n$workspace_risk_analysis\n\n"
        "REDLINES:\n$workspace_redlines\n\n"
        "REVIEWER CONTEXT:\n$workspace_review_context\n\n"
        "Include:\n"
        "- Overall risk rating (GREEN/YELLOW/RED)\n"
        "- Clear recommendation (proceed, negotiate, reject)\n"
        "- Key findings as bullet points\n"
        "- Risk breakdown by count (GREEN: N, YELLOW: N, RED: N)\n"
        "- Detailed report in Markdown format\n\n"
        "The detailed_report should be comprehensive Markdown suitable for "
        "saving as a standalone document."
    ),
    tools=None,
    output_schema=ExecutiveSummary,
    validator=validate_summary,
    timeout_seconds=180,
    workspace_inputs=["progress.md", "risk-analysis.md", "redlines.md", "review-context.md"],
    workspace_output="contract-review-report.md",
    post_execute=post_execute_docx_report,
)


# ---------------------------------------------------------------------------
# Harness definition + registration
# ---------------------------------------------------------------------------

CONTRACT_REVIEW_HARNESS = HarnessDefinition(
    harness_type="contract_review",
    display_name="Contract Review",
    phases=[
        PHASE_0_INTAKE,          # 0: Document Intake
        PHASE_1_CLASSIFICATION,  # 1: Contract Classification
        PHASE_2_GATHER_CONTEXT,  # 2: Gather Context (human input)
        PHASE_3_LOAD_PLAYBOOK,   # 3: Load Playbook (RAG)
        PHASE_4_CLAUSE_EXTRACTION,  # 4: Clause Extraction
        PHASE_5_RISK_ANALYSIS,   # 5: Risk Analysis (batch)
        PHASE_6_REDLINES,        # 6: Redline Generation (batch)
        PHASE_7_SUMMARY,         # 7: Executive Summary
    ],
    prerequisites=HarnessPrerequisites(
        requires_upload=True,
        upload_description="a contract document (PDF, DOCX, MD, or TXT)",
        harness_intro="I'm your contract review assistant. I'll analyze your contract for key clauses, risks, and provide recommendations.",
    ),
)

register_harness(CONTRACT_REVIEW_HARNESS)
