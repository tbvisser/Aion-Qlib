"""LLM service using ChatCompletions API with provider abstraction."""
import logging
from datetime import datetime, timezone
from typing import AsyncGenerator, Any

from fastapi import HTTPException, status

from app.config import get_settings
from app.services.langsmith import get_traced_async_openai_client, traceable
from app.models.metadata import get_metadata_schema

logger = logging.getLogger(__name__)

# Sub-agent Codex calls should be capable but not quota-heavy. They do not use
# the composer's per-message reasoning setting, so keep them at a fixed default.
CODEX_SUB_AGENT_REASONING_EFFORT = "medium"

def get_max_tool_rounds() -> int:
    """Get max tool rounds from settings."""
    return get_settings().max_tool_rounds


def _build_skills_catalog(user_id: str) -> str:
    """Query enabled skills visible to a user and return a formatted catalog block.

    Returns an empty string when no skills are found so the system prompt
    stays unchanged for users without skills.
    """
    try:
        from app.db.supabase import get_supabase_client

        supabase = get_supabase_client()
        result = (
            supabase.table("skills")
            .select("id, name, description")
            .eq("enabled", True)
            .or_(f"user_id.is.null,user_id.eq.{user_id}")
            .execute()
        )
        skills = result.data or []
        if not skills:
            return ""

        rows = "\n".join(
            f"| {s['name']} | {s['id']} | {s['description']} |"
            for s in skills
        )
        return (
            "\n\n## Available Skills\n"
            "You have access to specialized skills. When a user's request clearly matches a skill's\n"
            "purpose, call `load_skill` with the skill's id to load its full instructions before responding.\n"
            "\n"
            "| Skill | ID | When to use |\n"
            "|-------|----|-------------|\n"
            f"{rows}\n"
            "\n"
            "IMPORTANT: Only load a skill when the user's request clearly aligns with its description.\n"
            "Do not load skills speculatively or preemptively."
        )
    except Exception as e:
        logger.warning(f"Failed to build skills catalog: {e}")
        return ""


def _build_tool_catalog_block() -> str:
    """Build a compact tool catalog from the registry for the system prompt."""
    from app.services.tool_registry import get_tool_registry
    settings = get_settings()
    registry = get_tool_registry()
    catalog = registry.get_catalog(max_tools=settings.catalog_max_tools)
    if not catalog:
        return ""
    bridge_block = ""
    if settings.sandbox_enabled:
        # Build list of available tool wrapper names from the registry
        tool_names = [t.name for t in registry._tools.values() if t.openai_schema]
        tool_names_str = ", ".join(tool_names) if tool_names else "(none currently registered)"
        bridge_block = (
            "\n\n## Code Mode (Tool Bridge)\n"
            "When you use `execute_code`, the sandbox has access to a `tool_client` that can call registered tools.\n"
            "This is useful for multi-step workflows that would otherwise require many round-trips.\n\n"
            "**CRITICAL: Write self-contained Python code.** Do NOT import from imaginary modules.\n"
            "The ONLY available imports for tool access are `tools` and `bridge_client` — no other custom modules exist.\n"
            f"Available tool wrappers in `from tools import *`: {tool_names_str}\n\n"
            "**CRITICAL: All tool bridge calls return STRINGS, not dicts/lists.** You must parse them:\n"
            "```python\n"
            "import json\n"
            "from tools import search_documents\n\n"
            "# Tool calls return strings — always parse with json.loads()\n"
            "raw = search_documents(query='employee benefits')\n"
            "# raw is a string like: 'id | name | amount\\n---\\n1 | Widget | 99.99'\n"
            "# For structured data, use the bridge client directly:\n"
            "from bridge_client import tool_client\n"
            "result = tool_client.call('search_documents', query='employee benefits')  # returns string\n"
            "# Parse if JSON, otherwise process as text\n"
            "try:\n"
            "    data = json.loads(result)\n"
            "except (json.JSONDecodeError, TypeError):\n"
            "    data = result  # plain text result\n"
            "```\n\n"
            "**IMPORTANT:** For data analysis tasks, write self-contained Python code with standard\n"
            "libraries (pandas, etc.) — do NOT invent helper modules.\n\n"
            "**Prefer Code Mode** when a task needs multiple tool calls or data processing between calls — "
            "it completes in a single round-trip instead of N separate tool calls.\n"
        )

    return (
        "\n\n## Tool Catalog\n"
        "The following tools are registered but NOT yet loaded. "
        "This catalog is for **reference only** — you cannot call these tools directly.\n\n"
        f"{catalog}\n\n"
        "**MANDATORY: Before calling ANY tool from this catalog, you MUST first call `tool_search` "
        "to load its full schema.** Calling a catalog tool without loading it first will fail. "
        "Only tools already provided in your function definitions are ready to use without `tool_search`.\n\n"
        "Example workflow:\n"
        "1. Identify which catalog tool you need\n"
        "2. Call `tool_search` with the tool name or a keyword\n"
        "3. The tool's schema is now loaded — call it normally\n"
        f"{bridge_block}"
    )


WORKSPACE_PROMPT = """

## Workspace

You have access to a per-conversation workspace filesystem for uploaded files and artifacts.

### Workspace Tools
- **write_file**: Create or overwrite a file. Use for notes, data, drafts, and deliverables.
- **read_file**: Retrieve file contents by path.
- **edit_file**: Replace a string in a file. `old_string` must be unique in the file (include surrounding context if needed), or pass `replace_all=true` to replace every occurrence.
- **list_files**: Show all files in the workspace with metadata.

### File Organization
Organize files into folders by purpose:
- `notes/` — research notes, observations, intermediate findings
- `data/` — structured data, CSV exports, JSON results
- `drafts/` — work-in-progress documents
- `deliverables/` — final outputs for the user

### Tips
- Workspace files persist across the conversation — use them for context transfer between rounds.
- Use `list_files` to review what you have before creating duplicates.
- When the user refers to an uploaded, attached, or "this" file, treat it as a workspace file first. Use `list_files` to find its exact path, then `read_file` for text/extracted content. Pass `start_line` and `end_line` when you need a specific range from a large file.
- Uploaded chat files are thread workspace files, not knowledge-base Documents. Do not use `search_documents`, `analyze_document`, `grep`, `glob`, `ls`, or `read` to find a newly attached chat file unless the user explicitly asks about the document library.
- Use `edit_file` for targeted modifications instead of rewriting entire files.
- **IMPORTANT**: ALWAYS use workspace tools (list_files, read_file, write_file, edit_file) for workspace operations."""

WORKSPACE_SANDBOX_PROMPT = """
- Use workspace tools to list, read, write, and edit workspace records.
- For data processing or binary-file analysis, `execute_code` can read workspace files from `/sandbox/workspace/<file_path>` after you identify the exact relative path with `list_files`. For example, an uploaded `uploads/report.pdf` is available to Python at `/sandbox/workspace/uploads/report.pdf`.
- Do not use `execute_code` just to list or manage workspace files; use workspace tools for that."""

DEEP_MODE_PROMPT_PREFIX = """

## Deep Mode: Autonomous Agent

You are in **deep mode** — an autonomous orchestrator agent. Your job is to take complex, multi-step tasks and drive them to completion independently. Think before acting, plan your work, execute methodically, and deliver results.

### Your Operating Model
1. **Plan first** — Break the task into steps BEFORE doing anything. Create a todo list immediately.
2. **Execute step-by-step** — Work through your plan one step at a time. Use the right tool for each step.
3. **Track progress** — Update your plan as you go. Mark steps complete, add steps if needed.
4. **Deliver results** — Save final outputs as workspace files the user can access.

### Planning with Todos (MANDATORY)
- **IMMEDIATELY** create a todo list using `write_todos` when you receive a task. Do not skip this step.
- Each todo should be a clear, actionable step with a specific outcome.
- Before starting each step, call `read_todos` to review your plan and mark the current task as `in_progress`.
- After completing each step, update the todo: mark it `completed` and move to the next.
- Adapt your plan as you learn — add, remove, or rewrite tasks as needed. Send the COMPLETE updated list each time.
- Position items in execution order (0-indexed).

### Orchestration Strategy
- **Stay lean** — You are the orchestrator. Gather information, synthesize, and produce outputs.
- **Use workspace files** — Save intermediate work (notes, data, drafts) to workspace files so context survives across rounds. Write research findings, intermediate results, and drafts to files rather than keeping everything in the conversation."""

DEEP_MODE_SANDBOX_PROMPT = """
- **Combine tools efficiently** - Use `execute_code` for data processing, calculations, and file generation. Use workspace tools for managing artifacts. Use search/retrieval tools for gathering information."""

DEEP_MODE_STANDARD_PROMPT = """
- **Combine tools efficiently** - Use workspace tools for managing artifacts, the calculator for math, and search/retrieval tools for gathering information."""

DEEP_MODE_PROMPT_SUFFIX = """
- **Recover from errors** — If a tool call fails, try an alternative approach. Do not loop on the same failure.

### Delegation

Use `task` to delegate focused work to a sub-agent when:
- The task is context-heavy (would bloat your context with intermediate results)
- The task is independent (doesn't need your conversation history)
- You want to parallelize work conceptually (each sub-agent focuses on one piece)

Do NOT delegate when:
- The task is quick and simple (just do it directly)
- The task requires your full conversation context
- You need real-time back-and-forth with the user

Sub-agents share your workspace — they can read and write files. Use workspace files to pass large context to sub-agents via `context_files` parameter.

### User Interaction
When you encounter genuine ambiguity or need a decision only the user can make, ask a clarifying question. Do not ask for confirmation on routine steps — just execute your plan."""


def get_workspace_prompt() -> str:
    """Return workspace instruction section for the system prompt."""
    if get_settings().sandbox_enabled:
        return WORKSPACE_PROMPT + WORKSPACE_SANDBOX_PROMPT
    return WORKSPACE_PROMPT


def get_deep_mode_prompt() -> str:
    """Return deep mode instruction sections for the system prompt."""
    combine_tools_prompt = (
        DEEP_MODE_SANDBOX_PROMPT
        if get_settings().sandbox_enabled
        else DEEP_MODE_STANDARD_PROMPT
    )
    return DEEP_MODE_PROMPT_PREFIX + combine_tools_prompt + DEEP_MODE_PROMPT_SUFFIX


def _build_calculation_guidance(*, sandbox_enabled: bool, tool_registry_enabled: bool) -> str:
    calculator_hint = (
        "- **calculator** tool (simple expressions) - use `tool_search` to discover it first"
        if tool_registry_enabled
        else "- **calculator** tool (simple expressions)"
    )
    if not sandbox_enabled:
        return f"""## Calculations
NEVER do math in your head - you WILL make mistakes. For ANY calculation (arithmetic, percentages, comparisons, totals, averages, etc.), you MUST use:
{calculator_hint}"""

    return f"""## Calculations
NEVER do math in your head - you WILL make mistakes. For ANY calculation (arithmetic, percentages, comparisons, totals, averages, etc.), you MUST use either:
{calculator_hint}
- **execute_code** sandbox (complex multi-step calculations, data processing)"""


def _build_code_mode_guidance(*, tool_registry_enabled: bool) -> str:
    bridge_sentence = (
        " Use the tool bridge to call any registered tool from within your code:"
        if tool_registry_enabled
        else ""
    )
    bridge_example = (
        "\n```python\n"
        "from tools import search_documents\n"
        "# Query sources, process results in Python\n"
        "```"
        if tool_registry_enabled
        else ""
    )
    return f"""## When NOT to Use Code Mode
- **Workspace file operations** - ALWAYS use list_files, read_file, write_file, edit_file for workspace files. The sandbox filesystem is separate from the workspace.
- **Single tool calls** - if a task needs one tool call, just use that tool directly.

## When to Use Code Mode (execute_code)

**IMPORTANT: Prefer `execute_code` over multiple sequential tool calls** when a task involves ANY of:
- **Cross-referencing data from multiple sources** (e.g., comparing findings across documents or tool outputs)
- **Multi-step workflows** where one tool's output feeds into another (e.g., query data -> filter -> compare -> summarize)
- **Aggregation or comparison logic** (e.g., summarizing counts, totals, trends, or mismatches from retrieved data)
- **Any calculation** - NEVER do math in your head, you WILL make mistakes
- **Data processing** - sorting, filtering, joining, pivoting results from different queries
- **File generation** - creating PPTX, DOCX, CSV, charts, then saving to /sandbox/output/

Code mode completes these in a **single round-trip** instead of N sequential tool calls.{bridge_sentence}{bridge_example}

**Example**: "Which policy changes affect remote employees in different regions?" requires:
1. Search for policy documents across multiple terms
2. Extract regional requirements from the results
3. Cross-reference and summarize the differences
-> This is ONE `execute_code` call, NOT three separate tool calls."""


def _build_system_tools_section(settings: Any) -> str:
    """Build tool instructions without mentioning sandbox-only features when disabled."""
    if settings.tool_registry_enabled:
        execute_code_tip = ""
        if settings.sandbox_enabled:
            execute_code_tip = """
- **execute_code**: Python ONLY (no Node.js/JavaScript). Write output files to /sandbox/output/. Libraries installed on first use persist for the session. Write SELF-CONTAINED code - do NOT import from imaginary modules. Only use standard library, pip-installable packages, or the tool bridge (`from tools import ...` / `from bridge_client import tool_client`)."""

        code_mode_guidance = (
            "\n\n" + _build_code_mode_guidance(tool_registry_enabled=True)
            if settings.sandbox_enabled
            else ""
        )
        return f"""## Tool Usage Tips

- **search_documents**: Search the knowledge-base/document-library Documents, not newly attached chat workspace files. For complex questions, make MULTIPLE searches with different query phrasings to maximize coverage. For example, if asked about "company benefits", search for "employee benefits", "health insurance", "retirement plan", etc. Do not use metadata filtering. Search modes: 'hybrid' (default), 'keyword' (exact terms), 'vector' (conceptual).
- **analyze_document**: Use for summarizing or deeply analyzing ONE specific document. The document_id parameter must be a UUID (like "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), NOT a filename. Get the UUID from the "document_id:" field in search_documents results.
- **web_search**: Use when documents don't have the answer AND the question requires recent/external information. Always cite source URLs.
- **ls / tree**: Use ls to explore folder contents and tree for hierarchical views. Use folder UUIDs from results to navigate into subfolders.
- **grep / glob**: grep supports regex patterns (Python syntax). glob supports wildcards: * (any chars), ? (single char), ** (recursive).
- **read**: Returns full document or specific line range. Max 500 lines per request; use line range for large documents.
- **explore_knowledge_base**: Delegates complex multi-document research to a sub-agent. Great for tasks requiring many tool calls.
- **get_document_structure**: After finding a document via search, call this with the document_id to see its full table of contents with chunk index ranges (e.g., `## Security [7-9]`). Use the ranges to decide which sections to fetch.
- **get_document_sections**: Fetch entire sections by chunk index ranges. Use after get_document_structure shows you the TOC, or after search results include `childRange`/`parentRange` metadata. Pass document_id and ranges like `[[7, 9]]`.{execute_code_tip}

{_build_calculation_guidance(sandbox_enabled=settings.sandbox_enabled, tool_registry_enabled=True)}{code_mode_guidance}"""

    execute_code_tool = ""
    calculator_number = 12
    if settings.sandbox_enabled:
        calculator_number = 13
        execute_code_tool = """
12. **execute_code** - Execute Python code in a sandboxed Docker container.
   - Language: Python ONLY (no Node.js, no JavaScript, no other runtimes)
   - Persistent state across calls within the same session
   - Use for: file generation (PPTX, DOCX, CSV, charts), data processing, computations
   - Use Python libraries directly (e.g. python-pptx, python-docx, openpyxl, matplotlib)
   - Do NOT attempt to use subprocess to call node, npm, or any non-Python tools
   - Write output files to /sandbox/output/ and list them in output_filenames
   - Libraries installed on first use persist for the session
   - **CRITICAL**: Write SELF-CONTAINED code. Do NOT import from custom modules like "tools", "helpers", "utils", etc. - they do not exist. Only use standard library and pip-installable packages.
"""

    code_mode_guidance = (
        "\n\n" + _build_code_mode_guidance(tool_registry_enabled=False)
        if settings.sandbox_enabled
        else ""
    )
    return f"""## Available Tools

1. **search_documents** - Search the user's knowledge-base/document-library Documents for relevant information.
   - Use when questions might be answered by documents in the document library
   - Do not use for newly attached chat workspace files; use workspace tools instead
   - For the moment do not use metadata filtering.
   - Search modes: 'hybrid' (default), 'keyword' (exact terms), 'vector' (conceptual)
   - **Pro tip**: For complex questions, make MULTIPLE searches with different query phrasings to maximize coverage. For example, if asked about "company benefits", you might search for "employee benefits", "health insurance", "retirement plan", etc.

2. **analyze_document** - Analyze a specific document in depth.
   - Use when the user asks to summarize, review, or deeply analyze ONE specific document
   - Spawns a sub-agent that reads the FULL document content
   - Best for: "Summarize my report", "What are the key points in [document]?", "Review this document"
   - NOT for: questions that span multiple documents (use search_documents instead)
   - **CRITICAL**: The document_id parameter must be a UUID (like "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), NOT a filename. Get the UUID from the "document_id:" field in search_documents results.

3. **web_search** - Search the web for current information.
   - Use when documents don't have the answer AND the question requires recent/external information
   - Returns titles, URLs, and content snippets
   - Always cite source URLs when using web search results

4. **ls** - List folder contents.
   - Use to explore folder structure before diving deeper
   - Shows subfolders (with [global] prefix for shared folders) and documents
   - Use folder UUIDs from results to navigate into subfolders

5. **tree** - Get hierarchical folder view.
   - Use to understand overall knowledge base organization
   - Shows nested structure with indentation
   - depth parameter controls how deep to traverse (default: 3)
   - limit parameter controls max items returned (default: 50)

6. **grep** - Search document content for patterns.
   - Use to find documents containing specific text
   - Supports regex patterns (Python syntax)
   - Optional path parameter to scope search to a folder
   - Returns matching document names with line excerpts

7. **glob** - Find documents by filename pattern.
   - Use to find files like *.pdf, report_*.docx
   - Supports wildcards: * (any chars), ? (single char), ** (recursive)
   - Examples: "*.pdf", "reports/**/*.md", "invoice_2024*"

8. **read** - Read document content.
   - Use after finding documents with grep/glob to see actual content
   - Returns full document or specific line range
   - Line numbers are 1-indexed (matching grep output)
   - Max 500 lines per request; use line range for large documents
   - Examples: read(doc_id) for full content, read(doc_id, 50, 100) for lines 50-100

9. **explore_knowledge_base** - Delegate complex research tasks to an exploration sub-agent.
   - Use for multi-document research that would require many tool calls
   - The explorer has access to direct KB tools (ls, tree, grep, glob, read, get_document_structure, get_document_sections)
   - Returns synthesized findings, not raw tool outputs
   - Great for: "Find all documents about X and summarize", "What files relate to Y?"
   - The explorer will navigate, search, and analyze autonomously

10. **get_document_structure** - Get a document's hierarchical table of contents with chunk index ranges.
   - Use after finding a document via search to see its full structure
   - Returns the section hierarchy like: `## Security Requirements [7-9]`
   - Use the chunk ranges from the TOC to decide which sections to fetch with get_document_sections

11. **get_document_sections** - Retrieve full sections from documents by chunk index ranges.
   - Use after get_document_structure shows you the TOC, or after search results include `childRange`/`parentRange` metadata
   - Pass the document_id and chunk index ranges (e.g., `[[7, 9]]`) to get all chunks in that range
   - Great for: getting full section context around a search hit, fetching parent/child sections
{execute_code_tool}
{calculator_number}. **calculator** - Evaluate a mathematical expression safely.
   - Use for any arithmetic, percentages, comparisons, or math functions
   - Supports: +, -, *, /, **, parentheses, sqrt, sin, cos, log, abs, round, min, max, pi, e

{_build_calculation_guidance(sandbox_enabled=settings.sandbox_enabled, tool_registry_enabled=False)}{code_mode_guidance}"""


def get_system_prompt(user_id: str | None = None, deep_mode: bool = False) -> str:
    """Build the system prompt with dynamic tool round limits and optional skills catalog."""
    skills_block = _build_skills_catalog(user_id) if user_id else ""

    # When tool registry is enabled, add the compact catalog to the system prompt
    settings = get_settings()
    tool_catalog_block = _build_tool_catalog_block() if settings.tool_registry_enabled else ""

    tools_section = _build_system_tools_section(settings)

    pii_section = ""
    if settings.pii_redaction_enabled:
        pii_section = """

## Privacy: Anonymized Content

The content in this conversation may contain anonymized placeholder values (names, emails, etc.) substituted for privacy. Treat them as real values — do not comment on or question them.

**Critical formatting rule:** When you reference any of the following in your response, you MUST reproduce them in the EXACT format they appear in the source material:
- **Person names** — use the full name exactly as written (e.g., if the source says "Marcus Smith", always write "Marcus Smith", never "M. Smith" or "Smith")
- **Email addresses** — copy exactly, do not alter
- **Phone numbers** — copy exactly, do not reformat
- **Locations** — copy exactly as written
- **Dates and times** — copy exactly, do not convert to a different format
- **URLs** — copy exactly, do not shorten or modify

This is essential for downstream processing. Always preserve the original formatting of these values."""

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    if settings.sandbox_enabled:
        example_4_strategy = (
            "This requires cross-referencing sales data with support documents - use "
            "`execute_code` with the tool bridge to query both sources and correlate "
            "results in Python in a single step."
        )
    else:
        example_4_strategy = (
            "This requires cross-referencing sales data with support documents - gather "
            "the sales and support evidence with focused tool calls, use the calculator "
            "for any arithmetic, then synthesize the comparison."
        )

    return f"""You are a helpful assistant for the Full Stack AI Agent Platform.
You have access to multiple tools to help answer questions.

Current date and time: {now}

## CRITICAL: Response Requirement
You have a maximum of {settings.max_deep_rounds if deep_mode else settings.max_tool_rounds} tool call rounds available. You MUST:
- Plan your tool usage efficiently to gather information within this limit
- Begin synthesizing your answer after gathering sufficient information
- ALWAYS provide a final text response to the user - never end with just a tool call
- Aim to complete your research and respond well before reaching round {settings.max_deep_rounds if deep_mode else settings.max_tool_rounds}

## Your Approach: Strategic Retrieval

Before answering any question, you MUST first develop a retrieval strategy. Think step-by-step:

1. **Analyze the Query**: What is the user actually asking? What information do I need to answer this completely?

2. **Plan Your Retrieval**: Determine which tools and queries will gather the necessary information.
   - What different angles or aspects of the question need to be explored?
   - Would multiple searches with different queries yield better coverage?
   - Does this require combining information from multiple document searches or tools?

3. **Execute Strategically**: Make multiple tool calls if needed. Don't settle for a single search if the question is complex.
   - Use different search queries to cover different aspects of the question
   - Expand into document structure and sections when search results need more context
   - Cross-reference evidence from multiple retrieved sources when relevant

4. **Synthesize**: Combine all retrieved information into a comprehensive, well-cited answer. This step is REQUIRED - you must always end with a helpful response.

{tools_section}

## Retrieval Strategy Examples

**Example 1**: User asks "What does our policy say about remote work and how does it compare to industry standards?"
- Strategy: (1) Search documents for "remote work policy", (2) Search documents for "work from home guidelines", (3) Web search for "remote work policy industry standards 2024"

**Example 2**: User asks "Analyze our Q4 sales performance"
- Strategy: (1) Query total Q4 revenue vs Q3, (2) Query top products in Q4, (3) Query regional breakdown, (4) Query month-over-month trend within Q4

**Example 3**: User asks "What training resources do we have for new employees?"
- Strategy: (1) Search for "onboarding training", (2) Search for "new employee orientation", (3) Search for "training materials resources"

**Example 4**: User asks "Compare our top 5 customers by revenue against their support ticket volume"
- Strategy: {example_4_strategy}

## Important Guidelines

- **Be thorough**: One search is rarely enough for complex questions. Plan multiple retrievals.
- **Vary your queries**: Use synonyms and different phrasings to cast a wider net.
- **Combine sources**: The best answers often synthesize information from multiple tools.
- **Always cite**: Reference specific documents, database results, or web sources in your answer.
- **Explain gaps**: If you couldn't find certain information, say so explicitly.{pii_section}{skills_block}{tool_catalog_block}{get_workspace_prompt()}{get_deep_mode_prompt() if deep_mode else ''}"""


def build_rag_tools(
    include_web_search: bool = False,
    include_sql: bool = True,
    include_analyze: bool = True,
    include_code_execution: bool = False,
) -> list[dict]:
    """
    Build tools definition with dynamic filters from metadata schema.

    Args:
        include_web_search: Whether to include web_search tool (depends on config)
        include_sql: Whether to include the query_sales_database text-to-SQL tool
            (requires a configured sql_reader DSN; off unless explicitly enabled).
        include_analyze: Whether to include analyze_document tool (default: True)

    Returns:
        List of tool definitions for the LLM
    """
    tools = []

    # 1. Document search tool (always included)
    filter_properties = {}
    try:
        schema = get_metadata_schema()
        for field in schema:
            if field.type in ("enum", "list", "string"):
                prop: dict[str, Any] = {"type": "string", "description": field.description}
                if field.type == "enum" and field.enum_values:
                    prop["enum"] = field.enum_values
                filter_properties[field.name] = prop
    except Exception as e:
        logger.warning(f"Failed to load metadata schema for tools: {e}")

    filters_param: dict[str, Any] = {
        "type": "object",
        "description": "Optional metadata filters to narrow search results. Only include filters when the user's query clearly indicates a specific category.",
        "properties": filter_properties,
    }

    tools.append({
        "type": "function",
        "function": {
            "name": "search_documents",
            "description": "Search the user's knowledge-base/document-library Documents for relevant information. Do not use for newly attached chat workspace files; use workspace tools instead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query to find relevant document content"
                    },
                    "filters": filters_param,
                    "search_mode": {
                        "type": "string",
                        "enum": ["hybrid", "vector", "keyword"],
                        "description": "Search strategy. 'hybrid' (default) combines keyword and semantic. 'keyword' for exact terms/names. 'vector' for conceptual queries."
                    },
                    "folder_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of folder UUIDs to scope search to. Used when a skill specifies scoped folders."
                    },
                },
                "required": ["query"]
            }
        }
    })

    # 2. Analyze document tool (for deep single-document analysis)
    if include_analyze:
        tools.append({
            "type": "function",
            "function": {
                "name": "analyze_document",
                "description": "Analyze a specific document in depth. Use this when the user asks to summarize, review, or extract detailed information from ONE specific document. This spawns a sub-agent that reads the full document content.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "document_id": {
                            "type": "string",
                            "description": "The UUID of the document to analyze (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). IMPORTANT: This must be the document_id UUID from search_documents results, NOT the filename. Look for 'document_id:' in search results."
                        },
                        "query": {
                            "type": "string",
                            "description": "What to analyze or extract from the document (e.g., 'summarize', 'extract key points', 'what are the main arguments?')"
                        }
                    },
                    "required": ["document_id", "query"]
                }
            }
        })

    # Calculator tool
    tools.append({
        "type": "function",
        "function": {
            "name": "calculator",
            "description": "Evaluate a mathematical expression. Supports arithmetic, exponents, parentheses, and common math functions (sqrt, sin, cos, log, abs, round, min, max, pi, e).",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "The math expression to evaluate, e.g. '(150 * 1.08) + 25' or 'sqrt(144) + 3**2'"
                    }
                },
                "required": ["expression"]
            }
        }
    })

    # 3. Web search tool (optional, depends on config)
    if include_web_search:
        tools.append({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web for current information when documents lack the answer. Use this for questions requiring recent or external information not in the user's documents.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query to find relevant web content"
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "Maximum number of results to return (default 5)",
                            "default": 5
                        }
                    },
                    "required": ["query"]
                }
            }
        })

    # 4. Text-to-SQL tool (optional demo, depends on config + sql_reader DSN)
    if include_sql:
        from app.services.sql_agent_service import get_sales_schema
        tools.append({
            "type": "function",
            "function": {
                "name": "query_sales_database",
                "description": (
                    "Run a read-only SQL SELECT query against the structured sales database "
                    "when the user asks for aggregations, counts, totals, or filtered records "
                    "that live in tabular sales data (not in uploaded documents). "
                    "Only SELECT statements are permitted; the connection is a read-only role. "
                    "Query the single available table using this schema:\n\n" + get_sales_schema()
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "sql": {
                            "type": "string",
                            "description": "A single read-only SQL SELECT statement against the sales_data table, e.g. \"SELECT region, SUM(total_amount) FROM sales_data GROUP BY region\"."
                        }
                    },
                    "required": ["sql"]
                }
            }
        })

    # 5. Navigation tools (ls and tree)
    tools.append({
        "type": "function",
        "function": {
            "name": "ls",
            "description": "List files and subfolders in a folder. Returns folder names (with IDs) and document filenames. Use this to explore the knowledge base structure before searching for specific content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Where to list: 'root' for top-level folders, a folder UUID (from previous ls/tree results), or an exact folder name to list that folder's contents."
                    }
                },
                "required": ["path"]
            }
        }
    })

    tools.append({
        "type": "function",
        "function": {
            "name": "tree",
            "description": "Get hierarchical view of folder structure. Returns a tree showing nested folders and their documents. Use this to understand the overall organization of the knowledge base.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Starting point: 'root' for entire tree, a folder UUID, or an exact folder name to show that subtree."
                    },
                    "depth": {
                        "type": "integer",
                        "description": "Maximum depth to traverse (default: 3). Higher values show more nesting but larger output."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum total items to return (default: 50). Prevents overwhelming output for large trees."
                    }
                },
                "required": ["path"]
            }
        }
    })

    # 6. grep - Search document content for patterns
    tools.append({
        "type": "function",
        "function": {
            "name": "grep",
            "description": "Search knowledge-base/document-library document content for a regex pattern. Returns matching Documents with line excerpts. Do not use for newly attached chat workspace files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regular expression pattern to search for (Python regex syntax). Examples: 'error', 'TODO.*urgent', 'api[_-]?key'"
                    },
                    "path": {
                        "type": "string",
                        "description": "Optional folder scope: 'root' for all documents, or a folder UUID to search only within that folder and its subfolders."
                    },
                    "case_sensitive": {
                        "type": "boolean",
                        "description": "Match case-sensitively (default: false for case-insensitive)"
                    }
                },
                "required": ["pattern"]
            }
        }
    })

    # 7. glob - Find documents by filename pattern
    tools.append({
        "type": "function",
        "function": {
            "name": "glob",
            "description": "Find knowledge-base/document-library Documents by filename pattern. Supports wildcards: * (any characters), ? (single character), ** (recursive into subfolders). Do not use for newly attached chat workspace files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Filename pattern with wildcards. Examples: '*.pdf' (all PDFs), 'report_*.docx' (reports), 'docs/**/*.md' (all markdown in docs folder and subfolders)"
                    }
                },
                "required": ["pattern"]
            }
        }
    })

    # 8. read - Read document content
    tools.append({
        "type": "function",
        "function": {
            "name": "read",
            "description": "Read knowledge-base/document-library Document content. Returns the full markdown text or a specific line range. Use this after finding Documents with grep, glob, or search_documents; do not use for newly attached chat workspace files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "document_id": {
                        "type": "string",
                        "description": "The document UUID to read. Get this from grep, glob, ls, or search_documents results (the 'id:' field)."
                    },
                    "start_line": {
                        "type": "integer",
                        "description": "First line to read (1-indexed). Omit to start from beginning."
                    },
                    "end_line": {
                        "type": "integer",
                        "description": "Last line to read (1-indexed, inclusive). Omit to read to end. Max 500 lines per request."
                    }
                },
                "required": ["document_id"]
            }
        }
    })

    # 9. explore_knowledge_base - Delegate exploration to sub-agent
    tools.append({
        "type": "function",
        "function": {
            "name": "explore_knowledge_base",
            "description": "Delegate a knowledge base exploration task to a specialized sub-agent. The explorer will use navigation (ls, tree), search (grep, glob), and document reading tools to research your request, then return synthesized findings. Use this for complex research tasks that require exploring multiple folders or documents.",
            "parameters": {
                "type": "object",
                "properties": {
                    "research_query": {
                        "type": "string",
                        "description": "What to research in the knowledge base. Be specific about what information you're looking for. Example: 'Find all documents related to Q4 sales and summarize the key metrics'"
                    },
                    "starting_path": {
                        "type": "string",
                        "description": "Optional folder to start exploration from. Use 'root' for entire KB, or a folder UUID to scope exploration."
                    }
                },
                "required": ["research_query"]
            }
        }
    })

    # 10. get_document_sections - Retrieve chunk ranges by hierarchical structure
    tools.append({
        "type": "function",
        "function": {
            "name": "get_document_sections",
            "description": "Retrieve specific chunk ranges from a document by chunk index. IMPORTANT: call get_document_structure on the document FIRST and use its table of contents (section titles + chunk ranges) to decide which ranges to fetch. Fetching sections without the structure means reading blind — you cannot know which sections exist, where a search hit sits in the document, or what relevant context you are missing on either side. Once you have the structure, fetch whole sections or their parent sections by chunk index range (e.g. the childRange/parentRange from search_documents). Useful for getting the full context around a search hit.",
            "parameters": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "document_id": {"type": "string", "description": "The document UUID"},
                                "chunk_ranges": {
                                    "type": "array",
                                    "items": {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 2},
                                    "description": "Array of [start, end] chunk index pairs"
                                }
                            },
                            "required": ["document_id", "chunk_ranges"]
                        },
                        "description": "Documents and chunk ranges to retrieve"
                    }
                },
                "required": ["items"]
            }
        }
    })

    # 11. get_document_structure - View a document's hierarchical table of contents
    tools.append({
        "type": "function",
        "function": {
            "name": "get_document_structure",
            "description": "Get the hierarchical structure (table of contents with chunk index ranges) of a smart-chunked document. ALWAYS call this BEFORE get_document_sections: it reveals every section and its chunk range, so you know the document's full layout and what context exists beyond a single search hit instead of fetching ranges blind. Returns the section hierarchy with chunk ranges like '## Security Requirements [7-9]', which you then pass to get_document_sections.",
            "parameters": {
                "type": "object",
                "properties": {
                    "document_id": {
                        "type": "string",
                        "description": "The document UUID"
                    }
                },
                "required": ["document_id"]
            }
        }
    })

    # 12. load_skill - Load full skill instructions
    tools.append({
        "type": "function",
        "function": {
            "name": "load_skill",
            "description": "Load full instructions for a skill when the user's request aligns with one listed in the system prompt. Returns instructions and a file listing if the skill has attached building-block files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "skill_id": {
                        "type": "string",
                        "description": "The UUID of the skill to load"
                    }
                },
                "required": ["skill_id"]
            }
        }
    })

    # 11. read_skill_file - Read a file attached to a skill
    tools.append({
        "type": "function",
        "function": {
            "name": "read_skill_file",
            "description": "Read the content of a file attached to a skill. Use after load_skill shows a file listing.",
            "parameters": {
                "type": "object",
                "properties": {
                    "skill_id": {
                        "type": "string",
                        "description": "The UUID of the skill"
                    },
                    "filename": {
                        "type": "string",
                        "description": "Exact filename from the file listing"
                    }
                },
                "required": ["skill_id", "filename"]
            }
        }
    })

    # 12. save_skill - Save a new skill
    tools.append({
        "type": "function",
        "function": {
            "name": "save_skill",
            "description": "Save a new skill to the database. Use this after guiding the user through skill creation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Skill name (lowercase, hyphens, max 64 chars)"
                    },
                    "description": {
                        "type": "string",
                        "description": "What the skill does and when to use it (third person)"
                    },
                    "instructions": {
                        "type": "string",
                        "description": "Full markdown instructions loaded when skill is activated"
                    }
                },
                "required": ["name", "description", "instructions"]
            }
        }
    })

    # 13. upload_skill_file - Upload a file to a skill
    tools.append({
        "type": "function",
        "function": {
            "name": "upload_skill_file",
            "description": "Upload a text file to a skill as a building block. Use after save_skill to attach scripts, templates, or data files the skill can reference via read_skill_file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "skill_id": {
                        "type": "string",
                        "description": "The UUID of the skill (returned by save_skill)"
                    },
                    "filename": {
                        "type": "string",
                        "description": "Filename with extension (e.g., 'template.py', 'config.json')"
                    },
                    "content": {
                        "type": "string",
                        "description": "The full text content of the file"
                    }
                },
                "required": ["skill_id", "filename", "content"]
            }
        }
    })

    # 14. execute_code - Sandboxed code execution
    if include_code_execution:
        tools.append({
            "type": "function",
            "function": {
                "name": "execute_code",
                "description": "Execute Python code in a sandboxed Docker container. ONLY Python is available — no Node.js, JavaScript, or other runtimes. Use Python libraries directly (python-pptx, python-docx, openpyxl, matplotlib, etc.) for file generation, computations, data processing, and binary workspace-file analysis. Thread workspace files are mounted read-only under /sandbox/workspace/<file_path>; write generated outputs to /sandbox/output/.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": "The Python code to execute"
                        },
                        "libraries": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Python packages to pip install. Persist in session."
                        },
                        "output_filenames": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Expected files in /sandbox/output/ to make downloadable"
                        }
                    },
                    "required": ["code"]
                }
            }
        })

    # tool_search — added when tool registry is enabled
    if get_settings().tool_registry_enabled:
        tools.append({
            "type": "function",
            "function": {
                "name": "tool_search",
                "description": "REQUIRED before using any tool from the Tool Catalog. Searches the registry and loads the tool's full schema so it becomes available for direct use. You MUST call this before calling any catalog tool — unloaded tools will fail.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Regex or keyword to search tool names and descriptions"
                        },
                        "category": {
                            "type": "string",
                            "enum": ["native", "skill", "mcp"],
                            "description": "Optional filter by tool source category"
                        }
                    },
                    "required": ["query"]
                }
            }
        })

    return tools


_WORKSPACE_TOOLS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": (
                "Create or overwrite a file in the workspace. Use for capturing notes, "
                "data, drafts, and deliverables. If a file at the path already exists, "
                "it is overwritten."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Relative path (forward slashes only, no leading /). Example: notes/research.md"
                    },
                    "content": {
                        "type": "string",
                        "description": "Text content to write (max 1MB)"
                    }
                },
                "required": ["file_path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": (
                "Read a file from the workspace. Returns text content for text files "
                "and extracted text for supported binary uploads such as PDFs. "
                "Use start_line/end_line for large files."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Relative path of the file to read"
                    },
                    "start_line": {
                        "type": "integer",
                        "description": "Optional first line to read, 1-indexed. Omit to start from the beginning."
                    },
                    "end_line": {
                        "type": "integer",
                        "description": "Optional last line to read, 1-indexed and inclusive. Omit to read to the end."
                    }
                },
                "required": ["file_path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": (
                "Edit a workspace file by replacing a string. By default, "
                "old_string must appear EXACTLY ONCE in the file — if it "
                "appears zero or more than one time, the edit fails so you "
                "can disambiguate. Include enough surrounding context in "
                "old_string to make the match unique, or pass replace_all=true "
                "to replace every occurrence. Prefer this over rewriting the "
                "entire file."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Relative path of the file to edit"
                    },
                    "old_string": {
                        "type": "string",
                        "description": (
                            "Exact string to find. Must be unique in the file "
                            "unless replace_all=true. Include surrounding "
                            "context (whole lines, leading/trailing whitespace) "
                            "if a shorter string would not be unique."
                        )
                    },
                    "new_string": {
                        "type": "string",
                        "description": "Replacement string"
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": (
                            "If true, replace every occurrence of old_string "
                            "and skip the uniqueness check. Defaults to false."
                        ),
                        "default": False
                    }
                },
                "required": ["file_path", "old_string", "new_string"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": (
                "List all files in the workspace with their path, size, type, and source."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    },
]

_DELEGATION_TOOLS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "task",
            "description": (
                "Delegate a focused task to a sub-agent with isolated context. "
                "Use for context-heavy or independent work that doesn't need your "
                "full conversation history. The sub-agent shares your workspace files."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "description": {
                        "type": "string",
                        "description": "Clear description of what the sub-agent should do"
                    },
                    "context_files": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional list of workspace file paths to pre-load into the sub-agent's context"
                    }
                },
                "required": ["description"]
            }
        }
    },
]

_PLANNING_TOOLS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "write_todos",
            "description": (
                "Replace the entire todo list for this conversation. Send the COMPLETE "
                "updated list every time — this overwrites all previous todos. Use this to "
                "plan multi-step tasks, update task statuses, add new tasks, or remove tasks. "
                "Each todo needs content (description), status (pending/in_progress/completed), "
                "and position (0-indexed ordering)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": {
                                    "type": "string",
                                    "description": "Task description"
                                },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed"],
                                    "description": "Task status"
                                },
                                "position": {
                                    "type": "integer",
                                    "description": "0-indexed ordering position"
                                }
                            },
                            "required": ["content", "status", "position"]
                        }
                    }
                },
                "required": ["todos"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_todos",
            "description": (
                "Read the current todo list for this conversation. Use this after completing "
                "a task to review your plan and decide what to do next. Returns all todos "
                "ordered by position."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "ask_user",
            "description": (
                "Pause and ask the user a clarifying question when you genuinely need "
                "information only they can provide (a missing requirement, a decision "
                "between options, confirmation before a consequential step). The turn "
                "ends after you call this and the conversation pauses until the user "
                "replies — their next message is the answer. Use sparingly; prefer "
                "acting on reasonable defaults when you can. Ask exactly one focused "
                "question at a time."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The single, specific question to put to the user."
                    }
                },
                "required": ["question"]
            }
        }
    },
]


def build_workspace_tools() -> list[dict]:
    """Return workspace tool definitions (always available when tools are enabled)."""
    return list(_WORKSPACE_TOOLS)


def build_planning_tools() -> list[dict]:
    """Return planning tool definitions (only included when deep_mode=true)."""
    return list(_PLANNING_TOOLS)


def build_delegation_tools() -> list[dict]:
    """Return delegation tool definitions (only included when deep_mode=true)."""
    return list(_DELEGATION_TOOLS)


def register_native_tools() -> None:
    """Register all native tools from build_rag_tools() into the unified tool registry."""
    from app.services.tool_registry import (
        get_tool_registry, ToolDefinition, ToolSource, ToolLoading,
    )
    from app.services.tool_executor import execute_tool_call

    registry = get_tool_registry()
    settings = get_settings()
    # query_sales_database is re-enabled when a sql_reader DSN is configured; the
    # remaining budget/HR demo tools stay disabled (no schema/handler wired).
    sql_enabled = bool(settings.sql_reader_database_url)
    disabled_demo_tools = {
        "get_team_members",
        "get_expenses",
        "get_budget_by_level",
    }
    if not sql_enabled:
        disabled_demo_tools.add("query_sales_database")
    for name in disabled_demo_tools:
        registry.unregister(name)

    # Build the full tool set with all optional tools enabled
    all_tools = build_rag_tools(
        include_web_search=settings.web_search_enabled,
        include_sql=sql_enabled,
        include_analyze=True,
        include_code_execution=settings.sandbox_enabled,
    )
    all_tools.extend(build_workspace_tools())

    # Tools that should be deferred (discovered via tool_search, not sent in every call)
    deferred_tools = {"save_skill", "upload_skill_file", "calculator"}

    for tool_schema in all_tools:
        func = tool_schema.get("function", {})
        name = func.get("name", "")
        description = func.get("description", "")
        # One-liner for catalog: first sentence, truncated at word boundary
        first_sentence = description.split(". ")[0].rstrip(".")
        if len(first_sentence) > 100:
            catalog_entry = first_sentence[:97].rsplit(" ", 1)[0] + "..."
        else:
            catalog_entry = first_sentence
        catalog_entry = catalog_entry.replace("|", "\\|")

        loading = ToolLoading.deferred if name in deferred_tools else ToolLoading.immediate

        registry.register(ToolDefinition(
            name=name,
            description=description,
            source=ToolSource.native,
            loading=loading,
            openai_schema=tool_schema,
            catalog_entry=catalog_entry,
            executor=execute_tool_call,
        ))

    logger.info(f"Registered {registry.tool_count} native tools in registry")


def get_global_llm_settings() -> dict[str, Any]:
    """
    Get global LLM settings from environment config.

    Returns dict with keys: model, base_url, api_key
    Raises HTTPException(503) if no API key is configured.
    """
    settings = get_settings()

    if not settings.llm_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LLM not configured. Set LLM_API_KEY in environment variables."
        )

    return {
        "model": settings.llm_model or "gpt-4o",
        "base_url": settings.llm_base_url or None,
        "api_key": settings.llm_api_key,
    }


def get_sub_agent_llm_settings() -> dict[str, Any]:
    """
    Get LLM settings for sub-agents.

    Returns sub-agent-specific config when set, otherwise falls back to
    the primary LLM settings.
    """
    settings = get_settings()
    global_settings = get_global_llm_settings()  # also validates api_key

    # If a custom base_url is set, require a matching api_key to avoid
    # leaking the primary key to a different provider.
    if settings.sub_agent_base_url and not settings.sub_agent_api_key:
        logger.warning(
            "SUB_AGENT_BASE_URL is set without SUB_AGENT_API_KEY — "
            "falling back to primary LLM settings to avoid credential mismatch"
        )
        return global_settings

    return {
        "model": settings.sub_agent_model or global_settings["model"],
        "base_url": settings.sub_agent_base_url or global_settings["base_url"],
        "api_key": settings.sub_agent_api_key or global_settings["api_key"],
    }


def _codex_enabled_for(role: str) -> bool:
    """Whether LLM_PROVIDER=codex should route this role through the Codex
    (ChatGPT subscription) backend.

    User-facing chat and sub-agent loops follow the provider selection. The
    SUB_AGENT_* settings still apply to the OpenAI-compatible path, but when
    Codex is selected these calls use CODEX_MODEL.
    """
    settings = get_settings()
    # getattr-based access so partial settings mocks in unit tests (which only
    # stub the fields they exercise) don't blow up on the provider check.
    if (getattr(settings, "llm_provider", "") or "").lower() != "codex":
        return False
    return True


def codex_chat_client_for(
    role: str,
    llm_settings: dict[str, Any] | None = None,
    reasoning_effort: str | None = None,
):
    """Return a Codex chat client when enabled for `role`, else None.

    The client mirrors AsyncOpenAI's ``chat.completions.create`` interface, so a
    call site can use it interchangeably with ``get_traced_async_openai_client``:

        client = codex_chat_client_for("agent", llm_settings) or \\
            get_traced_async_openai_client(base_url=..., api_key=...)

    When ``llm_settings`` is given, its ``"model"`` is rewritten to the Codex
    model so the caller's request uses it. ``reasoning_effort`` (when provided)
    overrides CODEX_REASONING_EFFORT for this request — e.g. the composer's
    per-message "thinking" selection. Returning None keeps the existing
    (OpenAI-compatible) path — and its mockable symbols — completely unchanged.
    """
    if not _codex_enabled_for(role):
        return None
    from app.services.codex_client import build_codex_chat_client

    model = getattr(get_settings(), "codex_model", None)
    if llm_settings is not None and model:
        llm_settings["model"] = model
    return build_codex_chat_client(model=model, reasoning_effort=reasoning_effort)


def build_reasoning_request(
    base_url: str | None,
    style: str,
    thinking: bool,
    effort: str | None,
) -> dict[str, Any]:
    """
    Translate the per-request "thinking" toggle into provider-specific request
    kwargs to merge into chat.completions.create(...).

    The app uses a single env-configured base_url, so the reasoning param shape
    is inferred from the provider ("auto") unless LLM_REASONING_STYLE pins it.
    Returns {} when thinking is off or the provider takes no reasoning param
    (local reasoning models typically emit inline <think> without a request flag).
    """
    if not thinking:
        return {}

    eff = effort if effort in ("low", "medium", "high") else "medium"

    resolved = style
    if resolved == "auto":
        bu = (base_url or "").lower()
        if "openrouter" in bu:
            resolved = "openrouter"
        elif bu == "" or "api.openai.com" in bu or "openai.azure" in bu:
            resolved = "openai"
        else:
            resolved = "none"

    if resolved == "openrouter":
        # OpenRouter's unified reasoning field, normalized across providers.
        return {"extra_body": {"reasoning": {"effort": eff}}}
    if resolved == "openai":
        # OpenAI reasoning models take a top-level reasoning_effort.
        return {"reasoning_effort": eff}
    # "none" / unknown — omit to avoid 400s on providers that reject the param.
    return {}


def _reduce_chat_events(events: list) -> dict:
    """Reduce chat SSE events to a summary for LangSmith tracing."""
    for event in reversed(events):
        if isinstance(event, dict):
            if event.get("type") == "response_completed":
                content = event.get("content", "")
                return {"response": content[:500]}
            if event.get("type") == "tool_calls":
                return {"tool_calls": [tc.get("name") for tc in event.get("tool_calls", [])]}
            if event.get("type") == "error":
                return {"error": event.get("error", "")}
    return {"events": len(events)}


@traceable(name="llm_chat_completion", run_type="llm", reduce_fn=_reduce_chat_events)
async def astream_chat_response(
    messages: list[dict],
    tools: list[dict] | None = None,
    user_id: str | None = None,
    deep_mode: bool = False,
    system_prompt: str | None = None,
    response_format: dict | None = None,
    model_override: str | None = None,
    thinking: bool = False,
    reasoning_effort: str | None = None,
    tool_choice: str | dict | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    """
    Stream a chat response using the ChatCompletions API.

    Args:
        messages: List of message dicts with 'role' and 'content' keys
        tools: Optional list of tool definitions for function calling
        user_id: Optional user ID to include skills catalog in system prompt
        deep_mode: Whether to include deep mode instructions in system prompt
        model_override: Per-request model name (UI-selected via the composer).
            Falls back to the env LLM_MODEL when empty/None.
        thinking: Whether to enable provider reasoning for this request.
        reasoning_effort: Effort ("low"|"medium"|"high") when thinking is on.

    Yields:
        Event dicts with 'type' and additional data
    """
    # When the user enables "thinking", drive Codex's reasoning effort from the
    # per-message selection (default medium); when off, fall back to the
    # CODEX_REASONING_EFFORT env default.
    codex_effort = (reasoning_effort or "medium") if thinking else None
    codex_client = codex_chat_client_for("primary", reasoning_effort=codex_effort)
    if codex_client is not None:
        # Codex path: don't require an OpenAI-compatible key just to start.
        client = codex_client
        llm_settings = {"base_url": None}
        model = model_override or get_settings().codex_model
    else:
        llm_settings = get_global_llm_settings()
        model = model_override or llm_settings["model"]
        client = get_traced_async_openai_client(
            base_url=llm_settings["base_url"],
            api_key=llm_settings["api_key"],
        )

    request_kwargs: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "system", "content": system_prompt if system_prompt is not None else get_system_prompt(user_id=user_id, deep_mode=deep_mode)}, *messages],
        "stream": True,
        # Request token usage on the final stream chunk. Providers that don't
        # support this will either ignore it silently or omit usage data;
        # downstream code handles missing usage gracefully (usage_data stays None).
        "stream_options": {"include_usage": True},
    }
    if tools:
        request_kwargs["tools"] = tools
        # tool_choice only makes sense when tools are present. Used to force a
        # specific tool (e.g. require search_documents on round 1) so a RAG
        # answer is grounded by default instead of relying on the model
        # voluntarily retrieving.
        if tool_choice is not None:
            request_kwargs["tool_choice"] = tool_choice
    if response_format:
        request_kwargs["response_format"] = response_format
    # Map the per-request "thinking" toggle to the active provider's reasoning
    # param (no-op when off). Codex applies reasoning at the client (above, via
    # reasoning_effort), so only the OpenAI-compatible path needs this here.
    if codex_client is None:
        request_kwargs.update(
            build_reasoning_request(
                llm_settings["base_url"],
                get_settings().llm_reasoning_style,
                thinking,
                reasoning_effort,
            )
        )

    stream = None
    try:
        stream = await client.chat.completions.create(**request_kwargs)

        full_response = ""
        tool_calls_buffer: dict[int, dict] = {}
        tool_calls_announced: set[int] = set()  # track which tool calls have been announced
        finish_reason = None
        usage_data = None
        think_open = False  # streaming OpenRouter's reasoning as a <think> block

        def _close_think() -> dict | None:
            """Emit the closing </think> tag if a reasoning block is open."""
            nonlocal think_open, full_response
            if think_open:
                think_open = False
                full_response += "</think>"
                return {"type": "text_delta", "content": "</think>"}
            return None

        async for chunk in stream:
            # Capture usage from the final chunk (sent when stream_options.include_usage is set)
            if hasattr(chunk, 'usage') and chunk.usage:
                usage_data = {
                    "type": "usage",
                    "prompt_tokens": chunk.usage.prompt_tokens,
                    "completion_tokens": chunk.usage.completion_tokens,
                    "total_tokens": chunk.usage.total_tokens,
                }

            delta = chunk.choices[0].delta if chunk.choices else None
            # Only update finish_reason when set (some providers send
            # extra trailing chunks with finish_reason=None).
            chunk_finish = chunk.choices[0].finish_reason if chunk.choices else None
            if chunk_finish:
                finish_reason = chunk_finish

            # OpenRouter (and other OpenAI-compatible reasoning models) return
            # reasoning in a separate `reasoning` delta field, not as <think>
            # tags in content. Wrap it inline so the frontend's existing
            # "Thought process" panel (parseTextWithThinking) renders it.
            reasoning_delta = getattr(delta, "reasoning", None) if delta else None
            if reasoning_delta:
                if not think_open:
                    think_open = True
                    full_response += "<think>"
                    yield {"type": "text_delta", "content": "<think>"}
                full_response += reasoning_delta
                yield {"type": "text_delta", "content": reasoning_delta}

            if delta and delta.content:
                closer = _close_think()
                if closer:
                    yield closer
                full_response += delta.content
                yield {"type": "text_delta", "content": delta.content}

            if delta and delta.tool_calls:
                closer = _close_think()
                if closer:
                    yield closer
                for tc in delta.tool_calls:
                    idx = tc.index
                    if idx not in tool_calls_buffer:
                        tool_calls_buffer[idx] = {
                            "id": tc.id,
                            "name": tc.function.name if tc.function else None,
                            "arguments": "",
                        }
                    else:
                        if tc.id:
                            tool_calls_buffer[idx]["id"] = tc.id
                        if tc.function and tc.function.name:
                            tool_calls_buffer[idx]["name"] = tc.function.name
                    if tc.function and tc.function.arguments:
                        tool_calls_buffer[idx]["arguments"] += tc.function.arguments

                    # Announce tool call as soon as we know its name, so the
                    # frontend can show a "running" indicator immediately
                    # instead of waiting for all arguments to finish streaming.
                    buf = tool_calls_buffer[idx]
                    if buf["name"] and idx not in tool_calls_announced:
                        tool_calls_announced.add(idx)
                        yield {"type": "tool_call_pending", "name": buf["name"]}

                    # Stream argument deltas so the frontend can show a live
                    # preview (e.g. code being generated for execute_code).
                    if tc.function and tc.function.arguments and idx in tool_calls_announced:
                        yield {
                            "type": "tool_call_delta",
                            "name": buf["name"],
                            "arguments_delta": tc.function.arguments,
                        }

            if finish_reason == "tool_calls" and usage_data:
                yield usage_data
                yield {"type": "tool_calls", "tool_calls": list(tool_calls_buffer.values())}
                break

            if finish_reason == "stop" and usage_data:
                closer = _close_think()
                if closer:
                    yield closer
                yield usage_data
                yield {"type": "response_completed", "content": full_response}
                break

        # If we exited the loop without usage data (provider didn't send it),
        # still yield the completion/tool_calls event
        closer = _close_think()
        if closer:
            yield closer
        if finish_reason == "tool_calls" and not usage_data:
            yield {"type": "tool_calls", "tool_calls": list(tool_calls_buffer.values())}
        elif finish_reason == "stop" and not usage_data:
            yield {"type": "response_completed", "content": full_response}

    except GeneratorExit:
        # Client disconnected mid-stream — stop quietly. The finally block
        # below closes the underlying provider stream.
        return
    except HTTPException:
        raise
    except Exception as e:
        yield {"type": "error", "error": str(e)}
    finally:
        if stream is not None:
            # The OpenAI SDK returns an AsyncStream (.close), while the codex
            # path yields a raw async generator (.aclose). Close whichever
            # cleanup method this provider's stream exposes.
            closer = getattr(stream, "aclose", None) or getattr(stream, "close", None)
            if closer is not None:
                try:
                    await closer()
                except Exception:
                    pass
