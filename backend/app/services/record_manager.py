"""Record manager: deduplication logic for document uploads."""
import hashlib
from typing import Literal

from app.db.supabase import get_supabase_client

DOCUMENT_LOOKUP_COLUMNS = (
    "id,user_id,folder_id,filename,file_type,file_size,storage_path,status,"
    "error_message,chunk_count,content_hash,hierarchical_index,metadata,"
    "created_at,updated_at"
)


def compute_file_hash(content: bytes) -> str:
    """Compute SHA-256 hex digest of raw file bytes."""
    return hashlib.sha256(content).hexdigest()


def check_existing_document(user_id: str, filename: str) -> dict | None:
    """Look up existing document by user_id + filename. Returns doc record or None."""
    supabase = get_supabase_client()
    result = supabase.table("documents").select(DOCUMENT_LOOKUP_COLUMNS).eq(
        "user_id", user_id
    ).eq("filename", filename).execute()

    if result.data:
        return result.data[0]
    return None


def determine_action(existing_doc: dict | None, new_hash: str) -> Literal["new", "skip", "update"]:
    """
    Decide what action to take based on existing document and new content hash.

    - No existing doc → "new"
    - Same content_hash → "skip" unless the existing document failed
    - Different content_hash → "update"
    """
    if existing_doc is None:
        return "new"
    if existing_doc.get("status") == "failed":
        return "update"
    if existing_doc.get("content_hash") == new_hash:
        return "skip"
    return "update"


def delete_existing_chunks(document_id: str) -> int:
    """Delete all chunks for a document. Returns count of deleted chunks."""
    supabase = get_supabase_client()
    result = supabase.table("chunks").delete().eq("document_id", document_id).execute()
    return len(result.data) if result.data else 0
