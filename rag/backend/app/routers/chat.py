import asyncio
import base64
import hashlib
import json
import inspect
import logging
import re
from fastapi import APIRouter, Depends, HTTPException, status
from starlette.responses import StreamingResponse
from datetime import datetime
from typing import AsyncGenerator

from app.dependencies import get_current_user, User
from app.db.supabase import get_supabase_client
from app.models.schemas import MessageCreate, MessageResponse, CheckCitationsResponse
from app.config import get_settings
from app.services.llm_service import astream_chat_response, build_rag_tools, build_workspace_tools, build_planning_tools, build_delegation_tools, get_max_tool_rounds
from app.services.tool_executor import execute_tool_call
from app.services.web_search_service import get_web_search_settings
from app.services.langsmith import trace, is_tracing_enabled
from app.services.redaction_service import create_thread_redaction_service
from app.services.message_compaction_service import create_thread_compaction_service
from app.services.workspace_service import (
    download_file_bytes as download_workspace_file_bytes,
    get_file as get_workspace_file,
    list_files as list_workspace_files,
)
from app.services.citation_service import (
    CITATION_SYSTEM_PROMPT,
    CitationContext,
    build_answer_citations,
    build_newly_cited_full_citations,
    build_streaming_citations,
    format_evidence_block_for_alias_numbers,
    format_evidence_block_for_new_aliases,
    merge_same_pdf_highlight_citation_runs,
    normalize_aliases_in_text,
    sanitize_unowned_aliases,
    strip_alias_numbers,
)
from app.services.citation_location_service import enrich_pdf_citation_targets
from app.services.citation_grounding_service import grade_citations
from app.routers.threads import generate_title_for_thread
import uuid as _uuid

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/threads/{thread_id}", tags=["chat"])

_IMAGE_CONTEXT_TYPES = {"image/gif", "image/jpeg", "image/png", "image/webp"}
_MAX_IMAGE_CONTEXT_FILES = 4
_MAX_IMAGE_CONTEXT_BYTES = 5 * 1024 * 1024
_MAX_IMAGE_CONTEXT_TOTAL_BYTES = 12 * 1024 * 1024


async def _next_sequence_number(thread_id: str) -> int:
    """Get next sequence number for a thread, using advisory lock for safety."""
    supabase = get_supabase_client()
    result = supabase.rpc("next_message_sequence", {"p_thread_id": thread_id}).execute()
    return result.data


def get_result_summary(tool_name: str, result: str) -> str:
    """Generate a human-readable summary of a tool result."""
    try:
        if tool_name == "search_documents":
            # Try to count results from the formatted output
            if "No relevant documents found" in result:
                return "No results"
            # Count "Document:" occurrences for search results
            count = result.count("Document:")
            if count > 0:
                return f"{count} result{'s' if count != 1 else ''}"
            return "Results found"
        elif tool_name == "web_search":
            # format_search_results emits "[1] {title}" per result, not "Title:".
            # Handle the sentinel rows first, then count the [n] markers.
            if "No web search results found" in result or "Web search is not enabled" in result:
                return "No results"
            if "Web search failed" in result:
                return "Search error"
            count = len(re.findall(r"(?m)^\[\d+\]", result))
            if count > 0:
                return f"{count} result{'s' if count != 1 else ''}"
            return "No results"
        elif tool_name == "load_skill":
            # Extract skill name from result
            if result.startswith("# Skill: "):
                sname = result.split("\n")[0].replace("# Skill: ", "")
                return f"Loaded skill: {sname}"
            return "Skill loaded"
        elif tool_name == "save_skill":
            # Extract skill name from result
            if "- Name: " in result:
                for line in result.split("\n"):
                    if line.startswith("- Name: "):
                        return f"Created skill: {line[8:]}"
            return "Skill created"
        elif tool_name == "read_skill_file":
            if result.startswith("# File: "):
                fname = result.split("\n")[0].replace("# File: ", "")
                return f"Read file: {fname}"
            return "File read"
        elif tool_name == "upload_skill_file":
            if "- Filename: " in result:
                for line in result.split("\n"):
                    if line.startswith("- Filename: "):
                        return f"Uploaded: {line[12:]}"
            return "File uploaded"
        elif tool_name == "tool_search":
            if "No tools found" in result:
                return "No matches"
            try:
                matches = json.loads(result)
                if isinstance(matches, list):
                    return f"{len(matches)} tool{'s' if len(matches) != 1 else ''} found"
            except (json.JSONDecodeError, TypeError):
                pass
            return "Search complete"
        elif tool_name == "execute_code":
            if "Error" in result:
                return "Execution failed"
            if "Generated files:" in result:
                return "Code executed, file(s) generated"
            return "Code executed"
        else:
            return "Complete"
    except Exception:
        return "Complete"




def _rebuild_tool_messages(tool_calls_data: list[dict]) -> list[dict]:
    """Convert stored tool_calls JSON into OpenAI-format messages.

    Returns a list of messages: one assistant message with tool_calls,
    followed by tool result messages for each call that has a stored result.
    """
    if not tool_calls_data:
        return []

    openai_tool_calls = []
    tool_result_msgs = []

    for tc in tool_calls_data:
        tool_call_id = tc.get("tool_call_id")
        if not tool_call_id:
            continue  # Skip legacy records without tool_call_id

        openai_tool_calls.append({
            "id": tool_call_id,
            "type": "function",
            "function": {
                "name": tc["tool_name"],
                "arguments": tc["arguments"],
            }
        })

        if tc.get("result"):
            tool_result_msgs.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": tc["result"],
            })

    if not openai_tool_calls:
        return []

    messages = [{
        "role": "assistant",
        "content": None,
        "tool_calls": openai_tool_calls,
    }]
    messages.extend(tool_result_msgs)
    return messages


def _materialize_compacted(compacted: list[dict]) -> list[dict]:
    """Strip internal-only fields (e.g. ``_synthetic``) from a compacted view.

    The OpenAI API rejects unknown message keys, so we drop any leading-underscore
    keys the compaction service may have attached.
    """
    out: list[dict] = []
    for m in compacted:
        out.append({k: v for k, v in m.items() if not str(k).startswith("_")})
    return out


def _persist_web_snapshots(citation_ctx: CitationContext, db_rows: list[dict], user_id: str) -> None:
    """Upsert captured page snapshots for the web sources actually cited.

    Deduped per (user_id, source_id): a page cited by several aliases (or across
    turns) stores a single snapshot. Best-effort -- logs and returns on failure
    so the chat stream is never disrupted.
    """
    if not db_rows or not citation_ctx.web_snapshots:
        return
    cited_source_ids = {
        r.get("source_id")
        for r in db_rows
        if r.get("source_type") == "web" and r.get("source_id")
    }
    rows: list[dict] = []
    for source_id in cited_source_ids:
        snap = citation_ctx.web_snapshots.get(source_id)
        if not snap or not snap.get("content"):
            continue
        content = snap["content"]
        row = {
            "user_id": user_id,
            "source_id": source_id,
            "url": snap.get("url"),
            "title": snap.get("title"),
            "content": content,
            "content_type": snap.get("content_type") or "text/markdown",
            "content_hash": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            "byte_size": len(content.encode("utf-8")),
        }
        if snap.get("fetched_at"):
            row["fetched_at"] = snap["fetched_at"]
        rows.append(row)
    if not rows:
        return
    try:
        get_supabase_client().table("web_snapshots").upsert(
            rows, on_conflict="user_id,source_id"
        ).execute()
    except Exception as e:
        logger.warning(f"[CITATION] failed to persist web snapshots: {e}")


def _persist_citation_registry(citation_ctx: CitationContext, thread_id: str, user_id: str) -> None:
    """Merge this turn's newly-numbered spans into the thread citation registry.

    Plan 23 B: keeps {[S#]} numbers stable across turns. Best-effort and never
    raises -- a failure just means next turn may renumber those spans.
    """
    updates = citation_ctx.registry_updates()
    if not updates or not thread_id:
        return
    try:
        supabase = get_supabase_client()
        row = supabase.table("threads").select("citation_aliases").eq(
            "id", thread_id
        ).maybe_single().execute()
        current = (row.data or {}).get("citation_aliases") if row else None
        if not isinstance(current, dict):
            current = {}
        current.update(updates)
        supabase.table("threads").update({"citation_aliases": current}).eq(
            "id", thread_id
        ).execute()
        citation_ctx.mark_registry_persisted()
    except Exception as e:
        logger.warning(f"[CITATION] failed to persist thread citation registry: {e}")


async def _finalize_citations_for_turn(
    *,
    final_content: str,
    final_assistant_message_id: str | None,
    thread_id: str,
    user_id: str,
    citation_ctx: CitationContext,
) -> tuple[str | None, list[dict] | None, dict | None]:
    """Run Quick citation finalization for a completed assistant turn.

    Returns ``(content_db_only, db_rows, sse_payload)``.
      * ``content_db_only`` -- text to write to the persisted message column,
        without streaming back to the frontend (used when normalization just
        rewrites brackets).
      * ``db_rows`` -- list ready to insert into ``answer_citations``.
      * ``sse_payload`` -- dict to JSON-encode into a ``citation_metadata`` SSE
        event.

    Never raises -- failures are logged and result in a no-op for the citations
    layer so the chat response itself is never disrupted.
    """
    # Plan 23 B: persist this turn's newly-numbered spans first, so {[S#]} tokens
    # stay stable for future turns even when the answer carries no citations.
    _persist_citation_registry(citation_ctx, thread_id, user_id)

    if not final_content:
        return None, None, None

    if not citation_ctx.aliases:
        return None, None, None

    mode = "unverified"
    # ``content_db_only`` is text we should persist to the DB column (so a page
    # reload renders chips) but not stream back to the frontend, because the
    # frontend already displayed the original streamed text and its regex now
    # handles combined-reference brackets directly.
    content_db_only: str | None = None

    # Defensive: split [S1, S8] -> [S1][S8] and recover [W#]/[D#]/[N#] tokens
    # so the persisted column matches the chip-rendering regex.
    normalized = normalize_aliases_in_text(final_content, citation_ctx)
    if normalized != final_content:
        content_db_only = normalized
        final_content = normalized

    try:
        citation_rows, invalid_nums = build_answer_citations(
            answer_text=final_content,
            context=citation_ctx,
            message_id=final_assistant_message_id,
            thread_id=thread_id,
            verification_mode=mode,
        )
        if invalid_nums:
            logger.warning(
                f"[CITATION] stripping invalid aliases for message={final_assistant_message_id}: {invalid_nums}"
            )
            # Scrub tokens the model cited that were never registered this
            # turn so they don't reach the UI as raw {[S#]} markers; persist
            # the cleaned text so reloads render clean.
            stripped = strip_alias_numbers(final_content, set(invalid_nums))
            if stripped != final_content:
                final_content = stripped
                content_db_only = stripped
    except Exception as e:
        logger.warning(f"[CITATION] finalize failed for message={final_assistant_message_id}: {e}")
        return content_db_only, None, None

    if citation_rows:
        try:
            enrich_pdf_citation_targets(citation_rows, user_id=user_id)
        except Exception as e:
            logger.warning(
                f"[CITATION] PDF location enrichment failed for message={final_assistant_message_id}: {e}"
            )

    if citation_rows:
        merged_content, merged_rows = merge_same_pdf_highlight_citation_runs(
            final_content,
            citation_rows,
        )
        if merged_content != final_content:
            final_content = merged_content
            content_db_only = merged_content
            citation_rows = merged_rows

    if not citation_rows:
        return content_db_only, None, None

    db_rows: list[dict] = []
    if final_assistant_message_id:
        for c in citation_rows:
            src = c["source"]
            tgt = c.get("target") or {}
            db_rows.append({
                "message_id": final_assistant_message_id,
                "user_id": user_id,
                "thread_id": thread_id,
                "display_ref": c["display_ref"],
                "display_number": c["display_number"],
                "source_id": src["source_id"],
                "span_id": c.get("_span_id"),
                "source_type": src["source_type"],
                "source_title": src["title"],
                "source_uri": src.get("uri"),
                "document_id": src.get("document_id"),
                "workspace_file_path": src.get("file_path"),
                "content_type": src.get("content_type"),
                "content_hash": src.get("content_hash"),
                "target": tgt,
                "quote": c.get("quote"),
                "status": c["status"],
                "support_score": c.get("support_score"),
                "claim_id": c.get("claim_id"),
                "problem": c.get("problem"),
                "verification_mode": mode,
            })

    # Persist captured page text for any web sources that were actually cited so
    # the citation panel can render the source and highlight the cited snippet
    # when that snippet appears in the captured page text.
    _persist_web_snapshots(citation_ctx, db_rows, user_id)

    sse_payload = {
        "type": "citation_metadata",
        "message_id": final_assistant_message_id,
        "verification_mode": mode,
        "citations": [
            {k: v for k, v in c.items() if not k.startswith("_")}
            for c in citation_rows
        ],
        "claim_states": [],
    }
    if content_db_only is not None:
        sse_payload["answer_text"] = content_db_only
    return content_db_only, db_rows, sse_payload


async def verify_thread_access(thread_id: str, user_id: str) -> dict:
    """Verify the user has access to the thread and return thread data."""
    supabase = get_supabase_client()
    result = supabase.table("threads").select("*").eq("id", thread_id).eq("user_id", user_id).single().execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Thread not found"
        )

    return result.data


def get_thread_messages(thread_id: str) -> list[dict]:
    """Get all messages for a thread formatted for the API.

    Includes id and anonymized_content so the chat loop can skip
    re-anonymizing messages that were already processed.
    """
    supabase = get_supabase_client()
    result = supabase.table("messages").select(
        "id, role, content, anonymized_content, tool_calls, attachments"
    ).eq("thread_id", thread_id).order("sequence_number").execute()

    return [
        {
            "id": msg["id"],
            "role": msg["role"],
            "content": msg["content"],
            "anonymized_content": msg.get("anonymized_content"),
            "tool_calls": msg.get("tool_calls"),
            "attachments": msg.get("attachments"),
        }
        for msg in result.data
    ]


def _content_to_prompt_text(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(part.get("text") or "")
            elif isinstance(part, str):
                parts.append(part)
        return "".join(parts)
    return str(content)


async def _resolve_workspace_attachment_metadata(
    *,
    thread_id: str,
    user_id: str,
    file_paths: list[str],
) -> list[dict]:
    unique_paths = list(dict.fromkeys(path for path in file_paths if path))
    if not unique_paths:
        return []

    try:
        workspace_files = await list_workspace_files(thread_id, user_id)
    except Exception as e:
        logger.warning(f"[CHAT] failed to list workspace attachments: {e}")
        return []

    files_by_path = {row.get("file_path"): row for row in workspace_files}
    attachments: list[dict] = []
    for file_path in unique_paths:
        record = files_by_path.get(file_path)
        if not record:
            logger.warning(f"[CHAT] attached workspace file not found: {file_path}")
            continue
        attachments.append({
            "file_path": record.get("file_path"),
            "content_type": record.get("content_type") or "application/octet-stream",
            "size_bytes": int(record.get("size_bytes") or 0),
            "source": record.get("source") or "upload",
        })
    return attachments


async def _attach_workspace_images_to_latest_user_message(
    messages: list[dict],
    *,
    thread_id: str,
    user_id: str,
    file_paths: list[str],
) -> list[str]:
    """Attach newly uploaded workspace images to the latest user message.

    The database stores workspace uploads separately; this function is the
    send-time bridge that makes selected/pasted images visible to vision-capable
    chat models for the current turn.
    """
    if not file_paths:
        return []

    latest_user = next((msg for msg in reversed(messages) if msg.get("role") == "user"), None)
    if latest_user is None:
        return []

    attachment_metadata = await _resolve_workspace_attachment_metadata(
        thread_id=thread_id,
        user_id=user_id,
        file_paths=file_paths,
    )
    image_parts: list[dict] = []
    attached_items: list[dict] = []
    total_bytes = 0

    for record in attachment_metadata:
        file_path = record["file_path"]
        content_type = (record.get("content_type") or "").lower()
        size_bytes = int(record.get("size_bytes") or 0)
        attached_items.append({
            "file_path": file_path,
            "content_type": content_type or "unknown",
            "size_bytes": size_bytes,
        })

        if content_type not in _IMAGE_CONTEXT_TYPES:
            continue

        if size_bytes > _MAX_IMAGE_CONTEXT_BYTES:
            logger.warning(f"[CHAT] skipping oversized image attachment: {file_path} ({size_bytes} bytes)")
            continue
        if total_bytes + size_bytes > _MAX_IMAGE_CONTEXT_TOTAL_BYTES:
            logger.warning("[CHAT] skipping image attachment because total image context budget is exhausted")
            continue
        if len(image_parts) >= _MAX_IMAGE_CONTEXT_FILES:
            logger.warning("[CHAT] skipping image attachment because image context file limit is reached")
            continue

        try:
            image_bytes = await download_workspace_file_bytes(thread_id, file_path, user_id)
        except Exception as e:
            logger.warning(f"[CHAT] failed to download image attachment {file_path}: {e}")
            continue

        total_bytes += len(image_bytes)
        image_parts.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:{content_type};base64,{base64.b64encode(image_bytes).decode('ascii')}",
            },
        })
        attached_items[-1]["size_bytes"] = len(image_bytes)

    if not attached_items:
        return []

    base_text = _content_to_prompt_text(latest_user.get("content")).strip()
    attachment_text = "Attached workspace files for this message:\n" + "\n".join(
        f"- {item['file_path']} ({item['content_type']}, {item['size_bytes']:,} bytes)"
        for item in attached_items
    )
    attachment_text += (
        "\n\nUse these exact workspace file paths for questions about the attached files. "
        "These are thread workspace uploads, not knowledge-base Documents. "
        "Use list_files/read_file first, passing start_line/end_line for large files; "
        "for binary analysis, use execute_code to read `/sandbox/workspace/<file_path>`."
    )
    latest_user["content"] = [
        {
            "type": "text",
            "text": f"{base_text}\n\n{attachment_text}" if base_text else attachment_text,
        },
        *image_parts,
    ]
    logger.info(f"[CHAT] attached {len(attached_items)} workspace file(s), including {len(image_parts)} image(s), to LLM prompt")
    return [item["file_path"] for item in attached_items]


def user_has_documents(user_id: str) -> bool:
    """Check if user has any completed documents for RAG."""
    supabase = get_supabase_client()
    result = supabase.table("documents").select("id", count="exact").eq(
        "user_id", user_id
    ).eq("status", "completed").execute()
    return (result.count or 0) > 0


# Short conversational messages that should NOT trigger a forced document
# search (greetings, thanks, acknowledgements). Anything else is treated as a
# question worth grounding in the knowledge base.
_NO_SEARCH_MESSAGES = {
    "hi", "hello", "hey", "yo", "hiya", "thanks", "thank you", "thx", "ty",
    "ok", "okay", "cool", "great", "nice", "got it", "sounds good", "bye",
    "goodbye", "good morning", "good afternoon", "good evening",
}


def _message_warrants_search(content: str | None) -> bool:
    """Heuristic: should this user message trigger a forced round-1 document
    search? Skips empty/very short greetings and acknowledgements so casual
    chatter doesn't always fire a retrieval; everything else does."""
    if not content:
        return False
    normalized = content.strip().lower().rstrip("!.?")
    if not normalized:
        return False
    if normalized in _NO_SEARCH_MESSAGES:
        return False
    # Very short single-word messages are almost never knowledge questions.
    if len(normalized.split()) <= 1 and len(normalized) <= 4:
        return False
    return True


@router.get("/messages", response_model=list[MessageResponse])
async def get_messages(
    thread_id: str,
    current_user: User = Depends(get_current_user)
):
    """Get all messages for a thread from database."""
    await verify_thread_access(thread_id, current_user.id)

    supabase = get_supabase_client()
    result = supabase.table("messages").select("*").eq("thread_id", thread_id).order("sequence_number").execute()
    messages_data = result.data or []

    if not messages_data:
        return messages_data

    # Citation Modes: attach AnswerCitations per message so the frontend can
    # render Quick-citation chips after a refresh.
    message_ids = [m["id"] for m in messages_data]
    try:
        citations_res = supabase.table("answer_citations").select("*").in_("message_id", message_ids).execute()
        citations_by_msg: dict[str, list[dict]] = {}
        for row in citations_res.data or []:
            citations_by_msg.setdefault(row["message_id"], []).append(_citation_row_to_response(row))
    except Exception as e:
        logger.warning(f"[CITATION] failed to load citations for thread={thread_id}: {e}")
        citations_by_msg = {}

    for m in messages_data:
        m_id = m["id"]
        if m_id in citations_by_msg:
            m["citations"] = sorted(citations_by_msg[m_id], key=lambda c: c["display_number"])

    return messages_data


def _citation_row_to_response(row: dict) -> dict:
    """Shape a DB answer_citations row into the AnswerCitation API payload."""
    return {
        "citation_id": row["id"],
        "answer_id": row["message_id"],
        "display_ref": row["display_ref"],
        "display_number": row["display_number"],
        "source": {
            "source_id": row["source_id"],
            "source_type": row["source_type"],
            "title": row["source_title"],
            "uri": row.get("source_uri"),
            "document_id": row.get("document_id"),
            "thread_id": row.get("thread_id"),
            "file_path": row.get("workspace_file_path"),
            "content_type": row.get("content_type"),
            "content_hash": row.get("content_hash"),
        },
        "target": row.get("target") or {"kind": "text_quote"},
        "quote": row.get("quote"),
        "status": row["status"],
        "support_score": row.get("support_score"),
        "claim_id": row.get("claim_id"),
        "problem": row.get("problem"),
    }


@router.post("/messages/{message_id}/check-citations", response_model=CheckCitationsResponse)
async def check_message_citations(
    thread_id: str,
    message_id: str,
    current_user: User = Depends(get_current_user),
):
    """Grade each citation on a message for faithful grounding, on demand.

    For every citation we compare the generated passage (with a window of
    surrounding text) against the cited source context (with a window around the
    cited span) using a utility LLM, then persist the verdict into the existing
    ``answer_citations`` status columns and flip the message into
    ``semantic-text`` ("Checked Citations") mode. Returns the refreshed citations
    so the frontend can recolor the inline chips.
    """
    await verify_thread_access(thread_id, current_user.id)
    supabase = get_supabase_client()

    msg_res = (
        supabase.table("messages")
        .select("id, content")
        .eq("id", message_id)
        .eq("thread_id", thread_id)
        .eq("user_id", current_user.id)
        .limit(1)
        .execute()
    )
    msg_row = (msg_res.data or [None])[0]
    if not msg_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Message not found")
    content = msg_row.get("content") or ""

    rows_res = (
        supabase.table("answer_citations")
        .select("*")
        .eq("message_id", message_id)
        .eq("user_id", current_user.id)
        .order("display_number")
        .execute()
    )
    rows = rows_res.data or []
    if not rows:
        return CheckCitationsResponse(
            message_id=message_id, verification_mode="semantic-text", citations=[]
        )

    verdicts = await grade_citations(content=content, rows=rows, user_id=current_user.id)

    # Persist each verdict into the existing status columns, and reflect it back
    # onto the in-memory row so the response carries the fresh grading.
    for row in rows:
        verdict = verdicts.get(row["id"])
        if not verdict:
            continue
        row["status"] = verdict["status"]
        row["support_score"] = verdict.get("support_score")
        row["problem"] = verdict.get("problem")
        row["verification_mode"] = "semantic-text"
        try:
            supabase.table("answer_citations").update(
                {
                    "status": verdict["status"],
                    "support_score": verdict.get("support_score"),
                    "problem": verdict.get("problem"),
                    "verification_mode": "semantic-text",
                }
            ).eq("id", row["id"]).eq("user_id", current_user.id).execute()
        except Exception as e:
            logger.warning(f"[CITATION-CHECK] failed to persist verdict for {row['id']}: {e}")

    try:
        supabase.table("messages").update({"verification_mode": "semantic-text"}).eq(
            "id", message_id
        ).eq("user_id", current_user.id).execute()
    except Exception as e:
        logger.warning(f"[CITATION-CHECK] failed to set message verification_mode for {message_id}: {e}")

    citations = sorted(
        (_citation_row_to_response(r) for r in rows),
        key=lambda c: c["display_number"],
    )
    return CheckCitationsResponse(
        message_id=message_id,
        verification_mode="semantic-text",
        citations=citations,
    )


def _format_phase_result(phase_name: str, result: dict) -> str:
    """Format a harness phase result as human-readable Markdown for the chat bubble."""
    from app.services.harness_engine import format_phase_result
    return format_phase_result(phase_name, result)


def _build_phase_context_block(phase_results: dict, harness_mode: str) -> str:
    """Format phase results as a context block for LLM system prompts.

    If total content exceeds 30,000 chars, includes full detail only for
    the last 2 phases and truncates earlier phases to top-level keys + 500-char excerpt.
    """
    from app.services.harnesses import get_harness

    try:
        harness_def = get_harness(harness_mode)
        phase_names = {str(i): p.name for i, p in enumerate(harness_def.phases)}
    except Exception as e:
        logger.warning(f"[HARNESS] Could not load harness def for phase names: {e}")
        phase_names = {}

    # Build full sections first (strip _tool_calls metadata — not useful for LLM context)
    sections = []
    sorted_keys = sorted(phase_results.keys(), key=lambda k: int(k) if k.isdigit() else 999)
    for key in sorted_keys:
        name = phase_names.get(key, f"Phase {key}")
        data = phase_results[key]
        if isinstance(data, dict):
            data = {k: v for k, v in data.items() if not k.startswith("_")}
        result_json = json.dumps(data, indent=2)
        sections.append((key, name, result_json))

    # Check total length
    total_len = sum(len(s[2]) for s in sections)

    lines = []
    if total_len <= 30000:
        for key, name, result_json in sections:
            lines.append(f"### Phase {key}: {name}\n{result_json}")
    else:
        # Truncate: last 2 phases full, earlier phases summarized
        cutoff = max(0, len(sections) - 2)
        for i, (key, name, result_json) in enumerate(sections):
            if i < cutoff:
                # Summarized: top-level keys + 500-char excerpt
                try:
                    raw = phase_results[key]
                    if isinstance(raw, dict):
                        top_keys = ", ".join(k for k in raw.keys() if not k.startswith("_"))
                    else:
                        top_keys = str(type(raw).__name__)
                except Exception:
                    top_keys = "unknown"
                excerpt = result_json[:500] + ("..." if len(result_json) > 500 else "")
                lines.append(f"### Phase {key}: {name} (truncated)\nKeys: {top_keys}\n{excerpt}")
            else:
                lines.append(f"### Phase {key}: {name}\n{result_json}")

    return "\n\n".join(lines)


# Sentinel token for gatekeeper trigger detection.
# Using an opaque token reduces prompt-injection risk vs a human-readable keyword.
_GATEKEEPER_SENTINEL = "[[__HARNESS_GO_7f3a__]]"
# Buffer must hold at least the full sentinel so we can detect it before flushing.
# +3 accounts for possible trailing whitespace between final text and sentinel.
_SENTINEL_BUFFER_SIZE = len(_GATEKEEPER_SENTINEL) + 3


async def _run_gatekeeper(
    thread_id: str,
    user_id: str,
    harness_def,
    messages: list[dict],
    supabase,
    result: dict,
) -> AsyncGenerator[str, None]:
    """Gatekeeper LLM — conversational pre-harness check. Yields SSE lines.

    Sets result["trigger"] (bool) and result["message"] (str) on the mutable dict.
    """
    from app.services.llm_service import astream_chat_response

    prereqs = harness_def.prerequisites

    # Query workspace for uploaded files (thread_id implies user ownership via RLS,
    # but filter explicitly for defense-in-depth)
    file_result = (
        supabase.table("workspace_files")
        .select("file_path, content_type, size_bytes")
        .eq("thread_id", thread_id)
        .eq("source", "upload")
        .execute()
    )
    # Note: workspace_files has RLS tied to thread ownership; explicit user_id filter
    # is not needed here since threads table enforces user_id via foreign key.
    uploaded_files = file_result.data or []

    if uploaded_files:
        file_listing = "\n".join(
            f"- {f['file_path']} ({f.get('content_type', 'unknown')}, {f.get('size_bytes', 0):,} bytes)"
            for f in uploaded_files
        )
    else:
        file_listing = "No files uploaded yet."

    system_prompt = (
        f'You are the gatekeeper for the "{harness_def.display_name}" workflow.\n'
        f"{prereqs.harness_intro}\n\n"
        f"Your job is to:\n"
        f"1. Greet the user briefly.\n"
        f"2. Check if the required files are uploaded.\n"
        f"3. If prerequisites are met: acknowledge the uploaded file by name, tell the user you're beginning the analysis now, and end your message with the exact token {_GATEKEEPER_SENTINEL}.\n"
        f"4. If prerequisites are NOT met: ask the user to upload what's needed. Do NOT include {_GATEKEEPER_SENTINEL}.\n\n"
        f"Required: {prereqs.upload_description}\n\n"
        f"Files currently uploaded to this thread:\n{file_listing}\n\n"
        f"IMPORTANT:\n"
        f"- Do NOT analyze or process the document yourself.\n"
        f"- Do NOT include {_GATEKEEPER_SENTINEL} unless all prerequisites are satisfied.\n"
        f"- When prerequisites ARE met, do NOT ask the user to confirm or say you're 'ready when they are' — just say you're starting now.\n"
        f"- Keep it short — 2-3 sentences max.\n"
        f"- Be conversational and helpful. You're the friendly front door to this workflow."
    )

    full_text = ""
    # Buffer to hold the tail of streamed text for sentinel detection
    buffer = ""

    # Gatekeeper is a fixed meta-prompt — intentionally on the env model, not
    # the user's per-message model/thinking override.
    async for event in astream_chat_response(
        messages=messages,
        tools=None,
        user_id=user_id,
        system_prompt=system_prompt,
    ):
        if event["type"] == "text_delta":
            chunk = event["content"]
            buffer += chunk
            # Only emit text that's safely before the sentinel buffer zone
            if len(buffer) > _SENTINEL_BUFFER_SIZE:
                emit = buffer[:-_SENTINEL_BUFFER_SIZE]
                buffer = buffer[-_SENTINEL_BUFFER_SIZE:]
                full_text += emit
                sse_data = json.dumps({"type": "text_delta", "content": emit})
                yield f"data: {sse_data}\n\n"
        elif event["type"] == "response_complete":
            pass  # We handle completion below

    # Flush remaining buffer
    full_text += buffer

    # Check for sentinel
    if full_text.rstrip().endswith(_GATEKEEPER_SENTINEL):
        clean_text = full_text.rstrip()[:-len(_GATEKEEPER_SENTINEL)].rstrip()
        # We already emitted (full_text - buffer) worth of text via streaming.
        # The buffer was held back. Now emit the clean portion of the buffer
        # (i.e., clean_text minus what was already streamed).
        already_emitted = len(full_text) - len(buffer)
        remaining = clean_text[already_emitted:] if already_emitted <= len(clean_text) else ""
        if remaining:
            sse_data = json.dumps({"type": "text_delta", "content": remaining})
            yield f"data: {sse_data}\n\n"
        result["trigger"] = True
        result["message"] = clean_text
    else:
        # No sentinel — emit remaining buffer as-is
        if buffer:
            sse_data = json.dumps({"type": "text_delta", "content": buffer})
            yield f"data: {sse_data}\n\n"
        result["trigger"] = False
        result["message"] = full_text


async def _run_harness_flow(
    thread_id: str,
    user_id: str,
    harness_mode: str,
    messages: list[dict],
    supabase,
) -> AsyncGenerator[str, None]:
    """Route harness mode messages through the harness engine. Yields SSE lines.

    State-based routing:
    1. Completed run → emit harness_followup signal for caller to fall through to normal LLM
    2. Active run (pending/running/paused) → resume harness execution
    3. No run (or most recent failed) → gatekeeper (if prerequisites defined) → create run
    """
    from app.services.harness_engine import (
        HarnessEngine, create_harness_run, get_harness_run_any,
    )
    from app.services.harnesses import get_harness
    from app.services.todo_service import write_todos

    try:
        async for sse_line in _run_harness_flow_inner(
            thread_id, user_id, harness_mode, messages, supabase,
        ):
            yield sse_line
    except Exception as e:
        logger.error(f"[HARNESS] Unhandled error in harness flow: {e}", exc_info=True)
        error_event = json.dumps({"type": "error", "message": "An error occurred during the harness workflow."})
        yield f"data: {error_event}\n\n"
        yield f"event: done\ndata: {{}}\n\n"


async def _run_harness_flow_inner(
    thread_id: str,
    user_id: str,
    harness_mode: str,
    messages: list[dict],
    supabase,
) -> AsyncGenerator[str, None]:
    """Inner implementation of harness flow, wrapped by _run_harness_flow for error handling."""
    from app.services.harness_engine import (
        HarnessEngine, create_harness_run, get_harness_run_any,
    )
    from app.services.harnesses import get_harness
    from app.services.todo_service import write_todos

    harness_def = get_harness(harness_mode)

    # --- State-based routing (single DB query) ---
    # Fetch the most recent run (any status) and route based on its state.
    most_recent_run = await get_harness_run_any(thread_id, user_id)

    # 1. Completed run → follow-up mode
    if most_recent_run and most_recent_run["status"] == "completed":
        yield f"data: {json.dumps({'type': 'harness_followup', 'phase_results': most_recent_run['phase_results']})}\n\n"
        yield f"event: done\ndata: {{}}\n\n"
        return

    # 2. Active run (pending/running/paused) → resume harness execution
    if most_recent_run and most_recent_run["status"] in ("pending", "running", "paused"):
        run = most_recent_run

        # Handle human-input resume: if paused at a llm_human_input phase,
        # capture the user's message as the context response
        if run["status"] == "paused":
            from app.services.harness_engine import update_harness_phase
            from app.services.workspace_service import write_file as ws_write_file

            current_phase_idx = run.get("current_phase", 0)
            harness_def_for_resume = get_harness(run["harness_type"])
            if current_phase_idx < len(harness_def_for_resume.phases):
                phase_def = harness_def_for_resume.phases[current_phase_idx]
                if phase_def.phase_type.value == "llm_human_input":
                    # Write user's response to workspace
                    user_msg_content = messages[-1]["content"] if messages else ""
                    if phase_def.workspace_output:
                        await ws_write_file(thread_id, phase_def.workspace_output, user_msg_content, user_id)

                    # Mark the phase as complete
                    await update_harness_phase(
                        run["id"], current_phase_idx,
                        {"user_response": user_msg_content, "_summary": f"User context: {user_msg_content[:100]}"},
                        user_id,
                    )

                    # Update run reference — current_phase now points to next phase
                    run = await get_harness_run_any(thread_id, user_id)
    else:
        # 3. No run (or most recent is failed) → gatekeeper
        if harness_def.prerequisites is not None:
            gatekeeper_result = {}
            async for sse_line in _run_gatekeeper(
                thread_id, user_id, harness_def, messages, supabase, gatekeeper_result
            ):
                yield sse_line

            # Persist gatekeeper message (no harness_mode — it's conversational,
            # not phase output, so it should render as normal text on reload)
            gatekeeper_msg = gatekeeper_result.get("message", "")
            if gatekeeper_msg:
                supabase.table("messages").insert({
                    "thread_id": thread_id,
                    "user_id": user_id,
                    "role": "assistant",
                    "content": gatekeeper_msg,
                    "created_at": datetime.utcnow().isoformat(),
                    "sequence_number": await _next_sequence_number(thread_id),
                }).execute()

            if not gatekeeper_result.get("trigger"):
                # Gatekeeper didn't trigger — done for this message
                yield f"event: done\ndata: {{}}\n\n"
                return

            # Gatekeeper triggered — fall through to create run

        # Create harness run
        file_result = (
            supabase.table("workspace_files")
            .select("id")
            .eq("thread_id", thread_id)
            .eq("source", "upload")
            .execute()
        )
        input_file_ids = [f["id"] for f in (file_result.data or [])]

        run = await create_harness_run(
            thread_id=thread_id,
            harness_type=harness_mode,
            input_file_ids=input_file_ids,
            config={},
            user_id=user_id,
        )

    harness_def = get_harness(run["harness_type"])
    start_phase = run.get("current_phase", 0)

    # Write harness phases to agent_todos (Task 12)
    todo_items = [
        {
            "content": f"[{harness_def.display_name}] Phase {i + 1}: {phase.name}",
            "status": "completed" if str(i) in run.get("phase_results", {}) else ("in_progress" if i == start_phase else "pending"),
            "position": i,
        }
        for i, phase in enumerate(harness_def.phases)
    ]
    await write_todos(thread_id, todo_items, user_id)

    # Emit initial todos_updated event
    todos_data = json.dumps({"type": "todos_updated", "todos": todo_items})
    yield f"data: {todos_data}\n\n"

    # Run the harness engine
    accumulated_text = ""
    harness_completed = False
    cancel_event = asyncio.Event()
    engine = HarnessEngine(
        harness_def=harness_def,
        run_id=run["id"],
        thread_id=thread_id,
        user_id=user_id,
        cancel_event=cancel_event,
    )

    harness_paused = False
    human_input_question = ""
    active_phase_is_human_input = False
    phases_since_last_message: list[int] = []

    async for event in engine.run(start_phase=start_phase):
        event_type = event.get("type", "")

        # Track when we enter a human_input phase
        if event_type == "harness_phase_start":
            pi = event.get("phase_index", 0)
            active_phase_is_human_input = (
                pi < len(harness_def.phases)
                and harness_def.phases[pi].phase_type.value == "llm_human_input"
            )

        # Stream text_delta from human_input phases (renders in chat bubble)
        if event_type == "text_delta":
            if active_phase_is_human_input:
                human_input_question += event.get("content", "")
                sse_data = json.dumps({"type": "text_delta", "content": event.get("content", "")})
                yield f"data: {sse_data}\n\n"
            continue

        # Forward non-text lifecycle events as SSE
        data = json.dumps(event)
        yield f"data: {data}\n\n"

        # Update todos on phase transitions
        if event_type == "harness_phase_start":
            idx = event.get("phase_index", 0)
            for t in todo_items:
                if t["position"] == idx:
                    t["status"] = "in_progress"
            todos_data = json.dumps({"type": "todos_updated", "todos": todo_items})
            yield f"data: {todos_data}\n\n"

        elif event_type == "harness_phase_complete":
            idx = event.get("phase_index", 0)
            phases_since_last_message.append(idx)
            for t in todo_items:
                if t["position"] == idx:
                    t["status"] = "completed"
            await write_todos(thread_id, todo_items, user_id)
            todos_data = json.dumps({"type": "todos_updated", "todos": todo_items})
            yield f"data: {todos_data}\n\n"

        elif event_type == "harness_phase_error":
            idx = event.get("phase_index", 0)
            for t in todo_items:
                if t["position"] == idx:
                    t["status"] = "pending"  # Reset to pending on error
            await write_todos(thread_id, todo_items, user_id)
            todos_data = json.dumps({"type": "todos_updated", "todos": todo_items})
            yield f"data: {todos_data}\n\n"

        # Accumulate formatted phase results for DB storage only — the phase
        # panels already display results, so don't emit as text_delta.
        elif event_type == "harness_phase_result":
            summary = _format_phase_result(event.get("phase_name", ""), event.get("result", {}))
            if summary:
                accumulated_text += summary

        elif event_type == "workspace_file_written":
            file_rec = event.get("file", {})
            is_created = file_rec.get("created_at") == file_rec.get("updated_at")
            ws_event_type = "workspace_file_created" if is_created else "workspace_file_updated"
            ws_event = json.dumps({
                "type": ws_event_type,
                "id": file_rec.get("id"),
                "thread_id": thread_id,
                "file_path": file_rec.get("file_path"),
                "size_bytes": file_rec.get("size_bytes"),
                "content_type": file_rec.get("content_type"),
                "source": file_rec.get("source"),
            })
            yield f"data: {ws_event}\n\n"
            continue  # Don't forward the raw engine event

        elif event_type == "harness_human_input_required":
            harness_paused = True
            phases_since_last_message.append(event.get("phase_index", 0))
            # Persist the LLM-generated question as an assistant message
            question_text = event.get("question", human_input_question)
            if question_text:
                supabase.table("messages").insert({
                    "thread_id": thread_id,
                    "user_id": user_id,
                    "role": "assistant",
                    "content": question_text,
                    "created_at": datetime.utcnow().isoformat(),
                    "sequence_number": await _next_sequence_number(thread_id),
                    "harness_phases_before": phases_since_last_message.copy() if phases_since_last_message else None,
                }).execute()
                phases_since_last_message.clear()

        elif event_type == "harness_complete":
            harness_completed = True

    # Post-harness summary LLM (thin orchestrator message)
    if harness_completed:
        from app.services.harness_engine import get_harness_run_any
        from app.services.workspace_service import read_file as ws_read_file
        from app.services.token_service import estimate_tokens

        report_filename = "contract-review-report.md"
        try:
            run_data = await get_harness_run_any(thread_id, user_id)
            phase_results = run_data.get("phase_results", {}) if run_data else {}
            if phase_results:
                # Build context from workspace files (not raw phase_results)
                workspace_context_parts = []
                for ws_file in ["contract-review-report.md", "risk-analysis.md", "redlines.md"]:
                    try:
                        content = await ws_read_file(thread_id, ws_file, user_id)
                        # Cap each file at ~2000 tokens
                        token_count = estimate_tokens(content)
                        if token_count > 2000:
                            # Approximate: trim to ratio-based char limit
                            char_limit = int(len(content) * 2000 / token_count)
                            content = content[:char_limit] + "\n\n... (truncated — full content in workspace)"
                        workspace_context_parts.append(f"### {ws_file}\n{content}")
                    except FileNotFoundError:
                        pass

                workspace_context = "\n\n".join(workspace_context_parts) if workspace_context_parts else ""

                # Build slim phase summaries from _summary keys
                phase_summaries = []
                for key in sorted(phase_results.keys(), key=lambda k: int(k) if k.isdigit() else 999):
                    result = phase_results[key]
                    summary = result.get("_summary", "") if isinstance(result, dict) else ""
                    phase_idx = int(key) if key.isdigit() else 0
                    phase_name = harness_def.phases[phase_idx].name if phase_idx < len(harness_def.phases) else f"Phase {key}"
                    phase_summaries.append(f"- Phase {phase_idx + 1} ({phase_name}): {summary or 'Complete'}")

                phase_summary_text = "\n".join(phase_summaries)

                post_harness_prompt = (
                    f'You are providing a brief summary after a "{harness_def.display_name}" has completed.\n\n'
                    f"This is a CONTINUATION of the conversation. "
                    f"Do NOT greet the user again. Jump straight into the summary.\n\n"
                    f"Phase summaries:\n{phase_summary_text}\n\n"
                    f"Workspace analysis:\n{workspace_context}\n\n"
                    f'The full report has been saved to the workspace as "{report_filename}".\n\n'
                    f"Provide a concise conversational summary (~500 tokens max):\n"
                    f"- Overall risk assessment\n"
                    f"- 2-3 key findings worth highlighting\n"
                    f"- Where to find the full report\n"
                    f"- Invite the user to ask follow-up questions\n\n"
                    f"Keep it brief — the full report is in the workspace."
                )

                summary_messages = [{"role": "user", "content": messages[-1]["content"]}] if messages else []
                summary_text = ""
                last_usage_event = None
                # Post-harness summary is a fixed meta-prompt — intentionally on
                # the env model, not the user's per-message override.
                async for event in astream_chat_response(
                    messages=summary_messages,
                    tools=None,
                    user_id=user_id,
                    system_prompt=post_harness_prompt,
                ):
                    if event["type"] == "text_delta":
                        summary_text += event["content"]
                        sse_data = json.dumps({"type": "text_delta", "content": event["content"]})
                        yield f"data: {sse_data}\n\n"
                    elif event["type"] == "usage":
                        last_usage_event = event

                # Emit usage event so frontend shows token counter
                if last_usage_event:
                    yield f"data: {json.dumps(last_usage_event)}\n\n"

                # Persist the slim summary as the assistant message (not full phase output)
                if summary_text:
                    supabase.table("messages").insert({
                        "thread_id": thread_id,
                        "user_id": user_id,
                        "role": "assistant",
                        "content": summary_text,
                        "harness_mode": harness_mode,
                        "created_at": datetime.utcnow().isoformat(),
                        "sequence_number": await _next_sequence_number(thread_id),
                        "harness_phases_before": phases_since_last_message.copy() if phases_since_last_message else None,
                    }).execute()
                    phases_since_last_message.clear()
        except Exception as e:
            logger.warning(f"[HARNESS] Post-harness summary failed: {e}")
            # Fallback: persist a minimal assistant message so reload shows something
            try:
                supabase.table("messages").insert({
                    "thread_id": thread_id,
                    "user_id": user_id,
                    "role": "assistant",
                    "content": f"Contract review completed. Full results are available in the workspace files.",
                    "harness_mode": harness_mode,
                    "created_at": datetime.utcnow().isoformat(),
                    "sequence_number": await _next_sequence_number(thread_id),
                    "harness_phases_before": phases_since_last_message.copy() if phases_since_last_message else None,
                }).execute()
                phases_since_last_message.clear()
            except Exception:
                logger.warning("[HARNESS] Failed to persist fallback message")

    # Done event — must use `event: done` format for frontend to recognize it
    yield f"event: done\ndata: {{}}\n\n"


@router.post("/messages")
async def send_message(
    thread_id: str,
    message_data: MessageCreate,
    current_user: User = Depends(get_current_user)
):
    """Send a message and stream the assistant's response via SSE."""
    await verify_thread_access(thread_id, current_user.id)
    supabase = get_supabase_client()

    # Store user message in database
    now = datetime.utcnow().isoformat()
    harness_mode = message_data.harness_mode
    deep_mode = message_data.deep_mode or bool(harness_mode)
    # Per-message model + reasoning override (UI-selected via the composer).
    # Empty model falls back to env LLM_MODEL inside astream_chat_response.
    model_override = message_data.model
    thinking = message_data.thinking
    reasoning_effort = message_data.reasoning_effort
    user_seq = await _next_sequence_number(thread_id)
    attachment_metadata = await _resolve_workspace_attachment_metadata(
        thread_id=thread_id,
        user_id=current_user.id,
        file_paths=message_data.attachment_file_paths,
    )
    user_insert_data = {
        "thread_id": thread_id,
        "user_id": current_user.id,
        "role": "user",
        "content": message_data.content,
        "deep_mode": deep_mode,
        "harness_mode": harness_mode,
        "created_at": now,
        "sequence_number": user_seq,
    }
    if attachment_metadata:
        user_insert_data["attachments"] = attachment_metadata
    user_message_result = supabase.table("messages").insert(user_insert_data).execute()

    if not user_message_result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save user message"
        )

    # Get full message history for context
    messages = get_thread_messages(thread_id)

    # Check if web search is enabled
    web_search_enabled = get_web_search_settings() is not None
    registry_enabled = get_settings().tool_registry_enabled

    # Build tools - document search is always included (will return empty if no docs)
    # and web search is conditional.
    tools = build_rag_tools(
        include_web_search=web_search_enabled,
        include_sql=bool(get_settings().sql_reader_database_url),
        include_code_execution=get_settings().sandbox_enabled,
    )

    # Workspace tools are always available (decoupled from deep mode)
    tools.extend(build_workspace_tools())

    # Planning and delegation tools only in deep mode
    if deep_mode:
        tools.extend(build_planning_tools())
        tools.extend(build_delegation_tools())

    async def generate():
        """Generate SSE events with tool-calling loop."""
        all_round_texts = []  # Collect all round texts for title generation
        total_tool_call_count = 0  # For tracing
        current_messages = list(messages)
        rounds = 0
        last_usage = None  # Track token usage across rounds

        # Citation Modes: one CitationContext per assistant turn. Aliases assigned
        # during this turn are answer-local; canonical span_ids stay stable across
        # turns so older answers keep working.
        citation_turn_id = f"turn_{_uuid.uuid4().hex[:8]}"
        citation_ctx = CitationContext(turn_id=citation_turn_id)
        # Plan 23 B: rehydrate thread-stable citation numbering so prior-turn
        # passages keep the same {[S#]} token across the conversation. Best-effort
        # -- any failure (e.g. column not yet migrated) falls back to fresh
        # per-turn numbering (Phase A behaviour).
        try:
            _reg_row = get_supabase_client().table("threads").select(
                "citation_aliases"
            ).eq("id", thread_id).maybe_single().execute()
            _registry = (_reg_row.data or {}).get("citation_aliases") if _reg_row else None
            if _registry:
                citation_ctx.seed_persisted_aliases(_registry)
        except Exception as _seed_err:
            logger.warning(f"[CITATION] failed to seed thread citation registry: {_seed_err}")
        citation_verification_mode = "unverified"
        # Quick-mode inline citations: aliases are registered at tool-execution
        # time, so we stream the alias->source map to the frontend as it grows
        # (after each tool round) and chips light up the moment their {[S#]}
        # token streams in. This cursor tracks how many aliases we've already
        # streamed so each round emits only the new ones.
        streamed_alias_count = 0
        # That map is lightweight (source chip only). The moment the model
        # actually cites a {[S#]} in the answer text, we upgrade that one chip to
        # a full citation (with target.exact) so a click can scroll the source
        # preview to the cited passage *while still streaming* -- not just after
        # the end-of-turn citation_metadata. This set tracks numbers upgraded so
        # each is sent once.
        cited_full_numbers: set[int] = set()
        # Dynamic tool injection: track tools loaded via tool_search.
        # Restore from message history so tools activated in earlier messages
        # remain available across the entire conversation.
        active_tools: set[str] = set()
        if registry_enabled:
            from app.services.tool_registry import get_tool_registry as _get_reg_init
            _reg_init = _get_reg_init()
            for msg in current_messages:
                for tc in (msg.get("tool_calls") or []):
                    tn = tc.get("tool_name") or tc.get("name", "")
                    # Restore tools that were previously used (called directly)
                    if tn and tn not in active_tools:
                        td = _reg_init.get(tn)
                        if td and td.loading.value == "deferred":
                            active_tools.add(tn)
                    # Restore tools that were discovered via tool_search
                    # (even if never actually called yet)
                    if tn == "tool_search" and tc.get("result"):
                        try:
                            search_results = json.loads(tc["result"])
                            if isinstance(search_results, list):
                                for sr in search_results:
                                    sr_name = sr.get("name", "") if isinstance(sr, dict) else ""
                                    if sr_name and sr.get("loading") == "deferred":
                                        active_tools.add(sr_name)
                        except (json.JSONDecodeError, TypeError):
                            pass
            if active_tools:
                logger.debug(f"[CHAT] Restored active_tools from history: {active_tools}")


        # Fire title generation immediately for first message (background task)
        title_task = None
        is_first_exchange = len(messages) == 1
        if is_first_exchange:
            title_task = asyncio.create_task(
                generate_title_for_thread(thread_id, message_data.content)
            )

        # Wrap the entire chat processing in a LangSmith trace.
        # Using the trace context manager inside the async generator ensures
        # all LLM calls (main chat, tool execution, sub-agents, title generation)
        # appear as children of a single parent trace in LangSmith.
        trace_ctx = trace(
            "chat_request",
            run_type="chain",
            inputs={
                "thread_id": thread_id,
                "user_message": message_data.content,
                "message_count": len(messages),
            },
            tags=["chat"],
        ) if is_tracing_enabled() else None

        try:
            if trace_ctx:
                await trace_ctx.__aenter__()

            redaction_enabled = get_settings().pii_redaction_enabled
            redaction_svc = None
            if redaction_enabled:
                redaction_svc = await create_thread_redaction_service(thread_id)
                logger.debug(f"[CHAT] Created thread redaction service for thread={thread_id}")
            else:
                logger.debug(f"[CHAT] PII redaction disabled, skipping for thread={thread_id}")

            # Pre-anonymize messages (skip when redaction is disabled)
            anon_messages = []
            if redaction_svc:
                status_data = json.dumps({"type": "redaction_status", "stage": "anonymizing"})
                yield f"data: {status_data}\n\n"

                msgs_needing_anon_update = []
                cached_count = 0
                for msg in current_messages:
                    if msg["role"] == "assistant" and msg.get("tool_calls"):
                        # Rebuild tool call + result messages before the text
                        tool_msgs = _rebuild_tool_messages(msg["tool_calls"])
                        for tm in tool_msgs:
                            if tm["role"] == "tool":
                                tm["content"] = await redaction_svc.anonymize(tm["content"])
                            anon_messages.append(tm)
                        # Then add the assistant text response
                        if msg.get("anonymized_content"):
                            anon_messages.append({"role": "assistant", "content": msg["anonymized_content"]})
                            cached_count += 1
                        elif msg.get("content"):
                            anon_content = await redaction_svc.anonymize(msg["content"])
                            anon_messages.append({"role": "assistant", "content": anon_content})
                            if msg.get("id"):
                                msgs_needing_anon_update.append((msg["id"], anon_content))
                    elif msg.get("anonymized_content"):
                        # Cached from a prior request — skip Presidio
                        anon_messages.append({
                            "role": msg["role"],
                            "content": msg["anonymized_content"],
                        })
                        cached_count += 1
                    elif msg.get("content") and msg["role"] in ("user", "assistant"):
                        anon_content = await redaction_svc.anonymize(msg["content"])
                        logger.debug(
                            f"[CHAT] Anonymized {msg['role']} msg: "
                            f"'{msg['content'][:80]}' => '{anon_content[:80]}'"
                        )
                        anon_messages.append({"role": msg["role"], "content": anon_content})
                        if msg.get("id"):
                            msgs_needing_anon_update.append((msg["id"], anon_content))
                    else:
                        anon_messages.append({
                            "role": msg["role"],
                            "content": msg.get("content"),
                        })

                logger.debug(
                    f"[CHAT] Pre-anonymized {len(current_messages)} messages "
                    f"({cached_count} cached, {len(current_messages) - cached_count} fresh)"
                )

                # Persist anonymized_content for newly processed messages
                for msg_id, anon_content in msgs_needing_anon_update:
                    supabase.table("messages").update(
                        {"anonymized_content": anon_content}
                    ).eq("id", msg_id).execute()
            else:
                # No redaction — pass messages through as-is,
                # but rebuild tool call context from stored tool_calls
                for msg in current_messages:
                    if msg["role"] == "assistant" and msg.get("tool_calls"):
                        anon_messages.extend(_rebuild_tool_messages(msg["tool_calls"]))
                        if msg.get("content"):
                            anon_messages.append({"role": "assistant", "content": msg["content"]})
                    else:
                        anon_messages.append({"role": msg["role"], "content": msg.get("content")})

            # Context compaction (post-anonymization, pre-LLM).
            # Compaction operates on the freshly-anonymized history so PII never
            # leaks into the persisted summary text.
            if get_settings().compaction_enabled:
                compaction_svc = None
                raw_for_compact: list[dict] = []
                try:
                    from app.services.llm_service import get_global_llm_settings as _get_llm_settings_for_compact
                    compaction_svc = await create_thread_compaction_service(
                        thread_id, current_user.id
                    )
                    raw_for_compact = supabase.table("messages").select(
                        "id, role, content, anonymized_content, tool_calls, sequence_number"
                    ).eq("thread_id", thread_id).order("sequence_number").execute().data or []
                    active_model = _get_llm_settings_for_compact()["model"]
                    compaction_result = await compaction_svc.compact(
                        raw_for_compact, model=active_model
                    )
                    if compaction_result.action != "none":
                        anon_messages = _materialize_compacted(
                            compaction_result.compacted_messages
                        )
                        event_payload = {
                            "type": "compaction_status",
                            "action": compaction_result.action,
                            "compaction_id": (
                                compaction_result.compaction_row["id"]
                                if compaction_result.compaction_row
                                else None
                            ),
                        }
                        yield f"data: {json.dumps(event_payload)}\n\n"
                        logger.info(
                            f"[CHAT] Compacted thread={thread_id} action={compaction_result.action}"
                        )
                except Exception as e:
                    # H3: outer compaction failure left anon_messages untouched
                    # (still oversized history that needed compacting). Without
                    # a fallback this falls straight into a context-overflow
                    # LLM error a moment later, with no causal link in the UI.
                    # Best-effort: extend the in-service philosophy outward by
                    # running an in-memory Stage-B window drop here too.
                    logger.warning(
                        f"[COMPACTION] failed for thread={thread_id}: {e}",
                        exc_info=True,
                    )
                    fallback_action = "failed"
                    fallback_compaction_id = None
                    if compaction_svc is not None and raw_for_compact:
                        try:
                            head_raws, _middle_raws, tail_raws = compaction_svc._partition(
                                raw_for_compact
                            )
                            head_view = compaction_svc._build_openai_view(head_raws)
                            tail_view = compaction_svc._build_openai_view(tail_raws)
                            anon_messages = _materialize_compacted(head_view + tail_view)
                            fallback_action = "window"
                        except Exception as fallback_err:
                            logger.error(
                                f"[COMPACTION] fallback window-drop also failed for "
                                f"thread={thread_id}: {fallback_err}",
                                exc_info=True,
                            )
                    # H4: SSE payload carries no exception detail -- user-facing
                    # error strings are kept generic (matches the harness flow
                    # precedent at chat.py:426-428). Full traceback goes to
                    # logger above.
                    yield (
                        "data: "
                        + json.dumps(
                            {
                                "type": "compaction_status",
                                "action": fallback_action,
                                "compaction_id": fallback_compaction_id,
                            }
                        )
                        + "\n\n"
                    )

            attached_file_paths = await _attach_workspace_images_to_latest_user_message(
                anon_messages,
                thread_id=thread_id,
                user_id=current_user.id,
                file_paths=message_data.attachment_file_paths,
            )
            if attached_file_paths:
                logger.debug(f"[CHAT] attachments included in prompt: {attached_file_paths}")

            # Emit agent_status working event for deep mode
            if deep_mode:
                agent_working = json.dumps({"type": "agent_status", "status": "working"})
                yield f"data: {agent_working}\n\n"

            # --- Harness mode routing ---
            followup_phase_results = None
            if harness_mode:
                async for sse_line in _run_harness_flow(
                    thread_id=thread_id,
                    user_id=current_user.id,
                    harness_mode=harness_mode,
                    messages=anon_messages,
                    supabase=supabase,
                ):
                    # Intercept harness_followup event
                    if sse_line.startswith("data: "):
                        try:
                            evt = json.loads(sse_line[6:].strip())
                            if evt.get("type") == "harness_followup":
                                followup_phase_results = evt.get("phase_results", {})
                                continue  # Don't yield this internal event to frontend
                        except (json.JSONDecodeError, KeyError):
                            pass
                    yield sse_line

                if followup_phase_results is None:
                    # Harness (or gatekeeper) handled everything — skip normal LLM loop
                    if trace_ctx:
                        await trace_ctx.__aexit__(None, None, None)
                    return

                # Fall through to normal LLM loop with phase context injected

            # Inject phase context for follow-up mode
            followup_system_extra = ""
            if followup_phase_results:
                phase_context = _build_phase_context_block(followup_phase_results, harness_mode)
                followup_system_extra = (
                    f"\n\n## Prior Harness Results\n"
                    f"A {harness_mode.replace('_', ' ').title()} harness was previously completed. "
                    f"The results are below for reference when answering follow-up questions:\n\n"
                    f"{phase_context}"
                )

            # Build system prompt override (computed once, not per round). We always
            # append the citation-mode instruction so the model emits inline [S#]
            # references when search_documents returned evidence.
            from app.services.llm_service import get_system_prompt as _get_system_prompt
            base_system_prompt = _get_system_prompt(user_id=current_user.id, deep_mode=deep_mode)
            citation_addendum = "\n\n## Citations\n" + CITATION_SYSTEM_PROMPT
            followup_sys_prompt = base_system_prompt + (followup_system_extra or "") + citation_addendum

            # Round-1 forced retrieval. With tool_choice="auto" the model often
            # answers from general knowledge and skips search_documents entirely,
            # so the answer isn't grounded and no citations are produced. For a
            # RAG product we require a document search on the first round when the
            # user actually has documents and the message isn't a trivial
            # greeting. Deep/harness/registry modes manage their own tool flow, so
            # only force in the plain quick-chat path. After round 1 we fall back
            # to "auto" so the model can stop searching and synthesize an answer.
            force_first_search = (
                not deep_mode
                and not harness_mode
                and not registry_enabled
                and _message_warrants_search(message_data.content)
                and user_has_documents(current_user.id)
            )

            max_rounds = get_max_tool_rounds()
            while rounds < max_rounds:
                rounds += 1

                # When tool registry is enabled, dynamically build tools array
                # with immediate tools + any tools loaded via tool_search
                if registry_enabled:
                    from app.services.tool_registry import get_tool_registry
                    registry = get_tool_registry()
                    immediate = registry.get_immediate_tools()
                    active = registry.get_active_tools(active_tools)
                    round_tools = immediate + active
                    if deep_mode:
                        round_tools.extend(build_planning_tools())
                        round_tools.extend(build_delegation_tools())
                    if active_tools:
                        active_names = [t["function"]["name"] for t in active]
                        logger.debug(f"[CHAT] Round {rounds}: active_tools={active_tools}, injected schemas={active_names}")
                else:
                    round_tools = tools

                # Force search_documents on the first round (grounded-by-default);
                # let the model choose freely afterwards so it can synthesize.
                round_tool_choice = None
                if force_first_search and rounds == 1:
                    round_tool_choice = {
                        "type": "function",
                        "function": {"name": "search_documents"},
                    }
                    logger.debug("[CHAT] Round 1: forcing tool_choice=search_documents")

                # Buffer text response for de-anonymization
                text_buffer = ""
                had_tool_calls = False
                round_text = ""  # Non-redacted text for this round
                round_tool_calls = []  # Tool calls for this round

                async for event in astream_chat_response(anon_messages, tools=round_tools, user_id=current_user.id, deep_mode=deep_mode, system_prompt=followup_sys_prompt, model_override=model_override, thinking=thinking, reasoning_effort=reasoning_effort, tool_choice=round_tool_choice):
                    if event["type"] == "usage":
                        # Use the latest call's raw usage — this reflects the
                        # actual context window size the LLM saw on its final
                        # call, which is what the frontend displays.
                        last_usage = event
                        continue

                    if event["type"] == "text_delta":
                        if redaction_svc:
                            # Buffer text for de-anonymization at end
                            text_buffer += event["content"]
                        else:
                            # Stream directly to frontend (no redaction needed)
                            round_text += event["content"]
                            data = json.dumps({"content": event["content"]})
                            yield f"event: text_delta\ndata: {data}\n\n"
                            # As soon as a {[S#]} citation completes, upgrade that
                            # chip from the lightweight alias map to a full
                            # citation (target.exact) so clicking it mid-stream
                            # navigates the source preview to the cited passage.
                            # Gate on a closing bracket so we only re-parse when a
                            # token may have just finished.
                            if "}" in event["content"] or "]" in event["content"]:
                                fresh_citations = build_newly_cited_full_citations(
                                    citation_ctx,
                                    round_text,
                                    already_sent=cited_full_numbers,
                                    answer_id=citation_turn_id,
                                    thread_id=thread_id,
                                )
                                if fresh_citations:
                                    cite_event = json.dumps({
                                        "type": "citation_alias",
                                        "verification_mode": "unverified",
                                        "citations": fresh_citations,
                                    })
                                    yield f"data: {cite_event}\n\n"

                    elif event["type"] == "tool_call_pending":
                        # Early notification: LLM has started generating a tool call
                        # but arguments are still streaming. Forward to frontend
                        # so it can show an immediate "thinking" indicator.
                        pending_data = json.dumps({
                            "type": "tool_call_pending",
                            "tool_name": event["name"],
                        })
                        yield f"data: {pending_data}\n\n"

                    elif event["type"] == "tool_call_delta":
                        # Stream argument chunks so the frontend can show
                        # a live preview (e.g. code being written).
                        delta_data = json.dumps({
                            "type": "tool_call_delta",
                            "tool_name": event["name"],
                            "arguments_delta": event["arguments_delta"],
                        })
                        yield f"data: {delta_data}\n\n"

                    elif event["type"] == "tool_calls":
                        had_tool_calls = True
                        logger.debug(f"[CHAT] Tool calls received: {[tc['name'] for tc in event['tool_calls']]}")
                        # Execute tool calls and add results to messages
                        tool_calls = event["tool_calls"]

                        # Add assistant message with tool calls to both lists
                        tc_msg = {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": tc["id"],
                                    "type": "function",
                                    "function": {
                                        "name": tc["name"],
                                        "arguments": tc["arguments"],
                                    }
                                }
                                for tc in tool_calls
                            ],
                        }
                        current_messages.append(tc_msg)
                        anon_messages.append(tc_msg)

                        # Auto-activate deferred tools called directly (without tool_search).
                        # LLMs see tool names in the catalog and may skip tool_search,
                        # calling deferred tools that aren't in the tools array yet.
                        # Adding them to active_tools ensures they appear in the tools
                        # array for subsequent rounds and in observability traces.
                        if registry_enabled:
                            from app.services.tool_registry import get_tool_registry as _get_reg
                            _reg = _get_reg()
                            for tc in tool_calls:
                                if tc["name"] not in active_tools:
                                    _td = _reg.get(tc["name"])
                                    if _td and _td.loading.value == "deferred":
                                        active_tools.add(tc["name"])
                                        logger.debug(f"[CHAT] Auto-activated deferred tool: {tc['name']}")

                        # Pre-execute simple tools in parallel when multiple exist
                        _GENERATOR_TOOLS = {"analyze_document", "explore_knowledge_base", "task", "execute_code"}
                        _simple_tcs = [tc for tc in tool_calls if tc["name"] not in _GENERATOR_TOOLS]
                        _parallel_results: dict = {}

                        if len(_simple_tcs) > 1:
                            for _stc in _simple_tcs:
                                _stc["_thread_id"] = thread_id
                            _results = await asyncio.gather(*[
                                execute_tool_call(
                                    _stc, current_user.id,
                                    redaction_svc=redaction_svc,
                                    thread_id=thread_id,
                                    tools=round_tools,
                                    citation_context=citation_ctx,
                                )
                                for _stc in _simple_tcs
                            ])
                            _parallel_results = {
                                _stc["id"]: _res
                                for _stc, _res in zip(_simple_tcs, _results)
                            }
                            logger.debug(f"[CHAT] Parallel-executed {len(_simple_tcs)} simple tools")

                        # Execute each tool and add results
                        for tc in tool_calls:
                            # Track tool call for persistence
                            tool_call_record = {
                                "tool_name": tc["name"],
                                "arguments": tc["arguments"],
                                "status": "running",
                                "result_summary": None,
                            }
                            round_tool_calls.append(tool_call_record)

                            # Emit tool_call_start event to frontend
                            # De-anonymize arguments so the user sees real
                            # names instead of surrogates in tool call UI
                            display_args = (
                                redaction_svc.deanonymize(tc["arguments"])
                                if redaction_svc else tc["arguments"]
                            )
                            tool_start_data = json.dumps({
                                "type": "tool_call_start",
                                "tool_name": tc["name"],
                                "arguments": display_args,
                            })
                            yield f"data: {tool_start_data}\n\n"

                            # Pass thread_id for sandbox session management
                            tc["_thread_id"] = thread_id
                            if tc["id"] in _parallel_results:
                                result = _parallel_results[tc["id"]]
                            else:
                                result = await execute_tool_call(tc, current_user.id, redaction_svc=redaction_svc, thread_id=thread_id, tools=round_tools, citation_context=citation_ctx)

                            # --- Workspace SSE Events (Story 2.4) ---
                            if tc["name"] in ("write_file", "edit_file"):
                                try:
                                    args = json.loads(tc["arguments"])
                                    file_path = args.get("file_path")
                                    if file_path:
                                        file_record = await get_workspace_file(thread_id, file_path, current_user.id)
                                        # Heuristic: created_at == updated_at means it's brand new
                                        # Note: in Python/Supabase, we check exact equality
                                        is_created = file_record["created_at"] == file_record["updated_at"]
                                        event_type = "workspace_file_created" if is_created else "workspace_file_updated"
                                        
                                        workspace_event = json.dumps({
                                            "type": event_type,
                                            "thread_id": thread_id,
                                            "file_path": file_record["file_path"],
                                            "size_bytes": file_record["size_bytes"],
                                            "content_type": file_record["content_type"],
                                            "source": file_record["source"]
                                        })
                                        yield f"data: {workspace_event}\n\n"
                                except Exception as e:
                                    logger.warning(f"Failed to emit workspace SSE event: {e}")
                            # ---------------------------------------

                            # --- Todos SSE Events ---
                            if tc["name"] == "write_todos":
                                try:
                                    from app.services.todo_service import read_todos
                                    todos = await read_todos(thread_id, current_user.id)
                                    todos_event = json.dumps({
                                        "type": "todos_updated",
                                        "todos": [
                                            {"content": t["content"], "status": t["status"], "position": t["position"]}
                                            for t in todos
                                        ],
                                    })
                                    yield f"data: {todos_event}\n\n"
                                except Exception as e:
                                    logger.warning(f"Failed to emit todos SSE event: {e}")
                            # -------------------------

                            # Emit skill_activated event after load_skill completes
                            if tc["name"] == "load_skill" and isinstance(result, str) and result.startswith("# Skill: "):
                                parsed_args = json.loads(display_args)
                                skill_name_line = result.split("\n")[0].replace("# Skill: ", "")
                                skill_activated_data = json.dumps({
                                    "type": "skill_activated",
                                    "skill_id": parsed_args.get("skill_id", ""),
                                    "skill_name": skill_name_line,
                                })
                                yield f"data: {skill_activated_data}\n\n"

                            # Check if result is an async generator (sub-agent or code execution)
                            if hasattr(result, '__anext__'):
                                sub_agent_result = ""
                                generator_alias_start = len(citation_ctx.aliases)
                                # State tracking for persistence (Tasks 2 & 3)
                                explorer_tool_calls_list = []
                                task_tool_calls_list = []
                                code_exec_state = None
                                sub_agent_doc_id = ""
                                sub_agent_filename = ""
                                sub_agent_query = ""
                                sub_agent_task_id = ""
                                sub_agent_status = "completed"

                                try:
                                    async for sub_event in result:
                                        event_type = sub_event.get("type", "")

                                        # Handle code execution events
                                        if event_type.startswith("code_"):
                                            # Forward directly to frontend
                                            yield f"data: {json.dumps(sub_event)}\n\n"

                                            # Track code execution state for persistence
                                            if event_type == "code_execution_start":
                                                code_exec_state = {
                                                    "executionId": sub_event.get("execution_id", ""),
                                                    "language": sub_event.get("language", ""),
                                                    "codePreview": sub_event.get("code_preview", sub_event.get("code", "")),
                                                    "stdout": "",
                                                    "stderr": "",
                                                    "status": "running",
                                                    "files": [],
                                                }
                                            elif event_type == "code_stdout" and code_exec_state:
                                                code_exec_state["stdout"] += sub_event.get("content", "")
                                            elif event_type == "code_stderr" and code_exec_state:
                                                code_exec_state["stderr"] += sub_event.get("content", "")
                                            elif event_type == "code_execution_complete":
                                                stdout = sub_event.get("stdout", "")
                                                stderr = sub_event.get("stderr", "")
                                                files = sub_event.get("files", [])
                                                parts = []
                                                if stdout:
                                                    parts.append(f"Output:\n{stdout}")
                                                if stderr:
                                                    parts.append(f"Errors:\n{stderr}")
                                                if files:
                                                    file_lines = [
                                                        f"- {f['filename']} ({f.get('file_size', 0)} bytes)"
                                                        for f in files if 'error' not in f
                                                    ]
                                                    if file_lines:
                                                        parts.append("Generated files:\n" + "\n".join(file_lines))

                                                    # Emit workspace SSE events for sandbox-created files
                                                    for f in files:
                                                        if "error" not in f and f.get("filename"):
                                                            ws_event = json.dumps({
                                                                "type": "workspace_file_created",
                                                                "thread_id": thread_id,
                                                                "file_path": f["filename"],
                                                                "size_bytes": f.get("file_size", 0),
                                                                "content_type": f.get("content_type", ""),
                                                                "source": "sandbox",
                                                            })
                                                            yield f"data: {ws_event}\n\n"

                                                sub_agent_result = "\n\n".join(parts) or "Code executed successfully (no output)."
                                                if code_exec_state:
                                                    code_exec_state["status"] = "completed"
                                                    code_exec_state["exitCode"] = sub_event.get("exit_code")
                                                    code_exec_state["executionTimeMs"] = sub_event.get("execution_time_ms")
                                                    code_exec_state["stdout"] = stdout or code_exec_state["stdout"]
                                                    code_exec_state["stderr"] = stderr or code_exec_state["stderr"]
                                                    code_exec_state["files"] = [
                                                        {
                                                            "filename": f.get("filename", ""),
                                                            "download_url": f.get("download_url", ""),
                                                            "file_size": f.get("file_size", 0),
                                                            "content_type": f.get("content_type", ""),
                                                        }
                                                        for f in files if "error" not in f
                                                    ]
                                            elif event_type == "code_execution_error":
                                                sub_agent_result = f"Code execution error: {sub_event.get('error', 'Unknown error')}"
                                                if code_exec_state:
                                                    code_exec_state["status"] = "error"
                                                    code_exec_state["error"] = sub_event.get("error", "Unknown error")
                                            continue

                                        # Track sub-agent metadata from start events
                                        if event_type == "sub_agent_start":
                                            sub_agent_doc_id = sub_event.get("document_id", "")
                                            sub_agent_filename = sub_event.get("filename", "")
                                            sub_agent_task_id = sub_event.get("sub_agent_id", "")
                                        elif event_type == "explorer_start":
                                            sub_agent_query = sub_event.get("research_query", "")

                                        # Track explorer tool calls for persistence
                                        if event_type == "explorer_tool_call":
                                            explorer_tool_calls_list.append({
                                                "tool_name": sub_event.get("tool_name", ""),
                                                "arguments": sub_event.get("arguments", {}),
                                                "round": sub_event.get("round", 0),
                                                "status": "running",
                                            })
                                        elif event_type == "explorer_tool_result":
                                            for i in range(len(explorer_tool_calls_list) - 1, -1, -1):
                                                if explorer_tool_calls_list[i]["status"] == "running":
                                                    explorer_tool_calls_list[i]["status"] = "completed"
                                                    explorer_tool_calls_list[i]["result_summary"] = sub_event.get("result_summary", "")
                                                    break

                                        # Track task sub-agent tool calls for persistence
                                        if event_type == "tool_call_start" and sub_event.get("sub_agent_id"):
                                            raw_args = sub_event.get("arguments", "")
                                            try:
                                                parsed_args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                                            except (json.JSONDecodeError, TypeError):
                                                parsed_args = {}
                                            tc_entry = {
                                                "tool_name": sub_event.get("tool_name", ""),
                                                "arguments": parsed_args,
                                                "round": 0,
                                                "status": "running",
                                            }
                                            task_tool_calls_list.append(tc_entry)
                                            # Track file_path for workspace events
                                            if sub_event.get("tool_name") in ("write_file", "edit_file"):
                                                tc_entry["_file_path"] = parsed_args.get("file_path", "") if isinstance(parsed_args, dict) else ""
                                        elif event_type == "tool_call_complete" and sub_event.get("sub_agent_id"):
                                            tool_name = sub_event.get("tool_name", "")
                                            for i in range(len(task_tool_calls_list) - 1, -1, -1):
                                                if task_tool_calls_list[i]["tool_name"] == tool_name and task_tool_calls_list[i]["status"] == "running":
                                                    task_tool_calls_list[i]["status"] = "completed"
                                                    task_tool_calls_list[i]["result_summary"] = sub_event.get("result", "")[:200]
                                                    break

                                        # When redaction is active, skip streaming reasoning
                                        # events (they contain surrogates). Instead, emit the
                                        # full de-anonymized result at completion.
                                        if redaction_svc and event_type in (
                                            "sub_agent_reasoning", "explorer_reasoning"
                                        ):
                                            continue
                                        # Task sub-agents stream raw text_delta (surrogates)
                                        # directly. Suppress them under redaction; the
                                        # de-anonymized result is delivered via the
                                        # sub_agent_complete event forwarded below.
                                        if (
                                            redaction_svc
                                            and event_type == "text_delta"
                                            and sub_event.get("sub_agent_id")
                                        ):
                                            continue

                                        if event_type == "sub_agent_complete":
                                            sub_agent_result = sub_event.get("result", "")
                                            if redaction_svc and tc["name"] != "task":
                                                # Emit the de-anonymized result as a single
                                                # reasoning event so the frontend displays it.
                                                # Task sub-agents are handled differently: their
                                                # live text_delta is suppressed above and their
                                                # already de-anonymized result is forwarded via
                                                # the sub_agent_complete event below.
                                                synth_event = json.dumps({
                                                    "type": "sub_agent_reasoning",
                                                    "content": sub_agent_result,
                                                })
                                                yield f"data: {synth_event}\n\n"
                                        elif event_type == "explorer_complete":
                                            sub_agent_result = sub_event.get("findings", "")
                                            if redaction_svc:
                                                synth_event = json.dumps({
                                                    "type": "explorer_reasoning",
                                                    "content": sub_agent_result,
                                                })
                                                yield f"data: {synth_event}\n\n"
                                        elif event_type == "error":
                                            sub_agent_status = "error"
                                            sub_agent_result = f"Sub-agent error: {sub_event.get('error', 'Unknown error')}"
                                        elif event_type == "sub_agent_error":
                                            sub_agent_status = "error"
                                            sub_agent_result = f"Error analyzing document: {sub_event.get('error', 'Unknown error')}"
                                        elif event_type == "explorer_error":
                                            sub_agent_status = "error"
                                            sub_agent_result = f"Error exploring knowledge base: {sub_event.get('error', 'Unknown error')}"

                                        # Forward event to frontend
                                        sub_event_data = json.dumps(sub_event)
                                        yield f"data: {sub_event_data}\n\n"

                                        # Emit workspace SSE events for sub-agent write_file/edit_file
                                        if (
                                            event_type == "tool_call_complete"
                                            and sub_event.get("sub_agent_id")
                                            and sub_event.get("tool_name") in ("write_file", "edit_file")
                                        ):
                                            try:
                                                # Find the tracked file_path from the matching tool_call_start
                                                ws_file_path = None
                                                for ttc in reversed(task_tool_calls_list):
                                                    if ttc["tool_name"] == sub_event["tool_name"] and ttc.get("_file_path"):
                                                        ws_file_path = ttc["_file_path"]
                                                        break
                                                if ws_file_path:
                                                    file_record = await get_workspace_file(thread_id, ws_file_path, current_user.id)
                                                    is_created = file_record["created_at"] == file_record["updated_at"]
                                                    ws_event_type = "workspace_file_created" if is_created else "workspace_file_updated"
                                                    workspace_event = json.dumps({
                                                        "type": ws_event_type,
                                                        "thread_id": thread_id,
                                                        "file_path": file_record["file_path"],
                                                        "size_bytes": file_record["size_bytes"],
                                                        "content_type": file_record["content_type"],
                                                        "source": file_record["source"],
                                                    })
                                                    yield f"data: {workspace_event}\n\n"
                                                    logger.info(f"Emitted {ws_event_type} for sub-agent file: {ws_file_path}")
                                                else:
                                                    logger.warning(f"Sub-agent write_file/edit_file complete but no tracked file_path")
                                            except Exception as ws_err:
                                                logger.warning(f"Failed to emit workspace SSE for sub-agent file op: {ws_err}")
                                except Exception as gen_exc:
                                    logger.error(f"Sub-agent generator exception: {gen_exc}")
                                    sub_agent_status = "error"
                                    sub_agent_result = json.dumps({
                                        "error": str(gen_exc),
                                        "tool_name": tc["name"],
                                        "recoverable": True,
                                    })

                                parent_tool_content = sub_agent_result
                                new_aliases = citation_ctx.aliases[generator_alias_start:]
                                owned_numbers = {a.display_number for a in new_aliases}
                                sub_agent_result = sanitize_unowned_aliases(sub_agent_result, owned_numbers)
                                parent_tool_content = sub_agent_result
                                used_numbers = set(citation_ctx.parse_aliases(sub_agent_result)) & owned_numbers
                                evidence_block = (
                                    format_evidence_block_for_alias_numbers(citation_ctx, used_numbers)
                                    if used_numbers
                                    else format_evidence_block_for_new_aliases(citation_ctx, generator_alias_start)
                                )
                                if evidence_block:
                                    parent_tool_content = f"{evidence_block}\n\n---\n\n{parent_tool_content}"

                                # Use sub-agent result as tool response
                                current_messages.append({
                                    "role": "tool",
                                    "tool_call_id": tc["id"],
                                    "content": parent_tool_content,
                                })

                                # Anonymize only this new tool result
                                if redaction_svc:
                                    anon_status = json.dumps({"type": "redaction_status", "stage": "anonymizing"})
                                    yield f"data: {anon_status}\n\n"
                                    anon_tool_content = await redaction_svc.anonymize(parent_tool_content)
                                else:
                                    anon_tool_content = parent_tool_content
                                anon_messages.append({
                                    "role": "tool",
                                    "tool_call_id": tc["id"],
                                    "content": anon_tool_content,
                                })

                                # Update tool call record
                                tool_call_record["status"] = "completed"
                                tool_call_record["tool_call_id"] = tc["id"]
                                tool_call_record["result"] = sub_agent_result
                                if tc["name"] == "explore_knowledge_base":
                                    summary = "Exploration complete"
                                elif tc["name"] == "task":
                                    summary = "Task delegation complete"
                                else:
                                    summary = "Analysis complete"
                                tool_call_record["result_summary"] = summary

                                # Persist sub-agent state on tool call record (Task 2)
                                if tc["name"] == "analyze_document":
                                    tool_call_record["sub_agent_state"] = {
                                        "mode": "analyze",
                                        "documentId": sub_agent_doc_id,
                                        "filename": sub_agent_filename,
                                        "reasoning": sub_agent_result,
                                        "status": sub_agent_status,
                                    }
                                elif tc["name"] == "explore_knowledge_base":
                                    tool_call_record["sub_agent_state"] = {
                                        "mode": "explore",
                                        "researchQuery": sub_agent_query,
                                        "explorerToolCalls": explorer_tool_calls_list,
                                        "reasoning": sub_agent_result,
                                        "status": sub_agent_status,
                                    }
                                elif tc["name"] == "task":
                                    try:
                                        task_desc = json.loads(tc.get("arguments", "{}")).get("description", "")
                                    except (json.JSONDecodeError, TypeError):
                                        task_desc = ""
                                    # Strip internal tracking keys before persisting
                                    persisted_task_tool_calls = [
                                        {k: v for k, v in ttc.items() if not k.startswith("_")}
                                        for ttc in task_tool_calls_list
                                    ]
                                    tool_call_record["sub_agent_state"] = {
                                        "mode": "task",
                                        "description": task_desc,
                                        "subAgentId": sub_agent_task_id,
                                        "taskToolCalls": persisted_task_tool_calls,
                                        "reasoning": sub_agent_result,
                                        "status": sub_agent_status,
                                    }

                                # Persist code execution state on tool call record (Task 3)
                                if code_exec_state:
                                    code_exec_state["stdout"] = code_exec_state["stdout"][:10000]
                                    code_exec_state["stderr"] = code_exec_state["stderr"][:10000]
                                    tool_call_record["code_execution_state"] = code_exec_state

                                # Emit tool_call_complete for sub-agent
                                tool_complete_data = json.dumps({
                                    "type": "tool_call_complete",
                                    "tool_name": tc["name"],
                                    "result_summary": summary,
                                    "result": tool_call_record.get("result", ""),
                                })
                                yield f"data: {tool_complete_data}\n\n"
                            else:
                                # Normal tool result (string)
                                current_messages.append({
                                    "role": "tool",
                                    "tool_call_id": tc["id"],
                                    "content": result,
                                })

                                # Track deferred tools discovered via tool_search for dynamic injection
                                if tc["name"] == "tool_search" and registry_enabled:
                                    try:
                                        search_results = json.loads(result)
                                        if isinstance(search_results, list):
                                            loaded_names = []
                                            for sr in search_results:
                                                if isinstance(sr, dict) and "name" in sr:
                                                    if sr.get("loading") == "deferred":
                                                        active_tools.add(sr["name"])
                                                    loaded_names.append(sr["name"])
                                            # Emit SSE event for frontend feedback
                                            if loaded_names:
                                                ts_event = json.dumps({
                                                    "type": "tool_search_results",
                                                    "query": json.loads(tc.get("arguments", "{}")).get("query", ""),
                                                    "matches": loaded_names,
                                                    "tools_loaded": len(loaded_names),
                                                })
                                                yield f"data: {ts_event}\n\n"
                                    except (json.JSONDecodeError, TypeError):
                                        pass

                                # Anonymize only this new tool result
                                if redaction_svc:
                                    anon_status = json.dumps({"type": "redaction_status", "stage": "anonymizing"})
                                    yield f"data: {anon_status}\n\n"
                                    anon_tool_content = await redaction_svc.anonymize(result)
                                else:
                                    anon_tool_content = result
                                anon_messages.append({
                                    "role": "tool",
                                    "tool_call_id": tc["id"],
                                    "content": anon_tool_content,
                                })

                                # Generate result summary based on tool type
                                result_summary = get_result_summary(tc["name"], result)

                                # Update tool call record
                                tool_call_record["status"] = "completed"
                                tool_call_record["tool_call_id"] = tc["id"]
                                tool_call_record["result"] = result
                                tool_call_record["result_summary"] = result_summary

                                # Emit tool_call_complete with result summary
                                tool_complete_data = json.dumps({
                                    "type": "tool_call_complete",
                                    "tool_name": tc["name"],
                                    "result_summary": result_summary,
                                    "result": tool_call_record.get("result", ""),
                                })
                                yield f"data: {tool_complete_data}\n\n"

                        # Quick-mode inline citations: every tool in this round
                        # has now registered its citable spans, so stream the
                        # newly registered aliases to the frontend. The model
                        # cites them in a later round's answer text; sending them
                        # now means the chip resolves the instant its {[S#]}
                        # token streams in.
                        if len(citation_ctx.aliases) > streamed_alias_count:
                            new_aliases = citation_ctx.aliases[streamed_alias_count:]
                            streamed_alias_count = len(citation_ctx.aliases)
                            try:
                                alias_event = json.dumps({
                                    "type": "citation_alias",
                                    "verification_mode": "unverified",
                                    # answer_id is the turn id here (the real
                                    # message id isn't created until the answer
                                    # completes); the frontend keys the streaming
                                    # bucket by responseKey, not answer_id.
                                    "citations": build_streaming_citations(
                                        new_aliases,
                                        answer_id=citation_turn_id,
                                        thread_id=thread_id,
                                        verification_mode="unverified",
                                    ),
                                })
                                yield f"data: {alias_event}\n\n"
                            except Exception as e:
                                logger.warning(f"[CITATION] failed to stream alias map: {e}")

                        # Save per-round assistant message to DB
                        round_content = ""
                        round_anon_content = None
                        if redaction_svc and text_buffer:
                            deanon_status = json.dumps({"type": "redaction_status", "stage": "deanonymizing"})
                            yield f"data: {deanon_status}\n\n"
                            round_content = await redaction_svc.deanonymize_llm_response(text_buffer)
                            round_anon_content = text_buffer
                        elif round_text:
                            round_content = round_text

                        msg_insert_data = {
                            "thread_id": thread_id,
                            "user_id": current_user.id,
                            "role": "assistant",
                            "content": round_content,
                            "anonymized_content": round_anon_content,
                            "created_at": datetime.utcnow().isoformat(),
                            "sequence_number": await _next_sequence_number(thread_id),
                        }
                        if round_tool_calls:
                            msg_insert_data["tool_calls"] = round_tool_calls
                        supabase.table("messages").insert(msg_insert_data).execute()

                        if round_content:
                            all_round_texts.append(round_content)
                        total_tool_call_count += len(round_tool_calls)

                        # ask_user: the model asked the user a question — pause the
                        # agent loop and end the turn. The user's next message is the
                        # answer; the assistant(tool_call)+tool(result) pair persisted
                        # above keeps the history valid so the agent resumes coherently.
                        _ask = next((t for t in round_tool_calls if t.get("tool_name") == "ask_user"), None)
                        if _ask:
                            try:
                                _q = (json.loads(_ask.get("arguments") or "{}") or {}).get("question") or ""
                            except Exception:
                                _q = ""
                            _q = (_q or "Could you clarify so I can continue?").strip()
                            # Surface (and persist) the question if the model didn't
                            # already say it in this round's visible text.
                            if not (round_content or "").strip():
                                yield f"event: text_delta\ndata: {json.dumps({'content': _q})}\n\n"
                                supabase.table("messages").insert({
                                    "thread_id": thread_id,
                                    "user_id": current_user.id,
                                    "role": "assistant",
                                    "content": _q,
                                    "created_at": datetime.utcnow().isoformat(),
                                    "sequence_number": await _next_sequence_number(thread_id),
                                }).execute()
                            yield f"data: {json.dumps({'type': 'ask_user', 'question': _q})}\n\n"
                            supabase.table("threads").update(
                                {"updated_at": datetime.utcnow().isoformat()}
                            ).eq("id", thread_id).execute()
                            if trace_ctx:
                                if trace_ctx.new_run:
                                    trace_ctx.new_run.add_outputs({"ask_user": _q, "rounds": rounds})
                                await trace_ctx.__aexit__(None, None, None)
                                trace_ctx = None
                            if deep_mode:
                                yield f"data: {json.dumps({'type': 'agent_status', 'status': 'complete'})}\n\n"
                            if last_usage:
                                yield f"data: {json.dumps(last_usage)}\n\n"
                            yield "event: done\ndata: {}\n\n"
                            return

                        # Continue the loop to call LLM again
                        break

                    elif event["type"] == "response_completed":
                        logger.debug(f"[CHAT] Response completed. Buffered text: {len(text_buffer)} chars, streamed: {len(round_text)} chars")
                        # De-anonymize the buffered text response
                        # (text_buffer is only populated when redaction is active)
                        final_content = ""
                        final_anon_content = None
                        if text_buffer:
                            deanon_status = json.dumps({"type": "redaction_status", "stage": "deanonymizing"})
                            yield f"data: {deanon_status}\n\n"

                            deanonymized = await redaction_svc.deanonymize_llm_response(text_buffer)
                            logger.debug(f"[CHAT] De-anonymized response ({len(text_buffer)} => {len(deanonymized)} chars)")
                            logger.debug(f"[CHAT] Buffered (anon): {text_buffer[:200]}...")
                            logger.debug(f"[CHAT] De-anon result: {deanonymized[:200]}...")
                            final_content = deanonymized
                            final_anon_content = text_buffer

                            # Send the de-anonymized text to frontend as a single chunk
                            data = json.dumps({"content": deanonymized})
                            yield f"event: text_delta\ndata: {data}\n\n"
                        else:
                            final_content = round_text

                        # Save final text-only assistant message to database
                        final_assistant_message_id = None
                        if final_content:
                            msg_insert_data = {
                                "thread_id": thread_id,
                                "user_id": current_user.id,
                                "role": "assistant",
                                "content": final_content,
                                "anonymized_content": final_anon_content,
                                "verification_mode": citation_verification_mode,
                                "created_at": datetime.utcnow().isoformat(),
                                "sequence_number": await _next_sequence_number(thread_id),
                            }
                            insert_res = supabase.table("messages").insert(msg_insert_data).execute()
                            if insert_res.data:
                                final_assistant_message_id = insert_res.data[0].get("id")
                            all_round_texts.append(final_content)

                        # Quick-mode citations: parse [S#] aliases, persist
                        # AnswerCitation rows, and emit a citation_metadata SSE
                        # event so the frontend can hydrate chips.
                        content_db_only, db_rows, sse_payload = await _finalize_citations_for_turn(
                            final_content=final_content,
                            final_assistant_message_id=final_assistant_message_id,
                            thread_id=thread_id,
                            user_id=current_user.id,
                            citation_ctx=citation_ctx,
                        )
                        # Persist normalized text (e.g. [S1][S8] split) silently so reloads render chips.
                        if content_db_only and final_assistant_message_id:
                            try:
                                supabase.table("messages").update({"content": content_db_only}).eq(
                                    "id", final_assistant_message_id
                                ).execute()
                            except Exception as upd_err:
                                logger.warning(f"[CITATION] failed to persist normalized text: {upd_err}")
                        if db_rows:
                            try:
                                supabase.table("answer_citations").insert(db_rows).execute()
                            except Exception as db_err:
                                logger.warning(f"[CITATION] failed to persist citations: {db_err}")
                        if sse_payload:
                            yield f"data: {json.dumps(sse_payload)}\n\n"

                        # Update thread's updated_at
                        supabase.table("threads").update({
                            "updated_at": datetime.utcnow().isoformat()
                        }).eq("id", thread_id).execute()

                        # Title generation runs in background task — Realtime pushes to frontend

                        # End the trace with outputs before finishing
                        if trace_ctx:
                            if trace_ctx.new_run:
                                trace_ctx.new_run.add_outputs({
                                    "response_length": sum(len(t) for t in all_round_texts),
                                    "tool_call_count": total_tool_call_count,
                                    "rounds": rounds,
                                })
                            await trace_ctx.__aexit__(None, None, None)
                            trace_ctx = None

                        # Emit agent_status complete for deep mode
                        if deep_mode:
                            agent_complete = json.dumps({"type": "agent_status", "status": "complete"})
                            yield f"data: {agent_complete}\n\n"

                        if last_usage:
                            yield f"data: {json.dumps(last_usage)}\n\n"
                        yield f"event: done\ndata: {{}}\n\n"
                        return  # Done, exit the generator

                    elif event["type"] == "error":
                        data = json.dumps({"error": event["error"]})
                        yield f"event: error\ndata: {data}\n\n"
                        if trace_ctx:
                            if trace_ctx.new_run:
                                trace_ctx.new_run.add_outputs({"error": event["error"]})
                            await trace_ctx.__aexit__(None, None, None)
                            trace_ctx = None
                        return

            # If we exhausted rounds without a final response, de-anonymize
            # any remaining buffered text and send it.
            # (text_buffer is only populated when redaction is active;
            #  without redaction, text was already streamed to round_text)
            final_content = ""
            final_anon_content = None
            if text_buffer:
                deanon_status = json.dumps({"type": "redaction_status", "stage": "deanonymizing"})
                yield f"data: {deanon_status}\n\n"
                deanonymized = await redaction_svc.deanonymize_llm_response(text_buffer)
                final_content = deanonymized
                final_anon_content = text_buffer
                data = json.dumps({"content": deanonymized})
                yield f"event: text_delta\ndata: {data}\n\n"
            elif round_text:
                final_content = round_text

            final_assistant_message_id = None
            if final_content:
                msg_insert_data = {
                    "thread_id": thread_id,
                    "user_id": current_user.id,
                    "role": "assistant",
                    "content": final_content,
                    "anonymized_content": final_anon_content,
                    "verification_mode": citation_verification_mode,
                    "created_at": datetime.utcnow().isoformat(),
                    "sequence_number": await _next_sequence_number(thread_id),
                }
                insert_res = supabase.table("messages").insert(msg_insert_data).execute()
                if insert_res.data:
                    final_assistant_message_id = insert_res.data[0].get("id")
                all_round_texts.append(final_content)

            # Quick-mode citations (exhausted-rounds path): same finalize helper as above.
            content_db_only, db_rows, sse_payload = await _finalize_citations_for_turn(
                final_content=final_content,
                final_assistant_message_id=final_assistant_message_id,
                thread_id=thread_id,
                user_id=current_user.id,
                citation_ctx=citation_ctx,
            )
            if content_db_only and final_assistant_message_id:
                try:
                    supabase.table("messages").update({"content": content_db_only}).eq(
                        "id", final_assistant_message_id
                    ).execute()
                except Exception as upd_err:
                    logger.warning(f"[CITATION] failed to persist normalized text: {upd_err}")
            if db_rows:
                try:
                    supabase.table("answer_citations").insert(db_rows).execute()
                except Exception as db_err:
                    logger.warning(f"[CITATION] failed to persist citations: {db_err}")
            if sse_payload:
                yield f"data: {json.dumps(sse_payload)}\n\n"

            # Title generation runs in background task — Realtime pushes to frontend

            # End the trace for exhausted rounds
            if trace_ctx:
                if trace_ctx.new_run:
                    trace_ctx.new_run.add_outputs({
                        "response_length": sum(len(t) for t in all_round_texts),
                        "tool_call_count": total_tool_call_count,
                        "rounds": rounds,
                        "max_rounds_exhausted": True,
                    })
                await trace_ctx.__aexit__(None, None, None)
                trace_ctx = None

            # Emit agent_status complete for deep mode (exhausted rounds)
            if deep_mode:
                agent_complete = json.dumps({"type": "agent_status", "status": "complete"})
                yield f"data: {agent_complete}\n\n"

            if last_usage:
                yield f"data: {json.dumps(last_usage)}\n\n"
            yield f"event: done\ndata: {{}}\n\n"

        except GeneratorExit:
            # Client disconnected — clean up trace quietly
            if trace_ctx:
                try:
                    await trace_ctx.__aexit__(None, None, None)
                except Exception:
                    pass
            return
        except Exception as e:
            data = json.dumps({"error": str(e)})
            yield f"event: error\ndata: {data}\n\n"
            if trace_ctx:
                try:
                    await trace_ctx.__aexit__(type(e), e, e.__traceback__)
                except Exception:
                    pass  # Don't let tracing errors mask the real error

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )
