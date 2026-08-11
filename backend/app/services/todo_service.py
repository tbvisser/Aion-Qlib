"""Todo service for deep mode agent planning."""
import logging

from app.db.supabase import get_supabase_client
from app.services.langsmith import traceable

logger = logging.getLogger(__name__)


async def _verify_thread_ownership(thread_id: str, user_id: str) -> bool:
    """Verify the user owns the thread. Returns True if valid."""
    supabase = get_supabase_client()
    result = (
        supabase.table("threads")
        .select("id")
        .eq("id", thread_id)
        .eq("user_id", user_id)
        .execute()
    )
    return bool(result.data)


@traceable(name="write_todos", run_type="tool")
async def write_todos(thread_id: str, todos: list[dict], user_id: str) -> list[dict]:
    """Replace the entire todo list for a thread.

    Deletes all existing todos for the thread and inserts the new list.
    Returns the saved todo list ordered by position.

    Raises:
        PermissionError: If the user does not own the thread.
    """
    if not await _verify_thread_ownership(thread_id, user_id):
        logger.warning("[TODO] User %s does not own thread %s", user_id, thread_id)
        raise PermissionError(f"User does not own thread {thread_id}")

    supabase = get_supabase_client()

    # Delete all existing todos for this thread
    supabase.table("agent_todos").delete().eq("thread_id", thread_id).execute()

    if not todos:
        return []

    # Insert new todos
    rows = [
        {
            "thread_id": thread_id,
            "content": todo["content"],
            "status": todo["status"],
            "position": todo["position"],
        }
        for todo in todos
    ]

    result = (
        supabase.table("agent_todos")
        .insert(rows)
        .execute()
    )

    # Return ordered by position
    saved = sorted(result.data or [], key=lambda t: t["position"])
    return saved


@traceable(name="read_todos", run_type="tool")
async def read_todos(thread_id: str, user_id: str) -> list[dict]:
    """Read the current todo list for a thread, ordered by position.

    Raises:
        PermissionError: If the user does not own the thread.
    """
    if not await _verify_thread_ownership(thread_id, user_id):
        logger.warning("[TODO] User %s does not own thread %s", user_id, thread_id)
        raise PermissionError(f"User does not own thread {thread_id}")

    supabase = get_supabase_client()

    result = (
        supabase.table("agent_todos")
        .select("*")
        .eq("thread_id", thread_id)
        .order("position")
        .execute()
    )

    return result.data or []
