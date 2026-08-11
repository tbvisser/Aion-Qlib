"""Document upload, list, and delete endpoints."""
import uuid
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks, status
from postgrest.exceptions import APIError

from app.dependencies import get_current_user, User
from app.db.supabase import get_supabase_client
from app.models.schemas import (
    BulkActionResponse,
    BulkDeleteRequest,
    BulkMoveRequest,
    ChunkRangeRequest,
    DocumentMove,
    DocumentRenderResponse,
    DocumentResponse,
    PaginatedDocumentsResponse,
)
from app.services.ingestion_service import process_document
from app.services.record_manager import compute_file_hash, check_existing_document, determine_action, delete_existing_chunks
from app.services.retrieval_service import search_documents

router = APIRouter(prefix="/documents", tags=["documents"])

ALLOWED_EXTENSIONS = {
    ".txt", ".md",
    ".pdf",
    ".docx", ".pptx", ".xlsx",
    ".html", ".htm",
    ".png", ".jpg", ".jpeg", ".tiff",
}

EXTENSION_TO_CONTENT_TYPE = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".html": "text/html",
    ".htm": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".tiff": "image/tiff",
}

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB

MAX_BULK_DOCUMENTS = 200  # Max documents per bulk delete/move request

DOCUMENT_RESPONSE_COLUMNS = (
    "id,user_id,folder_id,filename,file_type,file_size,storage_path,status,"
    "error_message,ingestion_stage,ingestion_progress,ingestion_message,"
    "chunk_count,content_hash,hierarchical_index,metadata,"
    "created_at,updated_at"
)


@router.post("/upload")
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    folder_id: str | None = Form(None),
    current_user: User = Depends(get_current_user),
):
    """Upload a document for ingestion."""
    # Validate file extension
    filename = file.filename or "unknown"
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type. Allowed: {', '.join(ALLOWED_EXTENSIONS)}"
        )

    # Read file content
    content = await file.read()

    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File too large. Maximum size is 50 MB."
        )

    if len(content) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File is empty."
        )

    # Determine content type from extension
    content_type = EXTENSION_TO_CONTENT_TYPE.get(ext, "application/octet-stream")

    # Compute content hash for deduplication
    content_hash = compute_file_hash(content)

    # Check for existing document with same (user_id, filename)
    existing_doc = check_existing_document(current_user.id, filename)
    action = determine_action(existing_doc, content_hash)

    supabase = get_supabase_client()

    # Validate folder access if folder_id provided
    # Service role bypasses RLS - filter explicitly for user's own + global folders
    if folder_id:
        folder_check = supabase.table("folders").select("id").eq(
            "id", folder_id
        ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()
        if not folder_check or not folder_check.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Folder not found or access denied"
            )

    if action == "skip":
        # Identical content — return existing document without reprocessing
        existing_doc["action"] = "skipped"
        return existing_doc

    if action == "update":
        # Different content — delete old chunks, re-upload, re-process
        delete_existing_chunks(existing_doc["id"])

        # Overwrite file in storage
        try:
            supabase.storage.from_("documents").remove([existing_doc["storage_path"]])
        except Exception:
            pass
        supabase.storage.from_("documents").upload(
            path=existing_doc["storage_path"],
            file=content,
            file_options={"content-type": content_type},
        )

        # Update document record
        supabase.table("documents").update({
            "content_hash": content_hash,
            "file_size": len(content),
            "status": "pending",
            "error_message": None,
            "ingestion_stage": "queued",
            "ingestion_progress": 0,
            "ingestion_message": "Queued for processing",
            "chunk_count": None,
            "metadata": None,
            "full_markdown": None,
            "hierarchical_index": None,
            "document_structure": None,
            "document_pages": None,
            "document_layout": None,
        }).eq("id", existing_doc["id"]).execute()

        # Trigger background re-processing (pass file bytes to avoid re-download)
        background_tasks.add_task(process_document, existing_doc["id"], current_user.id, content)

        updated = supabase.table("documents").select(DOCUMENT_RESPONSE_COLUMNS).eq(
            "id", existing_doc["id"]
        ).single().execute()
        document = updated.data
        document["action"] = "updated"
        return document

    # action == "new" — create fresh document
    file_id = str(uuid.uuid4())
    storage_path = f"{current_user.id}/{file_id}{ext}"

    supabase.storage.from_("documents").upload(
        path=storage_path,
        file=content,
        file_options={"content-type": content_type},
    )

    doc_record = {
        "user_id": current_user.id,
        "folder_id": folder_id,  # Can be None for unfiled documents
        "filename": filename,
        "file_type": content_type,
        "file_size": len(content),
        "storage_path": storage_path,
        "status": "pending",
        "ingestion_stage": "queued",
        "ingestion_progress": 0,
        "ingestion_message": "Queued for processing",
        "content_hash": content_hash,
    }

    result = supabase.table("documents").insert(doc_record).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create document record"
        )

    document = result.data[0]

    # Trigger background processing (pass file bytes to avoid re-download)
    background_tasks.add_task(process_document, document["id"], current_user.id, content)

    document["action"] = "created"
    return document


@router.get("", response_model=PaginatedDocumentsResponse)
async def list_documents(
    folder_id: str | None = None,
    offset: int = 0,
    limit: int = 50,
    current_user: User = Depends(get_current_user),
):
    """List documents for the current user with pagination.

    - If folder_id is provided: filter by that folder
    - If folder_id is "unfiled": filter by documents with null folder_id
    - If folder_id is omitted: return all documents

    Pagination:
    - offset: Starting index (default 0)
    - limit: Number of items to return (default 50, max 200)
    """
    # Enforce limits
    limit = min(limit, 200)
    offset = max(offset, 0)

    supabase = get_supabase_client()

    # Check if requested folder is global (shared) - if so, show all docs in it
    is_global_folder = False
    if folder_id and folder_id != "unfiled":
        folder_check = supabase.table("folders").select("user_id").eq(
            "id", folder_id
        ).maybe_single().execute()
        if folder_check and folder_check.data:
            is_global_folder = folder_check.data["user_id"] is None

    # Build base query - show all docs in global folders, only own docs otherwise
    base_query = supabase.table("documents").select(DOCUMENT_RESPONSE_COLUMNS, count="exact")
    if not is_global_folder:
        base_query = base_query.eq("user_id", current_user.id)

    if folder_id == "unfiled":
        base_query = base_query.is_("folder_id", "null")
    elif folder_id:
        base_query = base_query.eq("folder_id", folder_id)

    # Execute with pagination. PostgREST raises PGRST103 ("Requested range not
    # satisfiable") instead of returning an empty page when ``offset`` is past the
    # end of the result set. This happens routinely here: the row count can shrink
    # between a client's successive page requests (e.g. uploads failing or being
    # cleaned up mid-ingestion), leaving the client's offset beyond the current
    # count. Treat it as an empty final page rather than surfacing a 500.
    try:
        result = base_query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
    except APIError as e:
        if e.code != "PGRST103":
            raise
        return {"documents": [], "total_count": 0, "has_more": False}

    total_count = result.count or 0
    documents = result.data or []
    has_more = offset + len(documents) < total_count

    return {
        "documents": documents,
        "total_count": total_count,
        "has_more": has_more
    }


def _merge_search_results(
    filename_rows: list[dict],
    content_rows: list[dict],
    limit: int,
) -> list[dict]:
    """Merge filename and content matches, filename-first, de-duped by id, capped at ``limit``.

    A filename match is the strongest "find my document" signal, so those rows lead; content
    (hybrid) matches follow in their existing relevance order. A document that matches both keeps
    its earlier (filename) position.
    """
    merged: list[dict] = []
    seen: set[str] = set()
    for row in (*filename_rows, *content_rows):
        doc_id = row["id"]
        if doc_id in seen:
            continue
        seen.add(doc_id)
        merged.append(row)
        if len(merged) >= limit:
            break
    return merged


@router.get("/search", response_model=PaginatedDocumentsResponse)
async def search_documents_endpoint(
    q: str,
    limit: int = 50,
    current_user: User = Depends(get_current_user),
):
    """Search the current user's documents by filename and content (hybrid).

    Combines two signals into a single ranked list of documents (not chunks):
    - filename substring match (also surfaces docs still processing/failed with no chunks yet)
    - hybrid content search (vector + keyword) reused from the RAG retrieval service

    Scope is global across all of the caller's own documents (independent of the current folder),
    matching how RAG chat searches. Documents in shared/global folders owned by other users are not
    included (the content RPCs already filter chunks by the caller's user_id). Results are capped
    and unpaginated (``has_more`` is always False).
    """
    limit = min(max(limit, 1), 100)
    query = (q or "").strip()
    if not query:
        return {"documents": [], "total_count": 0, "has_more": False}

    supabase = get_supabase_client()

    # 1) Filename matches — escape ILIKE wildcards so user input is matched literally
    #    (same pattern as the threads list search).
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    filename_result = (
        supabase.table("documents")
        .select(DOCUMENT_RESPONSE_COLUMNS)
        .eq("user_id", current_user.id)
        .ilike("filename", f"%{escaped}%")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    filename_rows = filename_result.data or []

    # 2) Content matches — hybrid search returns ranked chunks; collapse to ordered distinct
    #    parent document ids. Degrade gracefully to filename-only if retrieval fails (e.g. the
    #    embedding provider is unavailable) rather than failing the whole request.
    try:
        chunks = await search_documents(
            query=query,
            user_id=current_user.id,
            top_k=30,
            search_mode="hybrid",
        )
    except Exception as exc:  # noqa: BLE001 - resilience: filename results are still useful
        import logging
        logging.getLogger(__name__).warning("Content search failed for %r: %s", query, exc)
        chunks = []

    content_ids: list[str] = []
    seen_ids: set[str] = set()
    for chunk in chunks:
        doc_id = str(chunk.get("document_id") or "")
        if doc_id and doc_id not in seen_ids:
            seen_ids.add(doc_id)
            content_ids.append(doc_id)

    content_rows: list[dict] = []
    if content_ids:
        content_result = (
            supabase.table("documents")
            .select(DOCUMENT_RESPONSE_COLUMNS)
            .eq("user_id", current_user.id)
            .in_("id", content_ids)
            .execute()
        )
        by_id = {row["id"]: row for row in (content_result.data or [])}
        # Preserve hybrid rank order from content_ids.
        content_rows = [by_id[doc_id] for doc_id in content_ids if doc_id in by_id]

    merged = _merge_search_results(filename_rows, content_rows, limit)
    return {"documents": merged, "total_count": len(merged), "has_more": False}


@router.post("/bulk-delete", response_model=BulkActionResponse)
async def bulk_delete_documents(
    request: BulkDeleteRequest,
    current_user: User = Depends(get_current_user),
):
    """Delete multiple documents at once (chunks cascade via FK).

    Only documents owned by the caller are deleted. Requested IDs that are not
    found or not owned are returned in ``failed`` rather than raising.
    """
    requested_ids = list(dict.fromkeys(request.document_ids))  # de-dupe, preserve order
    if not requested_ids:
        return {"succeeded": [], "failed": []}

    if len(requested_ids) > MAX_BULK_DOCUMENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Too many documents: max {MAX_BULK_DOCUMENTS} per request",
        )

    supabase = get_supabase_client()

    # Fetch the owner + storage path for each requested document.
    result = supabase.table("documents").select(
        "id,user_id,storage_path"
    ).in_("id", requested_ids).eq("user_id", current_user.id).execute()

    owned = result.data or []
    owned_ids = [doc["id"] for doc in owned]
    failed = [doc_id for doc_id in requested_ids if doc_id not in set(owned_ids)]

    if owned_ids:
        # Remove storage files (best-effort; records are the source of truth).
        storage_paths = [doc["storage_path"] for doc in owned if doc.get("storage_path")]
        if storage_paths:
            try:
                supabase.storage.from_("documents").remove(storage_paths)
            except Exception:
                pass  # Storage files may already be gone

        supabase.table("documents").delete().in_("id", owned_ids).execute()

    return {"succeeded": owned_ids, "failed": failed}


@router.post("/bulk-move", response_model=BulkActionResponse)
async def bulk_move_documents(
    request: BulkMoveRequest,
    current_user: User = Depends(get_current_user),
):
    """Move multiple documents to a different folder (or to root if folder_id is null).

    Only documents owned by the caller are moved. Requested IDs that are not
    found or not owned are returned in ``failed`` rather than raising.
    """
    requested_ids = list(dict.fromkeys(request.document_ids))  # de-dupe, preserve order
    if not requested_ids:
        return {"succeeded": [], "failed": []}

    if len(requested_ids) > MAX_BULK_DOCUMENTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Too many documents: max {MAX_BULK_DOCUMENTS} per request",
        )

    supabase = get_supabase_client()

    # Verify the target folder exists and is visible to the user (own or global).
    if request.folder_id:
        folder_check = supabase.table("folders").select("id").eq(
            "id", request.folder_id
        ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()
        if not folder_check or not folder_check.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Target folder not found or access denied",
            )

    # Restrict the move to documents the caller owns.
    result = supabase.table("documents").select("id").in_(
        "id", requested_ids
    ).eq("user_id", current_user.id).execute()

    owned_ids = [doc["id"] for doc in (result.data or [])]
    failed = [doc_id for doc_id in requested_ids if doc_id not in set(owned_ids)]

    if owned_ids:
        supabase.table("documents").update({
            "folder_id": request.folder_id
        }).in_("id", owned_ids).execute()

    return {"succeeded": owned_ids, "failed": failed}


@router.get("/{document_id}", response_model=DocumentResponse)
async def get_document(
    document_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get a single document with metadata."""
    supabase = get_supabase_client()
    result = supabase.table("documents").select(DOCUMENT_RESPONSE_COLUMNS).eq(
        "id", document_id
    ).eq("user_id", current_user.id).single().execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found"
        )

    return result.data


@router.post("/{document_id}/retry", response_model=DocumentResponse)
async def retry_document(
    document_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
):
    """Retry ingestion for a failed document using the already-uploaded file."""
    supabase = get_supabase_client()
    result = supabase.table("documents").select(DOCUMENT_RESPONSE_COLUMNS).eq(
        "id", document_id
    ).eq("user_id", current_user.id).maybe_single().execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found"
        )

    doc = result.data
    if doc.get("status") in {"pending", "processing"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Document is already queued or processing"
        )

    if doc.get("status") != "failed":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only failed documents can be retried"
        )

    delete_existing_chunks(document_id)
    reset_payload = {
        "status": "pending",
        "error_message": None,
        "ingestion_stage": "queued",
        "ingestion_progress": 0,
        "ingestion_message": "Queued for retry",
        "chunk_count": 0,
        "metadata": None,
        "full_markdown": None,
        "hierarchical_index": None,
        "document_structure": None,
        "document_pages": None,
        "document_layout": None,
    }
    update = supabase.table("documents").update(reset_payload).eq(
        "id", document_id
    ).eq("user_id", current_user.id).execute()

    if not update.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to reset document for retry"
        )

    background_tasks.add_task(process_document, document_id, current_user.id)

    refreshed = supabase.table("documents").select(DOCUMENT_RESPONSE_COLUMNS).eq(
        "id", document_id
    ).eq("user_id", current_user.id).single().execute()
    return refreshed.data


@router.get("/{document_id}/render", response_model=DocumentRenderResponse)
async def get_document_render(
    document_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get page-aware render metadata for the document sidecar."""
    supabase = get_supabase_client()
    result = supabase.table("documents").select(
        "id, user_id, folder_id, full_markdown, document_pages, document_structure"
    ).eq("id", document_id).maybe_single().execute()

    if not result or not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )

    doc = result.data
    if doc["user_id"] != current_user.id:
        folder_id = doc.get("folder_id")
        if not folder_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document not found",
            )

        folder_check = supabase.table("folders").select("user_id").eq(
            "id", folder_id
        ).maybe_single().execute()
        if (
            not folder_check
            or not folder_check.data
            or folder_check.data["user_id"] is not None
        ):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document not found",
            )

    pages = doc.get("document_pages") or []
    if not isinstance(pages, list):
        pages = []

    return {
        "document_id": doc["id"],
        "markdown": doc.get("full_markdown"),
        "pages": pages,
        "structure": doc.get("document_structure"),
    }


@router.get("/{document_id}/chunks")
async def get_document_chunks(
    document_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get chunks for a document (content, chunk_index, metadata) without embeddings."""
    supabase = get_supabase_client()

    # Verify document ownership
    doc_result = supabase.table("documents").select("id").eq(
        "id", document_id
    ).eq("user_id", current_user.id).single().execute()

    if not doc_result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found"
        )

    result = supabase.table("chunks").select(
        "id, content, chunk_index, metadata"
    ).eq("document_id", document_id).order("chunk_index").execute()

    return result.data or []


@router.post("/chunks-by-ranges")
async def get_chunks_by_ranges(
    request: ChunkRangeRequest,
    current_user: User = Depends(get_current_user),
):
    """Retrieve specific chunk ranges from documents using the hierarchical structure."""
    # Cardinality limits to prevent combinatorial explosion
    if len(request.items) > 20:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Too many items: max 20 documents per request",
        )

    # Validate ranges
    for item in request.items:
        if len(item.chunk_ranges) > 50:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Too many ranges for document {item.document_id}: max 50 per document",
            )
        for r in item.chunk_ranges:
            if len(r) != 2 or r[0] > r[1]:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid range {r}: must be [start, end] with start <= end",
                )

    input_data = [
        {"document_id": item.document_id, "chunk_ranges": item.chunk_ranges}
        for item in request.items
    ]

    supabase = get_supabase_client()
    result = supabase.rpc("get_chunks_by_ranges", {
        "p_input_data": input_data,
        "p_user_id": current_user.id,
    }).execute()

    data = result.data or []

    # Group results by document_id
    grouped: dict[str, list] = {}
    for chunk in data:
        doc_id = str(chunk["document_id"])
        grouped.setdefault(doc_id, []).append(chunk)

    return {"data": grouped, "total_chunks": len(data)}


@router.delete("/{document_id}")
async def delete_document(
    document_id: str,
    current_user: User = Depends(get_current_user),
):
    """Delete a document and its storage file (chunks cascade via FK).

    Only the document's owner can delete it, even when the document lives in
    a shared folder.
    """
    supabase = get_supabase_client()

    # maybe_single() returns data=None on 0 rows instead of raising PGRST116.
    result = supabase.table("documents").select(
        "id,user_id,storage_path"
    ).eq(
        "id", document_id
    ).maybe_single().execute()

    if not result or not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found"
        )

    doc = result.data

    if doc["user_id"] != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the document owner can delete this document"
        )

    # Delete from storage
    try:
        supabase.storage.from_("documents").remove([doc["storage_path"]])
    except Exception:
        pass  # Storage file may already be gone

    # Delete document record (chunks cascade)
    supabase.table("documents").delete().eq("id", document_id).execute()

    return {"status": "deleted"}


@router.get("/{document_id}/download")
async def download_document(
    document_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get a signed download URL for a document's original file."""
    supabase = get_supabase_client()

    # First try user's own documents
    result = supabase.table("documents").select(
        "storage_path, file_type, folder_id"
    ).eq("id", document_id).eq("user_id", current_user.id).maybe_single().execute()

    if not result or not result.data:
        # Check if document is in a global folder (user_id is null on folder)
        result = supabase.table("documents").select(
            "storage_path, file_type, folder_id"
        ).eq("id", document_id).maybe_single().execute()

        if not result or not result.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document not found"
            )

        # Verify the folder is global
        folder_id = result.data.get("folder_id")
        if folder_id:
            folder_check = supabase.table("folders").select("user_id").eq(
                "id", folder_id
            ).maybe_single().execute()
            if not folder_check or not folder_check.data or folder_check.data["user_id"] is not None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Document not found"
                )
        else:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document not found"
            )

    storage_path = result.data["storage_path"]
    try:
        # 1 hour TTL: the citation/docs PDF viewers fetch this URL lazily (only
        # when the Page view is opened) and reuse it across re-renders/zoom, so a
        # short 5-minute window expired before a user who read the extracted text
        # first then clicked "Page". Matches the TTL used for skill/workspace files.
        signed = supabase.storage.from_("documents").create_signed_url(
            storage_path, expires_in=3600
        )
        url = signed.get("signedURL") or signed.get("signedUrl")
        if not url:
            raise ValueError("No signed URL returned")
    except Exception as exc:
        import logging
        logging.getLogger(__name__).error("Failed to generate download URL for %s: %s", document_id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate download URL"
        )

    return {"url": url, "file_type": result.data["file_type"]}


@router.patch("/{document_id}/move")
async def move_document(
    document_id: str,
    move_request: DocumentMove,
    current_user: User = Depends(get_current_user),
):
    """Move a document to a different folder (or to root if folder_id is null)."""
    supabase = get_supabase_client()

    # Verify document exists and user owns it
    doc_check = supabase.table("documents").select("id").eq(
        "id", document_id
    ).eq("user_id", current_user.id).maybe_single().execute()

    if not doc_check.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found"
        )

    # Verify target folder exists and is visible to user (if provided)
    # Service role bypasses RLS - filter explicitly for user's own + global folders
    if move_request.folder_id:
        folder_check = supabase.table("folders").select("id").eq(
            "id", move_request.folder_id
        ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()

        if not folder_check or not folder_check.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Target folder not found or access denied"
            )

    # Update document's folder
    result = supabase.table("documents").update({
        "folder_id": move_request.folder_id
    }).eq("id", document_id).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to move document"
        )

    return result.data[0]
