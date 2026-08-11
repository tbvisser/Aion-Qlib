import logging
from fastapi import APIRouter, Depends, HTTPException, status
from datetime import datetime
from postgrest.exceptions import APIError

from app.dependencies import get_current_user, User
from app.db.supabase import get_supabase_client
from app.config import get_settings
from app.models.schemas import (
    ThreadCreate,
    ThreadResponse,
    ThreadUpdate,
    TodoItem,
    PaginatedThreadsResponse,
    CompactionResponse,
)
from app.services.llm_service import get_global_llm_settings
from app.services.langsmith import get_traced_async_openai_client, traceable
from app.services.redaction_service import call_local_llm, get_local_llm_settings
from app.services.message_compaction_service import create_thread_compaction_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/threads", tags=["threads"])


@traceable(name="generate_thread_title", run_type="llm")
async def generate_title_for_thread(thread_id: str, user_message: str, assistant_message: str | None = None) -> str | None:
    """
    Generate a short, descriptive title for a thread using the LLM.

    Args:
        thread_id: The thread to update
        user_message: The user's first message
        assistant_message: Optional assistant response for extra context

    Returns:
        The generated title, or None if generation failed
    """
    context_parts = [f"User message: {user_message}"]
    if assistant_message:
        assistant_context = assistant_message[:500] if len(assistant_message) > 500 else assistant_message
        context_parts.append(f"Assistant response: {assistant_context}")
    title_context = "\n\n".join(context_parts)

    title_prompt = (
        "Generate a short, descriptive title (2-6 words) for a chat conversation. "
        "The title should capture the main topic. Do not use quotes or punctuation at the end. "
        "Reply with ONLY the title, nothing else.\n\n"
        + title_context
    )

    title = None

    # Try local LLM first (keeps PII local)
    try:
        local_settings = get_local_llm_settings()
        if local_settings:
            raw = await call_local_llm(title_prompt)  # plain text, no response_format
            if raw:
                title = raw.strip().strip('"').strip("'")
                logger.info(f"Generated title for thread {thread_id} (local LLM): {title}")
    except Exception as e:
        logger.warning(f"Local LLM title generation failed, falling back to cloud: {e}")

    # Fall back to cloud LLM
    if not title:
        try:
            llm_settings = get_global_llm_settings()
            client = get_traced_async_openai_client(
                base_url=llm_settings["base_url"],
                api_key=llm_settings["api_key"],
            )

            response = await client.chat.completions.create(
                model=llm_settings["model"],
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Generate a short, descriptive title (2-6 words) for a chat conversation. "
                            "The title should capture the main topic. Do not use quotes or punctuation at the end. "
                            "Reply with ONLY the title, nothing else."
                        ),
                    },
                    {
                        "role": "user",
                        "content": title_context,
                    },
                ],
                stream=False,
            )

            title = response.choices[0].message.content.strip()
            logger.info(f"Generated title for thread {thread_id} (cloud LLM): {title}")
        except Exception as e:
            logger.warning(f"Failed to generate title for thread {thread_id}: {e}")
            return None

    # Truncate to 60 chars max
    if title and len(title) > 60:
        title = title[:60]

    if not title:
        return None

    # Update the thread title in the database
    try:
        supabase = get_supabase_client()
        supabase.table("threads").update({
            "title": title,
            "updated_at": datetime.utcnow().isoformat(),
        }).eq("id", thread_id).execute()
    except Exception as e:
        logger.warning(f"Failed to update thread title in DB: {e}")

    return title


@router.get("", response_model=PaginatedThreadsResponse)
async def list_threads(
    search: str | None = None,
    offset: int = 0,
    limit: int = 50,
    current_user: User = Depends(get_current_user),
):
    """List threads for the current user with optional search and pagination.

    - search: case-insensitive substring match on title (optional)
    - offset: starting index (default 0)
    - limit: page size (default 50, capped at 200)
    """
    limit = min(max(limit, 1), 200)
    offset = max(offset, 0)

    supabase = get_supabase_client()
    query = (
        supabase.table("threads")
        .select("*", count="exact")
        .eq("user_id", current_user.id)
    )

    if search and search.strip():
        # Escape ILIKE wildcards in user input so they are treated literally
        escaped = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        query = query.ilike("title", f"%{escaped}%")

    # PostgREST raises PGRST103 ("Requested range not satisfiable") rather than
    # returning an empty page when ``offset`` is past the end of the result set
    # (e.g. threads deleted between a client's successive page requests). Treat it
    # as an empty final page instead of surfacing a 500.
    try:
        result = (
            query.order("updated_at", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        )
    except APIError as e:
        if e.code != "PGRST103":
            raise
        return {"threads": [], "total_count": 0, "has_more": False}

    total_count = result.count or 0
    threads = result.data or []
    has_more = offset + len(threads) < total_count

    return {"threads": threads, "total_count": total_count, "has_more": has_more}


@router.post("", response_model=ThreadResponse, status_code=status.HTTP_201_CREATED)
async def create_thread(
    thread_data: ThreadCreate,
    current_user: User = Depends(get_current_user)
):
    """Create a new thread."""
    supabase = get_supabase_client()

    # Store in database (no more OpenAI thread needed with Responses API)
    now = datetime.utcnow().isoformat()
    result = supabase.table("threads").insert({
        "user_id": current_user.id,
        "title": thread_data.title or "New Chat",
        "created_at": now,
        "updated_at": now,
    }).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create thread"
        )

    return result.data[0]


@router.get("/{thread_id}", response_model=ThreadResponse)
async def get_thread(
    thread_id: str,
    current_user: User = Depends(get_current_user)
):
    """Get a specific thread."""
    supabase = get_supabase_client()
    try:
        result = supabase.table("threads").select("*").eq("id", thread_id).eq("user_id", current_user.id).single().execute()
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Thread not found"
        )

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Thread not found"
        )

    return result.data


@router.patch("/{thread_id}", response_model=ThreadResponse)
async def update_thread(
    thread_id: str,
    thread_data: ThreadUpdate,
    current_user: User = Depends(get_current_user)
):
    """Update a thread's title."""
    supabase = get_supabase_client()

    # First verify the thread belongs to the user
    try:
        existing = supabase.table("threads").select("id").eq("id", thread_id).eq("user_id", current_user.id).single().execute()
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Thread not found"
        )
    if not existing.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Thread not found"
        )

    result = supabase.table("threads").update({
        "title": thread_data.title,
        "updated_at": datetime.utcnow().isoformat(),
    }).eq("id", thread_id).execute()

    return result.data[0]


@router.get("/{thread_id}/todos", response_model=list[TodoItem])
async def get_thread_todos(
    thread_id: str,
    current_user: User = Depends(get_current_user)
):
    """Get the current todo list for a thread, ordered by position."""
    from app.services.todo_service import read_todos

    try:
        todos = await read_todos(thread_id, current_user.id)
    except PermissionError:
        return []

    return [
        {"content": t["content"], "status": t["status"], "position": t["position"]}
        for t in todos
    ]


@router.delete("/{thread_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_thread(
    thread_id: str,
    current_user: User = Depends(get_current_user)
):
    """Delete a thread."""
    supabase = get_supabase_client()

    # Verify the thread belongs to the user
    try:
        result = supabase.table("threads").select("id").eq("id", thread_id).eq("user_id", current_user.id).single().execute()
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Thread not found"
        )

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Thread not found"
        )

    # Close sandbox session for this thread if enabled
    if get_settings().sandbox_enabled:
        from app.services.sandbox_session_manager import get_session_manager
        mgr = get_session_manager()
        try:
            await mgr.close_session(thread_id)
        except Exception:
            pass

    # Delete from database (messages will cascade delete)
    supabase.table("threads").delete().eq("id", thread_id).execute()


async def _verify_thread_owner(thread_id: str, user_id: str) -> None:
    """Raise 404 unless the thread is owned by ``user_id``.

    Kept local to threads.py to avoid the circular dependency on chat.py.
    """
    supabase = get_supabase_client()
    try:
        result = (
            supabase.table("threads")
            .select("id")
            .eq("id", thread_id)
            .eq("user_id", user_id)
            .single()
            .execute()
        )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Thread not found"
        )
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Thread not found"
        )


@router.get("/{thread_id}/compactions", response_model=list[CompactionResponse])
async def list_compactions(
    thread_id: str,
    current_user: User = Depends(get_current_user),
):
    """List all compactions for a thread (oldest first)."""
    await _verify_thread_owner(thread_id, current_user.id)
    supabase = get_supabase_client()
    result = (
        supabase.table("thread_compactions")
        .select("*")
        .eq("thread_id", thread_id)
        .order("created_at")
        .execute()
    )
    return result.data or []


@router.post("/{thread_id}/compact", response_model=CompactionResponse | None)
async def manual_compact(
    thread_id: str,
    current_user: User = Depends(get_current_user),
):
    """Force a compaction pass on the thread regardless of token threshold.

    Returns the inserted compaction row, or ``null`` if the thread had nothing
    to evict (e.g. it has fewer messages than the recent-tail floor).
    """
    await _verify_thread_owner(thread_id, current_user.id)
    supabase = get_supabase_client()

    svc = await create_thread_compaction_service(thread_id, current_user.id)
    raw = (
        supabase.table("messages")
        .select("id, role, content, anonymized_content, tool_calls, sequence_number")
        .eq("thread_id", thread_id)
        .order("sequence_number")
        .execute()
        .data
        or []
    )
    active_model = get_global_llm_settings()["model"]
    result = await svc.compact(raw, model=active_model, force=True)
    return result.compaction_row
