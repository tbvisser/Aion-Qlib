"""Explorer sub-agent service for knowledge base exploration."""
import asyncio
import json
import logging
from typing import AsyncGenerator, Any

from app.db.supabase import get_supabase_client
from app.services.folder_navigation import (
    execute_ls,
    execute_tree,
    execute_grep,
    execute_glob,
    execute_read,
)
from app.services.llm_service import (
    CODEX_SUB_AGENT_REASONING_EFFORT,
    get_global_llm_settings,
    codex_chat_client_for,
)
from app.services.langsmith import get_traced_async_openai_client, traceable
from app.services.citation_service import (
    CitationContext,
    inline_label_result,
    spans_from_document_sections,
    spans_from_document_structure,
    spans_from_grep_result,
    spans_from_read_result,
)

logger = logging.getLogger(__name__)

# Maximum number of tool call rounds for the explorer
MAX_ROUNDS = 8


def _label_citation_evidence(result: str, aliases) -> str:
    # Plan 23 A3: inject {[S#]} markers inline into the result (content shown
    # once) instead of prepending a re-quoted evidence block.
    return inline_label_result(result, aliases)


def _document_titles_by_id(supabase, document_ids: set[str]) -> dict[str, str]:
    if not document_ids:
        return {}
    try:
        result = supabase.table("documents").select("id, filename").in_(
            "id", list(document_ids)
        ).execute()
        return {
            str(row["id"]): row.get("filename") or "document"
            for row in (result.data or [])
        }
    except Exception as e:
        logger.warning(f"[CITATION] failed to load explorer document titles: {e}")
        return {}

EXPLORER_SYSTEM_PROMPT = """You are a knowledge base exploration specialist. Your job is to research a specific topic by navigating and searching the user's document collection, then synthesize your findings.

## Your Tools

1. **ls(path)** - List folder contents. Use to see what's in a folder.
2. **tree(path, depth, limit)** - Get hierarchical view. Use to understand structure.
3. **grep(pattern, path, case_sensitive)** - Search content for patterns. Use to find relevant text.
4. **glob(pattern)** - Find files by name pattern. Use to locate specific file types.
5. **read(document_id, start_line, end_line)** - Read document content. Use for detailed review.
6. **get_document_structure(document_id)** - Inspect a document's section structure and chunk ranges.
7. **get_document_sections(items)** - Retrieve section/chunk ranges for fuller context.

## Your Approach

1. **Understand the Request**: What specific information is the user looking for?
2. **Explore Structure**: Use tree or ls to understand organization
3. **Search for Relevance**: Use grep/glob to find relevant documents
4. **Deep Dive**: For detailed content, call get_document_structure FIRST to see a document's full table of contents, THEN get_document_sections to pull the relevant ranges (and read for line-level detail). Fetching sections before the structure means you don't know what you're missing.
5. **Synthesize**: Combine findings into a clear summary

## Critical Rules

- You have a maximum of 8 tool call rounds. Plan efficiently.
- Start broad (tree/ls), then narrow (grep/glob), then deep (read/sections).
- Do not call other sub-agents. You already are the sub-agent for this task.
- Don't include raw tool outputs in your final response - synthesize them.
- Focus on the user's specific research query.
- If you can't find relevant information, say so clearly.
- Cite supporting evidence inline using the exact {[S#]} tokens shown next to passages in tool results.
- Do not invent citation tokens; omit citations when no supplied token supports a claim.

## Output Format

After exploration, provide your findings as:
- **Summary**: 2-3 sentence overview
- **Key Documents**: Most relevant documents found (max 5)
- **Key Findings**: Important information discovered (bullet points)
- **Gaps**: What you couldn't find (if applicable)
"""


def build_explorer_tools() -> list[dict]:
    """Build tool definitions available to the explorer sub-agent."""
    return [
        {
            "type": "function",
            "function": {
                "name": "ls",
                "description": "List folder contents (subfolders and documents).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "'root', a folder UUID, or an exact folder name"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "tree",
                "description": "Get hierarchical folder view.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "'root', a folder UUID, or an exact folder name"},
                        "depth": {"type": "integer", "description": "Max depth (default 3)"},
                        "limit": {"type": "integer", "description": "Max items (default 50)"}
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "grep",
                "description": "Search document content for regex pattern.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "Regex pattern"},
                        "path": {"type": "string", "description": "Scope to folder (optional)"},
                        "case_sensitive": {"type": "boolean", "description": "Case sensitive (default false)"}
                    },
                    "required": ["pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "glob",
                "description": "Find documents by filename pattern.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "Filename pattern with wildcards"}
                    },
                    "required": ["pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read",
                "description": "Read document content by ID. Returns full markdown or line range.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "document_id": {"type": "string", "description": "Document UUID"},
                        "start_line": {"type": "integer", "description": "Start line (optional)"},
                        "end_line": {"type": "integer", "description": "End line (optional)"}
                    },
                    "required": ["document_id"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_document_sections",
                "description": "Retrieve specific chunk ranges from a document by chunk index. IMPORTANT: call get_document_structure first and use its table of contents to choose which ranges to fetch — fetching sections without the structure means reading blind (you won't know which sections exist or what context you're missing on either side). Then fetch whole sections or parent sections by chunk index range.",
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
        },
        {
            "type": "function",
            "function": {
                "name": "get_document_structure",
                "description": "Get the hierarchical structure (table of contents with chunk index ranges) of a document. ALWAYS call this before get_document_sections so you know the document's full layout and what context exists beyond a single hit, instead of fetching ranges blind.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "document_id": {"type": "string", "description": "The document UUID"}
                    },
                    "required": ["document_id"]
                }
            }
        }
    ]


@traceable(name="execute_explorer_tool", run_type="tool")
async def execute_explorer_tool(
    tool_name: str,
    arguments: dict,
    supabase,
    user_id: str,
    redaction_svc=None,
    citation_context: CitationContext | None = None,
) -> str | AsyncGenerator:
    """
    Execute a tool call from within the explorer agent.

    Args:
        tool_name: Name of the tool to execute
        arguments: Tool arguments dict
        supabase: Supabase client with user context
        user_id: User ID for access control

    Returns:
        String result.
    """
    if tool_name == "ls":
        return await execute_ls(arguments.get("path", "root"), supabase, user_id)

    if tool_name == "tree":
        path = arguments.get("path", "root")
        depth = min(max(arguments.get("depth", 3), 1), 10)
        limit = min(max(arguments.get("limit", 50), 10), 200)
        return await execute_tree(path, supabase, user_id, depth, limit)

    if tool_name == "grep":
        pattern = arguments.get("pattern", "")
        if not pattern:
            return "Error: No search pattern provided."
        path = arguments.get("path", "root")
        case_sensitive = arguments.get("case_sensitive", False)
        result = await execute_grep(pattern, supabase, user_id, path, case_sensitive)
        if citation_context is not None:
            try:
                aliases = citation_context.register_spans(spans_from_grep_result(result))
                result = _label_citation_evidence(result, aliases)
            except Exception as cite_err:
                logger.warning(f"[CITATION] failed to register explorer grep spans: {cite_err}")
        return result

    if tool_name == "glob":
        pattern = arguments.get("pattern", "")
        if not pattern:
            return "Error: No filename pattern provided."
        return await execute_glob(pattern, supabase, user_id)

    if tool_name == "read":
        document_id = arguments.get("document_id", "")
        if not document_id:
            return "Error: No document_id provided."
        start_line = arguments.get("start_line")
        end_line = arguments.get("end_line")
        result = await execute_read(document_id, supabase, user_id, start_line, end_line)
        if citation_context is not None and not result.startswith("Error:"):
            try:
                aliases = citation_context.register_spans(
                    spans_from_read_result(result, document_id=document_id)
                )
                result = _label_citation_evidence(result, aliases)
            except Exception as cite_err:
                logger.warning(f"[CITATION] failed to register explorer read spans: {cite_err}")
        return result

    if tool_name == "analyze_document":
        return (
            "Error: analyze_document cannot be called from inside the Explorer "
            "sub-agent. Use read, get_document_structure, or "
            "get_document_sections directly instead."
        )

    if tool_name == "get_document_sections":
        items = arguments.get("items", [])
        if not items:
            return "Error: No items provided."
        input_data = []
        for item in items:
            doc_id = item.get("document_id", "")
            ranges = item.get("chunk_ranges", [])
            if doc_id and ranges:
                input_data.append({"document_id": doc_id, "chunk_ranges": ranges})
        if not input_data:
            return "Error: No valid document/range pairs provided."
        result = supabase.rpc("get_chunks_by_ranges", {
            "p_input_data": input_data,
            "p_user_id": user_id,
        }).execute()
        data = result.data or []
        if not data:
            return "No chunks found for the specified ranges."
        formatted = []
        for chunk in data:
            body = chunk.get("citable_text") or chunk["content"]
            formatted.append(f"[doc:{chunk['document_id']} chunk:{chunk['chunk_index']}]\n{body}")
        formatted_result = "\n\n---\n\n".join(formatted)
        if citation_context is not None:
            try:
                aliases = citation_context.register_spans(
                    spans_from_document_sections(
                        data,
                        title_by_document_id=_document_titles_by_id(
                            supabase,
                            {str(chunk.get("document_id")) for chunk in data if chunk.get("document_id")},
                        ),
                    )
                )
                formatted_result = _label_citation_evidence(formatted_result, aliases)
            except Exception as cite_err:
                logger.warning(f"[CITATION] failed to register explorer section spans: {cite_err}")
        return formatted_result

    if tool_name == "get_document_structure":
        doc_id = arguments.get("document_id", "")
        if not doc_id:
            return "Error: No document_id provided."
        result = supabase.table("documents").select(
            "hierarchical_index, filename"
        ).eq("id", doc_id).eq("user_id", user_id).maybe_single().execute()
        if not result.data:
            return "Error: Document not found or access denied."
        hierarchy = result.data.get("hierarchical_index")
        if not hierarchy:
            return f"Document '{result.data.get('filename', doc_id)}' has no hierarchical structure."
        formatted_result = f"Structure for '{result.data.get('filename', doc_id)}':\n\n{hierarchy}"
        if citation_context is not None:
            try:
                aliases = citation_context.register_spans(
                    spans_from_document_structure(
                        hierarchy,
                        document_id=doc_id,
                        title=result.data.get("filename", doc_id),
                    )
                )
                formatted_result = _label_citation_evidence(formatted_result, aliases)
            except Exception as cite_err:
                logger.warning(f"[CITATION] failed to register explorer structure spans: {cite_err}")
        return formatted_result

    return f"Error: Unknown tool '{tool_name}'"


def get_tool_result_summary(tool_name: str, result: str) -> str:
    """
    Get brief summary of tool result for event streaming.

    Args:
        tool_name: Name of the tool that was executed
        result: Full result string from the tool

    Returns:
        Brief summary suitable for UI display
    """
    if tool_name == "ls":
        # Count folders and documents from output
        lines = result.split("\n")
        folders = sum(1 for line in lines if line.strip().endswith("/"))
        docs = sum(1 for line in lines if "(" and "id:" in line and not line.strip().endswith("/"))
        return f"Listed {folders} folders and {docs} documents"

    if tool_name == "tree":
        # Count total items
        lines = [line for line in result.split("\n") if line.strip()]
        return f"Displayed tree with {len(lines)} items"

    if tool_name == "grep":
        # Extract document count from output
        if "No documents found" in result:
            return "No documents matched pattern"
        try:
            # Parse "Found N document(s)" from first line
            first_line = result.split("\n")[0]
            if "Found" in first_line:
                count = first_line.split()[1]
                return f"Found {count} documents matching pattern"
        except (IndexError, ValueError):
            pass
        return "Grep search complete"

    if tool_name == "glob":
        # Extract document count from output
        if "No documents found" in result:
            return "No documents matched pattern"
        try:
            first_line = result.split("\n")[0]
            if "Found" in first_line:
                count = first_line.split()[1]
                return f"Found {count} documents matching pattern"
        except (IndexError, ValueError):
            pass
        return "Glob search complete"

    if tool_name == "read":
        # Extract line count from header
        if "Error:" in result:
            return "Read failed"
        try:
            lines = result.split("\n")
            # Count actual content lines (skip header)
            content_lines = len([l for l in lines[2:] if l.strip()])
            return f"Read {content_lines} lines from document"
        except (IndexError, ValueError):
            pass
        return "Read document content"

    return "Tool execution complete"


def _reduce_explorer_events(events: list) -> dict:
    """Reduce explorer SSE events to a summary for LangSmith tracing."""
    for event in reversed(events):
        if isinstance(event, dict):
            if event.get("type") == "explorer_complete":
                return {"findings": event.get("findings", "")[:500]}
            if event.get("type") == "explorer_error":
                return {"error": event.get("error", "")}
    return {"events": len(events)}


@traceable(name="explorer_agent", run_type="chain", reduce_fn=_reduce_explorer_events)
async def run_explorer_agent(
    research_query: str,
    user_id: str,
    starting_path: str = "root",
    redaction_svc=None,
    citation_context: CitationContext | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    """
    Run explorer sub-agent with internal tool loop.

    This spawns an isolated agent that explores the knowledge base using
    direct knowledge-base tools and returns synthesized findings. Explorer
    does not call nested sub-agents.

    Args:
        research_query: What to research in the knowledge base
        user_id: UUID of the user (for access control)
        starting_path: Where to start exploration ('root', a folder UUID, or an exact folder name)

    Yields:
        SSE event dicts:
        - explorer_start: {research_query, starting_path}
        - explorer_tool_call: {tool_name, arguments, round}
        - explorer_tool_result: {tool_name, result_summary}
        - explorer_reasoning: {content}
        - explorer_complete: {findings}
        - explorer_error: {error}
    """
    # Signal start
    yield {
        "type": "explorer_start",
        "research_query": research_query,
        "starting_path": starting_path
    }

    # Build initial messages (anonymize query if redaction is active)
    raw_query_content = f"Research this topic in the knowledge base:\n\n{research_query}\n\nStart exploring from: {starting_path}"
    if redaction_svc:
        anon_query_content = await redaction_svc.anonymize(raw_query_content)
    else:
        anon_query_content = raw_query_content

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": EXPLORER_SYSTEM_PROMPT},
        {"role": "user", "content": anon_query_content}
    ]

    explorer_tools = build_explorer_tools()
    supabase = get_supabase_client()

    llm_settings: dict[str, Any] = {}
    client = codex_chat_client_for(
        "agent",
        llm_settings,
        reasoning_effort=CODEX_SUB_AGENT_REASONING_EFFORT,
    )
    if client is None:
        llm_settings = get_global_llm_settings()
        client = get_traced_async_openai_client(
            base_url=llm_settings["base_url"],
            api_key=llm_settings["api_key"]
        )

    round_num = 0

    try:
        while round_num < MAX_ROUNDS:
            round_num += 1

            # Add round reminder after round 5
            if round_num > 5:
                messages.append({
                    "role": "system",
                    "content": f"Round {round_num} of {MAX_ROUNDS}. Please begin synthesizing your findings."
                })

            # Call LLM with tools
            stream = await client.chat.completions.create(
                model=llm_settings["model"],
                messages=messages,
                tools=explorer_tools,
                stream=True
            )

            # Process stream
            full_response = ""
            tool_calls_buffer: dict[int, dict] = {}
            finish_reason = None

            async for chunk in stream:
                delta = chunk.choices[0].delta if chunk.choices else None
                # Only update finish_reason when set (some providers send
                # extra trailing chunks with finish_reason=None that would
                # overwrite the real value).
                chunk_finish = chunk.choices[0].finish_reason if chunk.choices else None
                if chunk_finish:
                    finish_reason = chunk_finish

                if delta and delta.content:
                    full_response += delta.content
                    yield {
                        "type": "explorer_reasoning",
                        "content": delta.content
                    }

                if delta and delta.tool_calls:
                    # Buffer tool calls (same pattern as llm_service.py)
                    for tc in delta.tool_calls:
                        idx = tc.index
                        if idx not in tool_calls_buffer:
                            tool_calls_buffer[idx] = {
                                "id": tc.id,
                                "name": tc.function.name if tc.function else None,
                                "arguments": ""
                            }
                        else:
                            if tc.id:
                                tool_calls_buffer[idx]["id"] = tc.id
                            if tc.function and tc.function.name:
                                tool_calls_buffer[idx]["name"] = tc.function.name
                        if tc.function and tc.function.arguments:
                            tool_calls_buffer[idx]["arguments"] += tc.function.arguments

            if finish_reason == "stop":
                if redaction_svc:
                    deanon_findings = await redaction_svc.deanonymize_llm_response(full_response)
                else:
                    deanon_findings = full_response
                yield {
                    "type": "explorer_complete",
                    "findings": deanon_findings
                }
                return

            if finish_reason == "tool_calls":
                # Build assistant message with tool_calls
                assistant_message: dict[str, Any] = {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": tc["id"],
                            "type": "function",
                            "function": {
                                "name": tc["name"],
                                "arguments": tc["arguments"]
                            }
                        }
                        for tc in tool_calls_buffer.values()
                    ]
                }
                messages.append(assistant_message)

                # Execute all Explorer tools directly. Nested sub-agents are
                # intentionally unavailable inside Explorer.
                all_tcs = list(tool_calls_buffer.values())
                simple_tcs = all_tcs

                def _parse_args(tc):
                    """Parse and de-anonymize tool arguments."""
                    try:
                        raw_args_str = tc["arguments"] if tc["arguments"] else "{}"
                    except (TypeError, KeyError):
                        raw_args_str = "{}"
                    if redaction_svc:
                        deanon_args_str = redaction_svc.deanonymize(raw_args_str)
                    else:
                        deanon_args_str = raw_args_str
                    try:
                        return json.loads(deanon_args_str)
                    except json.JSONDecodeError:
                        return {}

                # Emit start events for all tools upfront
                parsed_args_map = {}
                for tc in all_tcs:
                    args = _parse_args(tc)
                    parsed_args_map[tc["id"]] = args
                    yield {
                        "type": "explorer_tool_call",
                        "tool_name": tc["name"],
                        "arguments": args,
                        "round": round_num
                    }

                # --- Execute simple tools in parallel ---
                if simple_tcs:
                    async def _run_explorer_simple(tc_item):
                        return await execute_explorer_tool(
                            tc_item["name"],
                            parsed_args_map[tc_item["id"]],
                            supabase,
                            user_id,
                            redaction_svc=redaction_svc,
                            citation_context=citation_context,
                        )

                    if len(simple_tcs) > 1:
                        logger.info(f"[EXPLORER] Parallel-executing {len(simple_tcs)} simple tools: {[tc['name'] for tc in simple_tcs]}")
                        simple_results = await asyncio.gather(
                            *[_run_explorer_simple(tc) for tc in simple_tcs]
                        )
                    else:
                        simple_results = [await _run_explorer_simple(simple_tcs[0])]

                    for tc, result in zip(simple_tcs, simple_results):
                        # Anonymize tool result before adding to explorer's LLM context
                        if redaction_svc:
                            anon_result = await redaction_svc.anonymize(result)
                        else:
                            anon_result = result

                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc["id"],
                            "content": anon_result
                        })

                        yield {
                            "type": "explorer_tool_result",
                            "tool_name": tc["name"],
                            "result_summary": get_tool_result_summary(tc["name"], result)
                        }

        # Max rounds reached - force synthesis
        messages.append({
            "role": "system",
            "content": "Maximum exploration rounds reached. Please synthesize your findings now."
        })

        final_stream = await client.chat.completions.create(
            model=llm_settings["model"],
            messages=messages,
            stream=True
            # No tools - force text response
        )

        final_response = ""
        async for chunk in final_stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                final_response += delta.content
                yield {"type": "explorer_reasoning", "content": delta.content}

        if redaction_svc:
            deanon_final = await redaction_svc.deanonymize_llm_response(final_response)
        else:
            deanon_final = final_response

        yield {
            "type": "explorer_complete",
            "findings": deanon_final
        }

    except Exception as e:
        logger.error(f"Explorer agent error: {e}")
        yield {
            "type": "explorer_error",
            "error": str(e)
        }
