"""Folder CRUD endpoints for hierarchical document organization."""
from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies import get_current_user, User
from app.db.supabase import get_supabase_client
from app.models.schemas import FolderCreate, FolderUpdate, FolderResponse, FolderMove, FolderShareToggle

router = APIRouter(prefix="/folders", tags=["folders"])

STORAGE_DELETE_BATCH_SIZE = 100


def _batch(items: list[str], size: int = STORAGE_DELETE_BATCH_SIZE):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _collect_folder_tree_ids(supabase, root_folder_id: str) -> list[str]:
    folder_ids: list[str] = []
    seen: set[str] = set()
    queue = [root_folder_id]
    index = 0

    while index < len(queue):
        folder_id = queue[index]
        index += 1

        if folder_id in seen:
            continue

        seen.add(folder_id)
        folder_ids.append(folder_id)

        children = supabase.table("folders").select("id").eq(
            "parent_id", folder_id
        ).execute()
        for child in children.data or []:
            child_id = child.get("id")
            if child_id and child_id not in seen:
                queue.append(child_id)

    return folder_ids


def _delete_documents_in_folders(supabase, folder_ids: list[str], user_id: str) -> int:
    if not folder_ids:
        return 0

    result = supabase.table("documents").select("id,storage_path").in_(
        "folder_id", folder_ids
    ).eq("user_id", user_id).execute()

    documents = result.data or []
    storage_paths = [
        doc["storage_path"]
        for doc in documents
        if doc.get("storage_path")
    ]
    document_ids = [
        doc["id"]
        for doc in documents
        if doc.get("id")
    ]

    for paths in _batch(storage_paths):
        try:
            supabase.storage.from_("documents").remove(paths)
        except Exception:
            pass

    for ids in _batch(document_ids):
        supabase.table("documents").delete().in_("id", ids).eq(
            "user_id", user_id
        ).execute()

    return len(document_ids)


@router.post("", response_model=FolderResponse)
async def create_folder(
    folder: FolderCreate,
    current_user: User = Depends(get_current_user),
):
    """Create a new folder for the current user.

    - parent_id: UUID of parent folder (null for root-level folder)
    - name: Folder name (will be trimmed, must be non-empty)
    """
    supabase = get_supabase_client()

    # Validate parent folder exists and is visible to user (if parent_id provided)
    if folder.parent_id:
        parent = supabase.table("folders").select("id").eq(
            "id", folder.parent_id
        ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()
        if not parent or not parent.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Parent folder not found"
            )

    try:
        result = supabase.table("folders").insert({
            "user_id": current_user.id,
            "parent_id": folder.parent_id,
            "name": folder.name,
        }).execute()
    except Exception as e:
        # Handle unique constraint violation (duplicate name)
        if "duplicate" in str(e).lower() or "unique" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A folder with this name already exists in this location"
            )
        raise

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create folder"
        )

    return result.data[0]


@router.get("", response_model=list[FolderResponse])
async def list_folders(
    parent_id: str | None = None,
    all: bool = False,
    current_user: User = Depends(get_current_user),
):
    """List folders.

    - If all is true, returns every visible folder (flat) regardless of parent —
      used to build folder pickers (e.g. bulk "move to folder")
    - Else if parent_id is provided, lists children of that folder
    - Else lists root-level folders
    - Returns both global folders and user's own folders (visibility filtered by application)
    """
    supabase = get_supabase_client()

    query = supabase.table("folders").select("*")
    # Service role bypasses RLS - filter explicitly for user's own + global folders
    query = query.or_(f"user_id.is.null,user_id.eq.{current_user.id}")

    if not all:
        if parent_id:
            query = query.eq("parent_id", parent_id)
        else:
            query = query.is_("parent_id", "null")

    result = query.order("name").execute()
    return result.data or []


@router.get("/{folder_id}", response_model=FolderResponse)
async def get_folder(
    folder_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get a single folder by ID."""
    supabase = get_supabase_client()

    result = supabase.table("folders").select("*").eq(
        "id", folder_id
    ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()

    if not result or not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Folder not found"
        )

    return result.data


@router.patch("/{folder_id}", response_model=FolderResponse)
async def update_folder(
    folder_id: str,
    folder: FolderUpdate,
    current_user: User = Depends(get_current_user),
):
    """Rename a folder.

    Note: Users can only rename their own folders (application-enforced).
    Global folders cannot be renamed by regular users.
    """
    supabase = get_supabase_client()

    try:
        # Only allow renaming user's own folders (not global, not other users')
        result = supabase.table("folders").update({
            "name": folder.name
        }).eq("id", folder_id).eq("user_id", current_user.id).execute()
    except Exception as e:
        # Handle unique constraint violation (duplicate name after rename)
        if "duplicate" in str(e).lower() or "unique" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A folder with this name already exists in this location"
            )
        raise

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Folder not found or access denied"
        )

    return result.data[0]


@router.delete("/{folder_id}")
async def delete_folder(
    folder_id: str,
    current_user: User = Depends(get_current_user),
):
    """Delete a folder and all its contents.

    Note: Users can only delete their own folders (application-enforced).
    Global folders cannot be deleted by regular users.
    """
    supabase = get_supabase_client()

    # Check folder exists and is visible to user (global or own)
    check = supabase.table("folders").select("id, user_id").eq(
        "id", folder_id
    ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()

    if not check or not check.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Folder not found or access denied"
        )

    # Cannot delete global folders
    if check.data["user_id"] is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot delete global folders"
        )

    folder_ids = _collect_folder_tree_ids(supabase, folder_id)
    _delete_documents_in_folders(supabase, folder_ids, current_user.id)

    # Delete folder (only own folders; FK cascade handles subfolders)
    supabase.table("folders").delete().eq("id", folder_id).eq("user_id", current_user.id).execute()

    return {"status": "deleted"}


@router.get("/{folder_id}/ancestors")
async def get_folder_ancestors(
    folder_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get the ancestor path for a folder (from root to current folder).

    Returns a list of {id, name} objects ordered from root to current folder.
    Example: [{id: "root-id", name: "Projects"}, {id: "sub-id", name: "Work"}]
    """
    supabase = get_supabase_client()

    ancestors = []
    current_id = folder_id

    # Walk up the tree until we hit root (null parent_id)
    while current_id:
        result = supabase.table("folders").select("id, name, parent_id").eq(
            "id", current_id
        ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()

        if not result or not result.data:
            # Folder not found or no access - stop here
            break

        ancestors.append({"id": result.data["id"], "name": result.data["name"]})
        current_id = result.data["parent_id"]

    # Reverse to get root-first order
    ancestors.reverse()
    return ancestors


@router.patch("/{folder_id}/move", response_model=FolderResponse)
async def move_folder(
    folder_id: str,
    move_request: FolderMove,
    current_user: User = Depends(get_current_user),
):
    """Move a folder to a different parent (or to root if parent_id is null).

    Cycle detection is handled by database trigger - attempting to move a folder
    into itself or its descendants will fail with a 400 error.
    """
    supabase = get_supabase_client()

    # Verify folder exists and is visible to user (global or own)
    folder_check = supabase.table("folders").select("id, user_id").eq(
        "id", folder_id
    ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()

    if not folder_check or not folder_check.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Folder not found or access denied"
        )

    # Cannot move global folders (user_id is NULL)
    if folder_check.data["user_id"] is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot move global folders"
        )

    # Verify target parent exists and is visible to user (if provided)
    if move_request.parent_id:
        parent_check = supabase.table("folders").select("id").eq(
            "id", move_request.parent_id
        ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()

        if not parent_check or not parent_check.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Target folder not found or access denied"
            )

    try:
        result = supabase.table("folders").update({
            "parent_id": move_request.parent_id
        }).eq("id", folder_id).execute()
    except Exception as e:
        # Handle cycle detection error from database trigger
        error_msg = str(e).lower()
        if "circular reference" in error_msg or "own parent" in error_msg:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot move folder into itself or its descendants"
            )
        raise

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to move folder"
        )

    return result.data[0]


@router.patch("/{folder_id}/share", response_model=FolderResponse)
async def share_folder(
    folder_id: str,
    share_request: FolderShareToggle,
    current_user: User = Depends(get_current_user),
):
    """Toggle folder sharing between global (shared with all) and private.

    - is_global=True: Share folder with all users (sets user_id to NULL)
    - is_global=False: Make folder private (sets user_id to current user)
    - Only top-level folders can be shared (parent_id must be NULL)
    """
    supabase = get_supabase_client()

    # Fetch folder by ID using service role (no user filter - need to see all folders)
    folder = supabase.table("folders").select("*").eq(
        "id", folder_id
    ).maybe_single().execute()

    if not folder or not folder.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Folder not found"
        )

    # Top-level only: subfolders cannot be shared
    if folder.data["parent_id"] is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only top-level folders can be shared globally"
        )

    if share_request.is_global:
        # Share: folder must be owned by current user
        if folder.data["user_id"] != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You can only share your own folders"
            )
        # Set user_id to NULL to make it global, record original owner in shared_by
        result = supabase.table("folders").update({
            "user_id": None,
            "shared_by": current_user.id,
        }).eq("id", folder_id).execute()
        # Cascade to all subfolders
        supabase.rpc("cascade_folder_user_id", {
            "root_folder_id": folder_id,
            "new_user_id": None,
        }).execute()
    else:
        # Unshare: folder must currently be global (user_id IS NULL)
        if folder.data["user_id"] is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Folder is not currently shared"
            )
        # Only the original owner can make it private again
        if folder.data.get("shared_by") != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the original owner can make this folder private"
            )
        # Restore user_id to original owner, clear shared_by
        result = supabase.table("folders").update({
            "user_id": current_user.id,
            "shared_by": None,
        }).eq("id", folder_id).is_("user_id", "null").execute()
        # Cascade to all subfolders
        supabase.rpc("cascade_folder_user_id", {
            "root_folder_id": folder_id,
            "new_user_id": current_user.id,
        }).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update folder sharing"
        )

    return result.data[0]
