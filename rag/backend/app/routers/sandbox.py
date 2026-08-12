"""Sandbox file download and listing endpoints."""
from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies import get_current_user, User
from app.db.supabase import get_supabase_client

router = APIRouter(prefix="/sandbox", tags=["sandbox"])


@router.get("/files/{file_id}/download")
async def get_file_download_url(
    file_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get a fresh signed download URL for a sandbox output file."""
    supabase = get_supabase_client()

    # Fetch file record with ownership check in one query (join threads)
    result = supabase.table("workspace_files").select(
        "*, threads!inner(user_id)"
    ).eq("id", file_id).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    file_record = result.data[0]

    # Verify ownership from joined thread data
    thread_data = file_record.pop("threads", {})
    if thread_data.get("user_id") != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found",
        )

    # Ensure it's a file with storage
    if not file_record.get("storage_path"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File does not have external storage",
        )

    # Use workspace-files bucket only (no fallback)
    bucket = "workspace-files"
    signed = supabase.storage.from_(bucket).create_signed_url(
        file_record["storage_path"], 3600
    )
    download_url = signed.get("signedURL", "") if isinstance(signed, dict) else ""
    
    if not download_url:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate download URL",
        )

    return {"download_url": download_url}


@router.get("/executions/{execution_id}/files")
async def list_execution_files(
    execution_id: str,
    current_user: User = Depends(get_current_user),
):
    """List all files for a code execution."""
    supabase = get_supabase_client()

    # Verify ownership via the execution record
    exec_result = supabase.table("code_executions").select("id").eq(
        "id", execution_id
    ).eq("user_id", current_user.id).execute()

    if not exec_result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Execution not found",
        )

    files_result = supabase.table("workspace_files").select("*").eq(
        "execution_id", execution_id
    ).execute()

    files = []
    for f in files_result.data or []:
        if not f.get("storage_path"):
            continue
            
        # Use workspace-files bucket only
        bucket = "workspace-files"
        signed = supabase.storage.from_(bucket).create_signed_url(
            f["storage_path"], 3600
        )
        download_url = signed.get("signedURL", "") if isinstance(signed, dict) else ""

        files.append({
            "id": f["id"],
            "filename": f["file_path"],
            "file_size": f["size_bytes"],
            "content_type": f["content_type"],
            "download_url": download_url,
            "created_at": f["created_at"],
        })

    return files
