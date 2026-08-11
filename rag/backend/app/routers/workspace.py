import logging
import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, status, Query, UploadFile, File
from fastapi.responses import Response

from app.dependencies import get_current_user, User
from app.db.supabase import get_supabase_client
from app.models.schemas import WorkspaceFileResponse
from app.services import workspace_service

logger = logging.getLogger(__name__)

_TEXT_CONTENT_TYPES = {
    "application/json",
    "application/sql",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
}

def _is_text_content_type(content_type: str) -> bool:
    return content_type.startswith("text/") or content_type in _TEXT_CONTENT_TYPES

# Content types a browser will render as active (script-bearing) content. We
# never serve user-uploaded files under these inline — force text/plain so a
# malicious upload (e.g. an .html with <script>) can't execute on the API origin
# if it's ever loaded directly.
_ACTIVE_CONTENT_TYPES = {
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/xml",
    "text/xml",
}

def _safe_inline_media_type(content_type: str | None) -> str:
    base = (content_type or "text/plain").split(";")[0].strip().lower()
    if base in _ACTIVE_CONTENT_TYPES:
        return "text/plain; charset=utf-8"
    return content_type or "text/plain"

router = APIRouter(prefix="/threads", tags=["workspace"])

@router.get("/{thread_id}/files", response_model=list[WorkspaceFileResponse])
async def list_workspace_files(
    thread_id: str,
    current_user: User = Depends(get_current_user)
):
    """List all workspace files for a thread."""
    try:
        files = await workspace_service.list_files(thread_id, current_user.id)
        return files
    except PermissionError:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this thread"
        )
    except Exception as e:
        logger.error(f"Error listing workspace files: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list workspace files"
        )

@router.get("/{thread_id}/files/{file_path:path}")
async def get_workspace_file(
    thread_id: str,
    file_path: str,
    download: bool = Query(False),
    current_user: User = Depends(get_current_user)
):
    """Get workspace file content or a signed download URL."""
    try:
        file_record = await workspace_service.get_file(thread_id, file_path, current_user.id)

        if download:
            storage_path = file_record.get("storage_path")
            if storage_path:
                # Binary file in storage - generate signed URL
                supabase = get_supabase_client()
                res = supabase.storage.from_("workspace-files").create_signed_url(storage_path, 3600)
                if isinstance(res, dict) and "signedURL" in res:
                    return {"url": res["signedURL"]}
                return {"url": res}
            else:
                # Text file - return content as attachment
                safe_filename = quote(file_path.split("/")[-1])
                return Response(
                    content=file_record["content"],
                    media_type=file_record["content_type"],
                    headers={
                        "Content-Disposition": f"attachment; filename*=UTF-8''{safe_filename}"
                    }
                )
        else:
            # Return text content. Force a non-active media type for HTML/SVG/XML
            # and stop content sniffing so a malicious upload can't execute on the
            # API origin if loaded directly.
            if file_record.get("content") is not None:
                return Response(
                    content=file_record["content"],
                    media_type=_safe_inline_media_type(file_record["content_type"]),
                    headers={"X-Content-Type-Options": "nosniff"},
                )
            elif file_record.get("storage_path") and _is_text_content_type(file_record.get("content_type") or ""):
                # Text file stored in storage (e.g. sandbox-generated .md)
                # Fetch content from storage and return it
                try:
                    sb = get_supabase_client()
                    data = sb.storage.from_("workspace-files").download(file_record["storage_path"])
                    text = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else data
                    return Response(
                        content=text,
                        media_type=_safe_inline_media_type(file_record["content_type"]),
                        headers={"X-Content-Type-Options": "nosniff"},
                    )
                except Exception as e:
                    logger.error(f"Failed to download text file from storage: {e}")
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail="Failed to retrieve file content from storage"
                    )
            else:
                # It's a binary file, but user didn't ask for download.
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="This is a binary file. Use ?download=true to get a download link."
                )

    except PermissionError:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this thread"
        )
    except FileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"File not found: {file_path}"
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting workspace file: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get workspace file"
        )


_ALLOWED_UPLOAD_TYPES = {
    "application/json",
    "application/msword",
    "application/pdf",
    "application/rtf",
    "application/sql",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.ms-excel.sheet.macroenabled.12",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/css",
    "text/csv",
    "text/html",
    "text/javascript",
    "text/plain",
    "text/markdown",
    "text/tab-separated-values",
    "text/typescript",
    "text/x-python",
}
_EXTENSION_TO_CONTENT_TYPE = {
    ".css": "text/css",
    ".csv": "text/csv",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".gif": "image/gif",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".jsx": "text/javascript",
    ".json": "application/json",
    ".log": "text/plain",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".py": "text/x-python",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".rtf": "application/rtf",
    ".sql": "application/sql",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xls": "application/vnd.ms-excel",
    ".xlsm": "application/vnd.ms-excel.sheet.macroenabled.12",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
}
_ALLOWED_EXTENSIONS = set(_EXTENSION_TO_CONTENT_TYPE)
_MAX_UPLOAD_SIZE = 20 * 1024 * 1024  # 20MB


@router.post("/{thread_id}/files/upload", response_model=WorkspaceFileResponse, status_code=status.HTTP_201_CREATED)
async def upload_file(
    thread_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Upload a file to the thread workspace."""
    # Validate thread ownership
    if not await workspace_service.verify_thread_ownership(thread_id, current_user.id):
        raise HTTPException(status_code=403, detail="You do not have access to this thread")

    # Validate file name and extension
    filename = file.filename or "unnamed"
    ext = ""
    if "." in filename:
        ext = "." + filename.rsplit(".", 1)[1].lower()

    if ext not in _ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(_ALLOWED_EXTENSIONS))
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}. Allowed: {allowed}")

    # Read file content
    try:
        file_bytes = await file.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read file: {e}")

    if len(file_bytes) == 0:
        raise HTTPException(status_code=400, detail="File is empty")

    if len(file_bytes) > _MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=400, detail=f"File exceeds {_MAX_UPLOAD_SIZE // (1024*1024)}MB limit")

    content_type = file.content_type or "application/octet-stream"
    inferred_content_type = _EXTENSION_TO_CONTENT_TYPE.get(ext)
    if inferred_content_type and (
        content_type == "application/octet-stream"
        or _is_text_content_type(inferred_content_type)
    ):
        content_type = inferred_content_type

    supabase = get_supabase_client()
    file_path = f"uploads/{filename}"

    # For text files, store content directly
    if _is_text_content_type(content_type):
        try:
            text_content = workspace_service.sanitize_db_text(file_bytes.decode("utf-8"))
        except UnicodeDecodeError:
            raise HTTPException(status_code=400, detail="File is not valid UTF-8 text")

        data = {
            "thread_id": thread_id,
            "file_path": file_path,
            "content": text_content,
            "size_bytes": len(file_bytes),
            "content_type": content_type,
            "source": "upload",
        }
        result = supabase.table("workspace_files").upsert(data, on_conflict="thread_id,file_path").execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to save file")
        return result.data[0]

    # For binary files, upload to Supabase Storage
    storage_filename = f"{thread_id}/{uuid.uuid4()}{ext}"
    try:
        supabase.storage.from_("workspace-files").upload(
            storage_filename,
            file_bytes,
            {"content-type": content_type},
        )
    except Exception as e:
        logger.error(f"Storage upload failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload file to storage")

    # Extract text preview for content column
    text_preview = ""
    try:
        from app.services.text_extraction import extract_text
        import asyncio
        extracted = await extract_text(file_bytes, content_type)
        text_preview = workspace_service.sanitize_db_text(extracted[:1000]) if extracted else ""
    except Exception as e:
        logger.warning(f"Text extraction for preview failed: {e}")

    data = {
        "thread_id": thread_id,
        "file_path": file_path,
        "content": text_preview,
        "storage_path": storage_filename,
        "size_bytes": len(file_bytes),
        "content_type": content_type,
        "source": "upload",
    }
    result = supabase.table("workspace_files").upsert(data, on_conflict="thread_id,file_path").execute()
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to save file record")
    return result.data[0]
