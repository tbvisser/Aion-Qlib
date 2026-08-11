"""Workspace service for managing agent-created files."""
import logging

from app.db.supabase import get_supabase_client
from app.services.langsmith import traceable

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


def sanitize_db_text(content: str) -> str:
    """Remove characters PostgreSQL text columns cannot store."""
    return content.replace("\x00", "")


def _validate_file_path(file_path: str):
    """Validate workspace file path.
    
    Rules:
    - No '..' (path traversal)
    - No backslashes
    - No leading '/' (must be relative)
    - Max 500 characters
    - Not empty
    """
    if not file_path:
        raise ValueError("File path cannot be empty")
    
    if len(file_path) > 500:
        raise ValueError("File path exceeds 500 characters")
    
    if ".." in file_path:
        raise ValueError("File path cannot contain path traversal (..)")
    
    if "\\" in file_path:
        raise ValueError("File path cannot contain backslashes (use /)")
    
    if file_path.startswith("/"):
        raise ValueError("File path must be relative (no leading /)")


# Explicit extension -> MIME map so behaviour is deterministic across platforms.
# The stdlib `mimetypes` DB varies by OS (e.g. macOS maps .md -> text/plain and
# .xyz -> chemical/x-xyz), which produced flaky content types for workspace files.
_CONTENT_TYPE_BY_EXT = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".log": "text/plain",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".json": "application/json",
    ".py": "text/x-python",
    ".js": "text/javascript",
    ".ts": "text/x-typescript",
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".xml": "application/xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".sql": "text/x-sql",
    ".sh": "text/x-shellscript",
}


def _infer_content_type(file_path: str) -> str:
    """Infer MIME type from file extension (deterministic; workspace files are
    text artifacts, so unknown extensions default to text/plain)."""
    name = file_path.lower()
    base = name.rsplit("/", 1)[-1]
    ext = base[base.rfind("."):] if "." in base else ""
    return _CONTENT_TYPE_BY_EXT.get(ext, "text/plain")


async def verify_thread_ownership(thread_id: str, user_id: str) -> bool:
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


@traceable(name="write_file", run_type="tool")
async def write_file(thread_id: str, file_path: str, content: str, user_id: str) -> dict:
    """Create or update a workspace file for a thread.
    
    Max content size: 1MB.
    """
    if not await verify_thread_ownership(thread_id, user_id):
        raise PermissionError(f"User does not own thread {thread_id}")

    _validate_file_path(file_path)
    
    content = sanitize_db_text(content)
    size_bytes = len(content.encode("utf-8"))
    if size_bytes > 1048576:
        raise ValueError("Content exceeds 1MB limit")
        
    content_type = _infer_content_type(file_path)
    
    supabase = get_supabase_client()
    
    data = {
        "thread_id": thread_id,
        "file_path": file_path,
        "content": content,
        "size_bytes": size_bytes,
        "content_type": content_type,
        "source": "agent"
    }
    
    result = (
        supabase.table("workspace_files")
        .upsert(data, on_conflict="thread_id,file_path")
        .execute()
    )
    
    if not result.data:
        raise Exception("Failed to save workspace file")
        
    return result.data[0]


@traceable(name="append_file", run_type="tool")
async def append_file(thread_id: str, file_path: str, content: str, user_id: str) -> dict:
    """Append content to a workspace file, creating it if it doesn't exist.

    WARNING: Not concurrent-safe. Callers must ensure serialized access per
    (thread_id, file_path). The batch phase handler collects all results in
    memory first and makes a single append_file() call per batch.
    """
    try:
        existing = await read_file(thread_id, file_path, user_id)
    except FileNotFoundError:
        existing = ""

    new_content = existing + sanitize_db_text(content)
    return await write_file(thread_id, file_path, new_content, user_id)


def _apply_line_range(
    content: str,
    start_line: int | None = None,
    end_line: int | None = None,
) -> str:
    if start_line is None and end_line is None:
        return content

    if start_line is not None:
        start_line = int(start_line)
    if end_line is not None:
        end_line = int(end_line)

    if start_line is not None and start_line < 1:
        raise ValueError("start_line must be 1 or greater")
    if end_line is not None and end_line < 1:
        raise ValueError("end_line must be 1 or greater")
    if start_line is not None and end_line is not None and start_line > end_line:
        raise ValueError("start_line must be less than or equal to end_line")

    lines = content.splitlines()
    start_idx = (start_line or 1) - 1
    end_idx = end_line if end_line is not None else len(lines)
    return "\n".join(lines[start_idx:end_idx])


async def _read_stored_file_text(supabase, storage_path: str, content_type: str) -> str:
    data = supabase.storage.from_("workspace-files").download(storage_path)
    if _is_text_content_type(content_type):
        text = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else str(data)
        return sanitize_db_text(text)

    from app.services.text_extraction import extract_text

    if not isinstance(data, bytes):
        data = str(data).encode("utf-8")
    return sanitize_db_text(await extract_text(data, content_type))


@traceable(name="read_file", run_type="tool")
async def read_file(
    thread_id: str,
    file_path: str,
    user_id: str,
    start_line: int | None = None,
    end_line: int | None = None,
) -> str:
    """Read a workspace file's text content."""
    if not await verify_thread_ownership(thread_id, user_id):
        raise PermissionError(f"User does not own thread {thread_id}")

    _validate_file_path(file_path)
    
    supabase = get_supabase_client()
    
    result = (
        supabase.table("workspace_files")
        .select("content, storage_path, content_type")
        .eq("thread_id", thread_id)
        .eq("file_path", file_path)
        .execute()
    )
    
    if not result.data:
        raise FileNotFoundError(f"File not found: {file_path}")
        
    record = result.data[0]
    content = record.get("content") or ""
    storage_path = record.get("storage_path")
    content_type = record.get("content_type") or "text/plain"

    if storage_path:
        try:
            content = await _read_stored_file_text(supabase, storage_path, content_type)
        except Exception as e:
            if content:
                logger.warning(f"Falling back to stored workspace preview for {file_path}: {e}")
            else:
                raise Exception(f"Failed to read stored workspace file: {e}")

    return _apply_line_range(content, start_line, end_line)


@traceable(name="edit_file", run_type="tool")
async def edit_file(
    thread_id: str,
    file_path: str,
    old_string: str,
    new_string: str,
    user_id: str,
    replace_all: bool = False,
) -> dict:
    """Replace ``old_string`` with ``new_string`` in a workspace file.

    By default, ``old_string`` must appear **exactly once** in the file — if it
    appears zero times or more than once, a ``ValueError`` is raised so the
    caller can disambiguate (add more surrounding context) rather than silently
    editing the wrong occurrence. Pass ``replace_all=True`` to replace every
    occurrence instead.
    """
    if not await verify_thread_ownership(thread_id, user_id):
        raise PermissionError(f"User does not own thread {thread_id}")

    _validate_file_path(file_path)

    # Read content directly to avoid redundant ownership checks
    supabase = get_supabase_client()
    result = (
        supabase.table("workspace_files")
        .select("content")
        .eq("thread_id", thread_id)
        .eq("file_path", file_path)
        .execute()
    )
    if not result.data:
        raise FileNotFoundError(f"File not found: {file_path}")

    current_content = result.data[0]["content"]

    occurrences = current_content.count(old_string)
    if occurrences == 0:
        raise ValueError(f"String not found in file: {old_string}")

    new_string = sanitize_db_text(new_string)
    if replace_all:
        new_content = current_content.replace(old_string, new_string)
    else:
        if occurrences > 1:
            raise ValueError(
                f"String is not unique in file (found {occurrences} occurrences). "
                "Add more surrounding context to make it unique, or pass replace_all=true."
            )
        new_content = current_content.replace(old_string, new_string, 1)

    # Write directly to avoid redundant ownership check
    size_bytes = len(new_content.encode("utf-8"))
    if size_bytes > 1048576:
        raise ValueError("Content exceeds 1MB limit")

    content_type = _infer_content_type(file_path)
    data = {
        "thread_id": thread_id,
        "file_path": file_path,
        "content": new_content,
        "size_bytes": size_bytes,
        "content_type": content_type,
        "source": "agent"
    }
    upsert_result = (
        supabase.table("workspace_files")
        .upsert(data, on_conflict="thread_id,file_path")
        .execute()
    )
    if not upsert_result.data:
        raise Exception("Failed to save workspace file")
    return upsert_result.data[0]


@traceable(name="list_files", run_type="tool")
async def list_files(thread_id: str, user_id: str) -> list[dict]:
    """List all workspace files for a thread."""
    if not await verify_thread_ownership(thread_id, user_id):
        raise PermissionError(f"User does not own thread {thread_id}")

    supabase = get_supabase_client()
    
    result = (
        supabase.table("workspace_files")
        .select("id, thread_id, file_path, size_bytes, content_type, source, storage_path, created_at, updated_at")
        .eq("thread_id", thread_id)
        .execute()
    )
    
    return result.data or []


@traceable(name="download_file_bytes", run_type="tool")
async def download_file_bytes(thread_id: str, file_path: str, user_id: str) -> bytes:
    """Download binary content from Supabase Storage via storage_path."""
    if not await verify_thread_ownership(thread_id, user_id):
        raise PermissionError(f"User does not own thread {thread_id}")

    _validate_file_path(file_path)

    supabase = get_supabase_client()
    result = (
        supabase.table("workspace_files")
        .select("storage_path, content")
        .eq("thread_id", thread_id)
        .eq("file_path", file_path)
        .execute()
    )

    if not result.data:
        raise FileNotFoundError(f"File not found: {file_path}")

    record = result.data[0]
    storage_path = record.get("storage_path")

    if storage_path:
        try:
            return supabase.storage.from_("workspace-files").download(storage_path)
        except Exception as e:
            raise Exception(f"Failed to download from storage: {e}")

    # Fallback to text content
    content = record.get("content", "")
    return content.encode("utf-8") if content else b""


@traceable(name="get_file", run_type="tool")
async def get_file(thread_id: str, file_path: str, user_id: str) -> dict:
    """Get a single workspace file's metadata and content."""
    if not await verify_thread_ownership(thread_id, user_id):
        raise PermissionError(f"User does not own thread {thread_id}")

    supabase = get_supabase_client()
    
    result = (
        supabase.table("workspace_files")
        .select("*")
        .eq("thread_id", thread_id)
        .eq("file_path", file_path)
        .execute()
    )
    
    if not result.data:
        raise FileNotFoundError(f"File not found: {file_path}")
        
    return result.data[0]
