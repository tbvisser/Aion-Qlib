"""Citation source endpoints.

Serves the captured page snapshot behind a web citation so the frontend can
render the source instead of showing the bare URL, and highlight the cited
snippet when it appears in the captured page text. Keyed on the stable
canonical ``source_id`` (not the citation id) so it resolves identically for a
freshly-streamed citation and one reloaded from the database.
"""
import logging

from fastapi import APIRouter, Depends

from app.dependencies import get_current_user, User
from app.db.supabase import get_supabase_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/citations", tags=["citations"])


@router.get("/web-source/{source_id}")
async def get_web_citation_source(
    source_id: str,
    current_user: User = Depends(get_current_user),
) -> dict:
    """Return the stored snapshot for a web source the current user captured.

    Shape: ``{content_type, content, uri, fetched_at}``. ``content`` is ``None``
    when no snapshot exists (snippet-only result, snapshots disabled, or a
    pre-feature citation); the frontend falls back to its link-only view in that case.
    The service-role client bypasses RLS, so the user_id filter is the
    authorization boundary -- a user can only read snapshots from their own
    searches.
    """
    supabase = get_supabase_client()
    try:
        res = (
            supabase.table("web_snapshots")
            .select("content, content_type, url, fetched_at")
            .eq("user_id", current_user.id)
            .eq("source_id", source_id)
            .limit(1)
            .execute()
        )
        rows = res.data or []
    except Exception as e:
        logger.warning(f"[CITATION] failed to load web snapshot source_id={source_id}: {e}")
        rows = []

    if not rows:
        return {"content_type": None, "content": None, "uri": None, "fetched_at": None}

    snap = rows[0]
    return {
        "content_type": snap.get("content_type") or "text/markdown",
        "content": snap.get("content"),
        "uri": snap.get("url"),
        "fetched_at": snap.get("fetched_at"),
    }
