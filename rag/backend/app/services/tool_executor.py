"""Tool execution dispatcher."""
import json
import logging
import mimetypes
import re
from datetime import datetime, timezone
from typing import AsyncGenerator, Any, Union

from app import config as app_config
from app.services.retrieval_service import search_documents
from app.services.web_search_service import web_search, format_search_results
from app.services.sub_agent_service import run_sub_agent
from app.services.explorer_agent_service import run_explorer_agent
from app.services.folder_navigation import execute_ls, execute_tree, execute_grep, execute_glob, execute_read
from app.services.langsmith import traceable
from app.services.citation_service import (
    CitationContext,
    inline_label_result,
    spans_from_document_sections,
    spans_from_grep_result,
    spans_from_read_result,
    spans_from_search_chunks,
    register_web_results,
    spans_from_workspace_file,
    sanitize_unowned_aliases,
)
from app.db.supabase import get_supabase_client

logger = logging.getLogger(__name__)


def _citation_neutral_result(result: str, citation_context: CitationContext | None) -> str:
    if citation_context is None:
        return result
    return sanitize_unowned_aliases(result, set())


def _clean_metadata_filter(filters: Any) -> dict | None:
    """Sanitize a model-supplied metadata filter before it hits the DB.

    Models (notably gpt-5.x) tend to fully populate the *optional* ``filters``
    object — empty strings for every field plus the ``"other"`` catch-all
    document_type — even when the user asked for no filtering. Passed through
    verbatim these become a JSONB containment filter (``metadata @> filter``)
    that matches zero chunks. We keep only concrete, meaningful values; an
    all-empty / default-only filter collapses to None (no filtering).
    """
    if not isinstance(filters, dict):
        return None
    cleaned: dict[str, Any] = {}
    for key, value in filters.items():
        if value is None:
            continue
        if isinstance(value, str):
            v = value.strip()
            if not v:
                continue
            # "other" is the uncategorized catch-all, not a real filter intent.
            if key == "document_type" and v.lower() == "other":
                continue
            cleaned[key] = v
        elif isinstance(value, (list, dict)):
            if not value:  # drop empty [] / {}
                continue
            cleaned[key] = value
        else:
            cleaned[key] = value
    return cleaned or None


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
        logger.warning(f"[CITATION] failed to load document titles: {e}")
        return {}


@traceable(name="execute_tool_call", run_type="tool")
async def execute_tool_call(
    tool_call: dict, user_id: str, redaction_svc=None, thread_id: str | None = None,
    tools: list[dict] | None = None, citation_context: CitationContext | None = None,
    sub_agent_depth: int = 0,
) -> Union[str, AsyncGenerator[dict[str, Any], None]]:
    """
    Execute a tool call and return the result.

    Args:
        tool_call: Dict with 'name' and 'arguments' keys
        user_id: The user's ID for context

    Returns:
        Tool result as a string, or an AsyncGenerator for streaming tools (like analyze_document)
    """
    name = tool_call["name"]
    raw_args = tool_call["arguments"]
    if sub_agent_depth >= 1 and name in {"analyze_document", "explore_knowledge_base", "task"}:
        return (
            f"Error: {name} cannot be called from inside a sub-agent. "
            "Use the available non-delegating tools directly instead."
        )
    # De-anonymize tool arguments: the LLM sees anonymized messages and
    # generates tool calls using surrogate names.  We must convert them
    # back to real values before executing tools (e.g. search queries).
    if redaction_svc is not None:
        original_args = raw_args
        raw_args = redaction_svc.deanonymize(raw_args)
        if raw_args != original_args:
            logger.debug(f"[TOOL] De-anonymized {name} args: {original_args[:200]} => {raw_args[:200]}")
    arguments = json.loads(raw_args) if raw_args else {}

    if name == "tool_search":
        from app.config import get_settings as _get_settings
        if not _get_settings().tool_registry_enabled:
            return "Error: Tool registry is not enabled."
        from app.services.tool_registry import get_tool_registry
        query = arguments.get("query", "")
        category = arguments.get("category")
        if not query:
            return "Error: No search query provided."
        registry = get_tool_registry()
        matches = registry.search(query, category=category)
        if not matches:
            return _citation_neutral_result("No tools found matching your query.", citation_context)
        results = []
        for tool in matches:
            results.append({
                "name": tool.name,
                "description": tool.description,
                "source": tool.source.value,
                "loading": tool.loading.value,
                "schema": tool.openai_schema,
            })
        return _citation_neutral_result(json.dumps(results, indent=2), citation_context)

    if name == "search_documents":
        query = arguments.get("query", "")
        # Drop empty/default filters the model may auto-fill (e.g. document_type
        # "other" + blank fields) — they'd otherwise zero out all results.
        metadata_filter = _clean_metadata_filter(arguments.get("filters"))
        search_mode = arguments.get("search_mode", "hybrid")
        # An empty folder list means "no restriction", not "search zero folders".
        folder_ids = arguments.get("folder_ids") or None
        logger.debug(f"[TOOL] search_documents: query='{query}', mode={search_mode}, filters={metadata_filter}, folder_ids={folder_ids}")

        results = await search_documents(
            query, user_id, metadata_filter=metadata_filter, search_mode=search_mode,
            folder_ids=folder_ids,
        )
        logger.debug(f"[TOOL] search_documents: got {len(results) if results else 0} results")

        if not results:
            logger.debug("[TOOL] search_documents: returning 'No relevant documents found.'")
            return "No relevant documents found."

        # Format results for LLM context
        formatted = []
        for r in results:
            meta = r.get("metadata", {})
            source = meta.get("filename", "unknown")
            doc_type = meta.get("document_type")
            type_label = f" [{doc_type}]" if doc_type else ""
            doc_id = r.get("document_id", "")

            # Display whichever scores are present
            score_parts = []
            if "rerank_score" in r:
                score_parts.append(f"rerank: {r['rerank_score']:.3f}")
            if "rrf_score" in r:
                score_parts.append(f"rrf: {r['rrf_score']:.4f}")
            if "similarity" in r:
                score_parts.append(f"similarity: {r['similarity']:.2f}")
            if "rank" in r:
                score_parts.append(f"fts_rank: {r['rank']:.4f}")
            score_str = ", ".join(score_parts) if score_parts else "n/a"

            # Include hierarchy metadata for get_document_sections context expansion
            hierarchy_parts = []
            chunk_index = meta.get("chunk_index")
            if chunk_index is not None:
                hierarchy_parts.append(f"chunk_index: {chunk_index}")
            cascading_path = meta.get("cascading_path")
            if cascading_path:
                hierarchy_parts.append(f"cascading_path: {cascading_path}")
            child_range = meta.get("childRange")
            if child_range:
                hierarchy_parts.append(f"childRange: {child_range}")
            parent_range = meta.get("parentRange")
            if parent_range:
                hierarchy_parts.append(f"parentRange: {parent_range}")
            hierarchy_str = f"\n[{', '.join(hierarchy_parts)}]" if hierarchy_parts else ""

            # Show the verbatim citable slice (falls back to enriched content for
            # not-yet-re-ingested rows). Keeping the model's view aligned with the
            # citation spans lets inline {[S#]} markers anchor against this text;
            # navigation context is carried by the hierarchy line above.
            body = r.get("citable_text") or r["content"]
            formatted.append(
                f"[Source: {source}{type_label}]\n"
                f"[document_id: {doc_id}]"
                f"{hierarchy_str}\n"
                f"({score_str})\n{body}"
            )

        formatted_result = "\n\n---\n\n".join(formatted)

        # Citation Modes (Fast Mode): split chunks into citable spans and
        # register answer-local aliases so the LLM can cite with [S#].
        if citation_context is not None:
            try:
                spans = spans_from_search_chunks(results, thread_id=thread_id)
                aliases = citation_context.register_spans(spans)
                formatted_result = inline_label_result(formatted_result, aliases)
            except Exception as cite_err:  # never let citation wiring break a tool call
                logger.warning(f"[CITATION] failed to register spans for search_documents: {cite_err}")
        # NOTE: Do NOT anonymize here — chat.py's anon_msgs loop handles
        # anonymization for all messages sent to the LLM.  Anonymizing in
        # both places causes double-anonymization (BUG-3).
        return formatted_result

    if name == "calculator":
        import math
        expression = arguments.get("expression", "")
        if not expression:
            return "Error: No expression provided."
        # Safe evaluation: only allow math operations
        allowed_names = {
            "sqrt": math.sqrt, "sin": math.sin, "cos": math.cos, "tan": math.tan,
            "log": math.log, "log10": math.log10, "log2": math.log2,
            "abs": abs, "round": round, "min": min, "max": max,
            "pow": pow, "ceil": math.ceil, "floor": math.floor,
            "pi": math.pi, "e": math.e,
        }
        try:
            result = eval(expression, {"__builtins__": {}}, allowed_names)
            return _citation_neutral_result(str(result), citation_context)
        except Exception as e:
            return f"Error evaluating expression: {e}"

    if name == "web_search":
        query = arguments.get("query", "")
        if not query:
            return "Error: No search query provided."
        max_results = arguments.get("max_results", 5)
        results = await web_search(query, max_results)
        formatted_result = format_search_results(results)

        # Citation Modes (Fast Mode): register web results as citable spans so
        # the model emits [S#] inline and the frontend can render chips.
        if citation_context is not None:
            try:
                fetched_at = datetime.now(timezone.utc).isoformat()
                aliases = register_web_results(citation_context, results, fetched_at=fetched_at)
                formatted_result = inline_label_result(formatted_result, aliases)
            except Exception as cite_err:
                logger.warning(f"[CITATION] failed to register spans for web_search: {cite_err}")
        return formatted_result

    if name == "analyze_document":
        document_id = arguments.get("document_id", "")
        query = arguments.get("query", "")
        if not document_id:
            return "Error: No document_id provided."
        if not query:
            return "Error: No analysis query provided."
        # Return the async generator - the chat router will handle streaming
        return run_sub_agent(
            document_id,
            user_id,
            query,
            redaction_svc=redaction_svc,
            citation_context=citation_context,
        )

    if name == "query_sales_database":
        from app.services.sql_agent_service import execute_sql_query
        sql = arguments.get("sql", "")
        if not sql:
            return "Error: No SQL query provided."
        result = await execute_sql_query(sql, redaction_svc=redaction_svc)
        return _citation_neutral_result(result, citation_context)

    if name == "ls":
        path = arguments.get("path", "root")
        supabase = get_supabase_client()
        result = await execute_ls(path, supabase, user_id)
        return _citation_neutral_result(result, citation_context)

    if name == "tree":
        path = arguments.get("path", "root")
        depth = arguments.get("depth", 3)
        limit = arguments.get("limit", 50)
        # Enforce reasonable limits
        depth = min(max(depth, 1), 10)
        limit = min(max(limit, 10), 200)
        supabase = get_supabase_client()
        result = await execute_tree(path, supabase, user_id, depth, limit)
        return _citation_neutral_result(result, citation_context)

    if name == "grep":
        pattern = arguments.get("pattern", "")
        if not pattern:
            return "Error: No search pattern provided."
        path = arguments.get("path", "root")
        case_sensitive = arguments.get("case_sensitive", False)
        supabase = get_supabase_client()
        result = await execute_grep(pattern, supabase, user_id, path, case_sensitive)
        if citation_context is not None:
            try:
                spans = spans_from_grep_result(result)
                aliases = citation_context.register_spans(spans)
                result = inline_label_result(result, aliases)
            except Exception as cite_err:
                logger.warning(f"[CITATION] failed to register spans for grep: {cite_err}")
        # NOTE: Do NOT anonymize here — chat.py's anon_msgs loop handles it.
        return result

    if name == "glob":
        pattern = arguments.get("pattern", "")
        if not pattern:
            return "Error: No filename pattern provided."
        supabase = get_supabase_client()
        result = await execute_glob(pattern, supabase, user_id)
        return _citation_neutral_result(result, citation_context)

    if name == "read":
        document_id = arguments.get("document_id", "")
        if not document_id:
            return "Error: No document_id provided."
        start_line = arguments.get("start_line")
        end_line = arguments.get("end_line")
        supabase = get_supabase_client()
        result = await execute_read(document_id, supabase, user_id, start_line, end_line)
        if citation_context is not None and not result.startswith("Error:"):
            try:
                spans = spans_from_read_result(result, document_id=document_id)
                aliases = citation_context.register_spans(spans)
                result = inline_label_result(result, aliases)
            except Exception as cite_err:
                logger.warning(f"[CITATION] failed to register spans for read: {cite_err}")
        # NOTE: Do NOT anonymize here — chat.py's anon_msgs loop handles it.
        return result

    if name == "task":
        if not thread_id:
            return "Error: No thread context available for task delegation."
        from app.services.deep_agent_service import run_task_agent
        task_description = arguments.get("description", "")
        task_context_files = arguments.get("context_files")
        if not task_description:
            return "Error: No task description provided."
        return run_task_agent(
            description=task_description,
            context_files=task_context_files,
            thread_id=thread_id,
            user_id=user_id,
            parent_tools=tools or [],
            redaction_svc=redaction_svc,
            citation_context=citation_context,
            sub_agent_depth=sub_agent_depth + 1,
        )

    if name == "explore_knowledge_base":
        research_query = arguments.get("research_query", "")
        starting_path = arguments.get("starting_path", "root")
        if not research_query:
            return "Error: No research query provided."
        # Return the async generator - the chat router will handle streaming
        return run_explorer_agent(
            research_query,
            user_id,
            starting_path,
            redaction_svc=redaction_svc,
            citation_context=citation_context,
        )

    if name == "get_document_structure":
        doc_id = arguments.get("document_id", "")
        if not doc_id:
            return "Error: No document_id provided."
        supabase = get_supabase_client()
        result = supabase.table("documents").select(
            "hierarchical_index, filename"
        ).eq("id", doc_id).eq("user_id", user_id).maybe_single().execute()
        if not result.data:
            return "Error: Document not found or access denied."
        hierarchy = result.data.get("hierarchical_index")
        if not hierarchy:
            return f"Document '{result.data.get('filename', doc_id)}' was chunked with the simple strategy — no hierarchical structure available."
        # Document structure is a navigation map, not citable evidence -- it
        # registers no aliases. Outline headings ("VERSUS", "TABLE OF CONTENTS")
        # are poor citations and previously starved the alias budget so the
        # chunks the model actually expands into got none (see Plan 9). The
        # model expands chunks via get_document_sections and cites those.
        formatted_result = f"Structure for '{result.data.get('filename', doc_id)}':\n\n{hierarchy}"
        return formatted_result

    if name == "get_document_sections":
        items = arguments.get("items", [])
        if not items:
            return "Error: No items provided."
        input_data = []
        for item in items:
            doc_id = item.get("document_id", "")
            ranges = item.get("chunk_ranges", [])
            if not doc_id or not ranges:
                continue
            input_data.append({"document_id": doc_id, "chunk_ranges": ranges})
        if not input_data:
            return "Error: No valid document/range pairs provided."
        supabase = get_supabase_client()
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
                title_map = _document_titles_by_id(
                    supabase,
                    {str(chunk.get("document_id")) for chunk in data if chunk.get("document_id")},
                )
                spans = spans_from_document_sections(
                    data,
                    title_by_document_id=title_map,
                )
                aliases = citation_context.register_spans(spans)
                formatted_result = inline_label_result(formatted_result, aliases)
            except Exception as cite_err:
                logger.warning(f"[CITATION] failed to register spans for get_document_sections: {cite_err}")
        return formatted_result

    if name == "load_skill":
        skill_id = arguments.get("skill_id", "")
        if not skill_id:
            return "Error: No skill_id provided."
        supabase = get_supabase_client()

        # Fetch the skill (service role bypasses RLS, so check visibility manually)
        skill_result = supabase.table("skills").select("*").eq("id", skill_id).execute()
        if not skill_result.data:
            return f"Error: Skill '{skill_id}' not found."
        skill = skill_result.data[0]

        # Verify visibility: global (user_id IS NULL) or owned by current user
        if skill.get("user_id") is not None and skill["user_id"] != user_id:
            return f"Error: Skill '{skill_id}' not found."

        output = f"# Skill: {skill['name']}\n\n## Instructions\n{skill['instructions']}"

        if app_config.get_settings().sandbox_enabled:
            # Skill instructions may reference JavaScript/Node.js, but only
            # Python is available inside this app's code sandbox.
            output += (
                "\n\n## IMPORTANT: Execution Environment\n"
                "The code sandbox is **Python ONLY**. Do NOT use JavaScript, Node.js, or npm packages. "
                "If this skill references JavaScript libraries, use the equivalent Python library instead "
                "(e.g. python-docx instead of docx npm, openpyxl instead of exceljs, "
                "python-pptx instead of pptxgenjs, matplotlib/plotly instead of chart.js)."
            )

        # Fetch attached files (excluding .skillkeep placeholders that exist
        # only to keep empty folders visible in the UI tree)
        files_result = supabase.table("skill_files").select(
            "filename, file_size, mime_type"
        ).eq("skill_id", skill_id).order("filename").execute()
        files = [
            f for f in (files_result.data or [])
            if not f["filename"].endswith("/.skillkeep") and f["filename"] != ".skillkeep"
        ]

        if files:
            output += "\n\n## Skill Files"
            output += "\nThis skill has attached files. Use `read_skill_file` to read any file."
            output += "\n| Filename | Size | Type |"
            output += "\n|----------|------|------|"
            for f in files:
                size_kb = f["file_size"] / 1024
                size_str = f"{size_kb:.1f} KB" if size_kb < 1024 else f"{size_kb/1024:.1f} MB"
                output += f"\n| {f['filename']} | {size_str} | {f['mime_type']} |"
            output += f'\n\nUse `read_skill_file(skill_id="{skill_id}", filename="<name>")` to read any file.'

        logger.debug(f"[TOOL] load_skill: loaded '{skill['name']}' (id={skill_id})")
        return _citation_neutral_result(output, citation_context)

    if name == "read_skill_file":
        skill_id = arguments.get("skill_id", "")
        filename = arguments.get("filename", "")
        if not skill_id:
            return "Error: No skill_id provided."
        if not filename:
            return "Error: No filename provided."

        supabase = get_supabase_client()

        # Verify skill visibility
        skill_result = supabase.table("skills").select("id, user_id").eq("id", skill_id).execute()
        if not skill_result.data:
            return f"Error: Skill '{skill_id}' not found."
        skill = skill_result.data[0]
        if skill.get("user_id") is not None and skill["user_id"] != user_id:
            return f"Error: Skill '{skill_id}' not found."

        # Fetch file metadata
        file_result = supabase.table("skill_files").select("*").eq(
            "skill_id", skill_id
        ).eq("filename", filename).maybe_single().execute()

        if not file_result or not file_result.data:
            return f"Error: File '{filename}' not found in skill."

        file_meta = file_result.data
        mime = file_meta["mime_type"]

        # Determine if text-based
        text_mimes = {"application/json", "application/javascript", "application/x-python",
                       "application/xml", "application/yaml", "application/x-yaml",
                       "application/sql", "application/x-sh"}
        is_text = mime.startswith("text/") or mime in text_mimes

        if is_text:
            try:
                data = supabase.storage.from_("skill-files").download(file_meta["storage_path"])
                content = data.decode("utf-8")
                return _citation_neutral_result(f"# File: {filename}\n```\n{content}\n```", citation_context)
            except Exception as e:
                return f"Error reading file: {e}"
        else:
            size_kb = file_meta["file_size"] / 1024
            size_str = f"{size_kb:.1f} KB" if size_kb < 1024 else f"{size_kb/1024:.1f} MB"
            binary_result = (
                f"# File: {filename}\n"
                f"- Type: {mime}\n"
                f"- Size: {size_str}\n"
                f"- Binary file — content cannot be displayed as text."
            )
            return _citation_neutral_result(binary_result, citation_context)

    if name == "save_skill":
        skill_name = arguments.get("name", "")
        description = arguments.get("description", "")
        instructions = arguments.get("instructions", "")

        # Validate name format
        if not skill_name or not re.match(r"^[a-z0-9-]+$", skill_name) or len(skill_name) > 64:
            return "Error: Skill name must be lowercase letters, numbers, and hyphens only (max 64 chars). Example: 'analyzing-sales-data'"

        # Validate description length
        if len(description) < 20:
            return "Error: Description must be at least 20 characters."
        if len(description) > 1024:
            return "Error: Description must be at most 1024 characters."

        if not instructions:
            return "Error: Instructions are required."

        supabase = get_supabase_client()

        # Insert the skill
        try:
            skill_insert = supabase.table("skills").insert({
                "user_id": user_id,
                "name": skill_name,
                "description": description,
                "instructions": instructions,
            }).execute()
        except Exception as e:
            error_msg = str(e)
            if "duplicate" in error_msg.lower() or "unique" in error_msg.lower():
                return f"Error: A skill named '{skill_name}' already exists."
            return f"Error creating skill: {error_msg}"

        if not skill_insert.data:
            return "Error: Failed to create skill."

        new_skill = skill_insert.data[0]
        skill_id = new_skill["id"]

        logger.debug(f"[TOOL] save_skill: created '{skill_name}' (id={skill_id})")

        skill_result = (
            f"Skill created successfully!\n"
            f"- Name: {skill_name}\n"
            f"- Description: {description}\n"
            f"- ID: {skill_id}\n\n"
            f"The skill is now available in your skills catalog and will be automatically discovered when relevant queries are asked."
        )
        return _citation_neutral_result(skill_result, citation_context)

    if name == "upload_skill_file":
        skill_id = arguments.get("skill_id", "")
        filename = arguments.get("filename", "")
        content = arguments.get("content", "")

        if not skill_id:
            return "Error: No skill_id provided."
        if not filename:
            return "Error: No filename provided."
        if not content:
            return "Error: No content provided."

        supabase = get_supabase_client()

        # Verify skill ownership
        skill_result = supabase.table("skills").select("id, user_id").eq("id", skill_id).execute()
        if not skill_result.data:
            return f"Error: Skill '{skill_id}' not found."
        skill = skill_result.data[0]
        if skill.get("user_id") != user_id:
            return f"Error: You don't own this skill."

        content_bytes = content.encode("utf-8")
        file_size = len(content_bytes)
        mime_type = mimetypes.guess_type(filename)[0] or "text/plain"
        storage_path = f"{user_id}/{skill_id}/{filename}"

        # Upload to storage
        try:
            supabase.storage.from_("skill-files").upload(
                storage_path, content_bytes,
                file_options={"content-type": mime_type, "upsert": "true"},
            )
        except Exception as e:
            return f"Error uploading file: {e}"

        # Upsert metadata
        try:
            supabase.table("skill_files").upsert({
                "skill_id": skill_id,
                "user_id": user_id,
                "filename": filename,
                "storage_path": storage_path,
                "file_size": file_size,
                "mime_type": mime_type,
            }, on_conflict="skill_id,filename").execute()
        except Exception as e:
            return f"Error saving file metadata: {e}"

        logger.debug(f"[TOOL] upload_skill_file: saved '{filename}' to skill {skill_id}")
        upload_result = (
            f"File uploaded successfully!\n"
            f"- Filename: {filename}\n"
            f"- Size: {file_size} bytes\n"
            f"- Skill: {skill_id}\n\n"
            f"The file is now attached to the skill and will be available via `read_skill_file` when the skill is loaded."
        )
        return _citation_neutral_result(upload_result, citation_context)

    if name == "execute_code":
        code = arguments.get("code", "")
        if not code:
            return "Error: No code provided."
        from app.services.sandbox_service import run_code_execution
        return run_code_execution(
            code=code,
            thread_id=thread_id or "",
            user_id=user_id,
            libraries=arguments.get("libraries"),
            output_filenames=arguments.get("output_filenames"),
        )

    if name == "write_todos":
        if not thread_id:
            return "Error: No thread context available for todo operations."
        from app.models.schemas import TodoItem
        from app.services.todo_service import write_todos
        raw_todos = arguments.get("todos", [])
        # Validate each item with Pydantic before touching the DB
        try:
            validated = [TodoItem(**t).model_dump() for t in raw_todos]
        except Exception as e:
            return f"Error: Invalid todo data — {e}"
        try:
            saved = await write_todos(thread_id, validated, user_id)
        except PermissionError:
            return "Error: You do not have access to this thread's todos."
        if not saved:
            return _citation_neutral_result("Todo list cleared (0 items).", citation_context)
        lines = [f"{t['position'] + 1}. [{t['status']}] {t['content']}" for t in saved]
        return _citation_neutral_result(f"Todo list updated ({len(saved)} items):\n" + "\n".join(lines), citation_context)

    if name == "read_todos":
        if not thread_id:
            return "Error: No thread context available for todo operations."
        from app.services.todo_service import read_todos
        try:
            todos = await read_todos(thread_id, user_id)
        except PermissionError:
            return "Error: You do not have access to this thread's todos."
        if not todos:
            return _citation_neutral_result("No todos found for this conversation.", citation_context)
        lines = [f"{t['position'] + 1}. [{t['status']}] {t['content']}" for t in todos]
        return _citation_neutral_result(f"Current todo list ({len(todos)} items):\n" + "\n".join(lines), citation_context)

    if name == "ask_user":
        # The chat router detects this tool call, surfaces the question to the user,
        # and ends the turn (the conversation pauses until the user's next message,
        # which becomes the answer). This placeholder keeps the tool/result pair valid
        # in the persisted history so the agent can resume coherently.
        return _citation_neutral_result(
            "[Question posed to the user. The conversation is paused; the user's next "
            "message is their answer — continue the task using it.]",
            citation_context,
        )

    if name == "write_file":
        if not thread_id:
            return "Error: No thread context available for workspace operations."
        from app.services.workspace_service import write_file
        file_path = arguments.get("file_path", "")
        content = arguments.get("content", "")
        if not file_path:
            return "Error: No file_path provided."
        try:
            saved = await write_file(thread_id, file_path, content, user_id)
        except PermissionError:
            return "Error: You do not have access to this thread's workspace."
        except ValueError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error writing file: {e}"
        write_result = (
            f"File written successfully.\n"
            f"- Path: {saved.get('file_path', file_path)}\n"
            f"- Size: {saved.get('size_bytes', 0)} bytes\n"
            f"- Type: {saved.get('content_type', 'unknown')}"
        )
        return _citation_neutral_result(write_result, citation_context)

    if name == "read_file":
        if not thread_id:
            return "Error: No thread context available for workspace operations."
        from app.services.workspace_service import read_file
        file_path = arguments.get("file_path", "")
        start_line = arguments.get("start_line")
        end_line = arguments.get("end_line")
        if not file_path:
            return "Error: No file_path provided."
        try:
            content = await read_file(
                thread_id,
                file_path,
                user_id,
                start_line=start_line,
                end_line=end_line,
            )
        except PermissionError:
            return "Error: You do not have access to this thread's workspace."
        except ValueError as e:
            return f"Error: {e}"
        except FileNotFoundError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error reading file: {e}"
        if citation_context is not None:
            try:
                supabase = get_supabase_client()
                meta_result = supabase.table("workspace_files").select(
                    "content_type"
                ).eq("thread_id", thread_id).eq("file_path", file_path).maybe_single().execute()
                content_type = (meta_result.data or {}).get("content_type") if meta_result else None
                spans = spans_from_workspace_file(
                    content or "",
                    thread_id=thread_id,
                    file_path=file_path,
                    content_type=content_type,
                )
                aliases = citation_context.register_spans(spans)
                content = inline_label_result(content or "", aliases)
            except Exception as cite_err:
                logger.warning(f"[CITATION] failed to register spans for read_file: {cite_err}")
        return content

    if name == "edit_file":
        if not thread_id:
            return "Error: No thread context available for workspace operations."
        from app.services.workspace_service import edit_file
        file_path = arguments.get("file_path", "")
        old_string = arguments.get("old_string", "")
        new_string = arguments.get("new_string", "")
        replace_all = bool(arguments.get("replace_all", False))
        if not file_path:
            return "Error: No file_path provided."
        if not old_string:
            return "Error: No old_string provided."
        try:
            saved = await edit_file(
                thread_id, file_path, old_string, new_string, user_id,
                replace_all=replace_all,
            )
        except PermissionError:
            return "Error: You do not have access to this thread's workspace."
        except ValueError as e:
            return f"Error: {e}"
        except FileNotFoundError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error editing file: {e}"
        edit_result = (
            f"File edited successfully.\n"
            f"- Path: {saved.get('file_path', file_path)}\n"
            f"- New size: {saved.get('size_bytes', 0)} bytes"
        )
        return _citation_neutral_result(edit_result, citation_context)

    if name == "list_files":
        if not thread_id:
            return "Error: No thread context available for workspace operations."
        from app.services.workspace_service import list_files
        try:
            files = await list_files(thread_id, user_id)
        except PermissionError:
            return "Error: You do not have access to this thread's workspace."
        except Exception as e:
            return f"Error listing files: {e}"
        if not files:
            return _citation_neutral_result("No workspace files found for this conversation.", citation_context)
        lines = []
        for f in files:
            size_str = f"{f['size_bytes']} bytes"
            lines.append(f"- {f['file_path']} ({size_str}, {f['content_type']}, {f['source']})")
        return _citation_neutral_result(f"Workspace files ({len(files)}):\n" + "\n".join(lines), citation_context)

    # Registry fallback: look up dynamically loaded tools
    from app.config import get_settings
    if get_settings().tool_registry_enabled:
        from app.services.tool_registry import get_tool_registry
        registry = get_tool_registry()
        tool_def = registry.get(name)
        if tool_def and tool_def.executor:
            result = await tool_def.executor(tool_call, user_id, redaction_svc=redaction_svc)
            return _citation_neutral_result(result, citation_context) if isinstance(result, str) else result

    logger.warning(f"Unknown tool: {name}")
    return f"Error: Unknown tool '{name}'"
