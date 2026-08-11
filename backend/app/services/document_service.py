"""Document content service for retrieving full document content."""
import logging
from typing import Any

from postgrest.exceptions import APIError

from app.db.supabase import get_supabase_client
from app.services.token_service import estimate_tokens, can_fit_in_context

logger = logging.getLogger(__name__)


async def get_full_document_content(
    document_id: str,
    user_id: str,
    max_tokens: int = 100000
) -> dict[str, Any] | None:
    """
    Get the full content of a document by concatenating all its chunks.

    Args:
        document_id: UUID of the document
        user_id: UUID of the user (for RLS verification)
        max_tokens: Maximum tokens allowed in context window

    Returns:
        Dict with document info and content, or None if not found/unauthorized:
        {
            "id": str,
            "filename": str,
            "content": str,
            "token_count": int,
            "chunk_count": int,
            "metadata": dict | None,
            "fits_context": bool
        }
    """
    supabase = get_supabase_client()

    # Get document metadata (RLS ensures user can only access their own docs)
    try:
        doc_result = supabase.table("documents").select(
            "id, filename, metadata, status"
        ).eq("id", document_id).eq("user_id", user_id).maybe_single().execute()
    except APIError as e:
        # Handle 204 No Content - means no row was found
        if e.code == "204":
            logger.warning(f"Document {document_id} not found or not accessible by user {user_id}")
            return None
        raise

    if not doc_result or not doc_result.data:
        logger.warning(f"Document {document_id} not found or not accessible by user {user_id}")
        return None

    doc = doc_result.data

    if doc["status"] != "completed":
        logger.warning(f"Document {document_id} is not completed (status: {doc['status']})")
        return None

    # Get all chunks ordered by index
    chunks_result = supabase.table("chunks").select(
        "content, chunk_index"
    ).eq("document_id", document_id).order("chunk_index").execute()

    if not chunks_result.data:
        logger.warning(f"No chunks found for document {document_id}")
        return None

    # Concatenate chunks with separators
    chunk_contents = [chunk["content"] for chunk in chunks_result.data]
    full_content = "\n\n---\n\n".join(chunk_contents)

    # Calculate token count
    token_count = estimate_tokens(full_content)
    fits_context = can_fit_in_context(full_content, max_tokens)

    return {
        "id": doc["id"],
        "filename": doc["filename"],
        "content": full_content,
        "token_count": token_count,
        "chunk_count": len(chunks_result.data),
        "metadata": doc.get("metadata"),
        "fits_context": fits_context,
    }
