"""Skills CRUD endpoints for agent skill management."""
import io
import logging
import mimetypes
import re
import zipfile

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status
from fastapi.responses import StreamingResponse

from app.dependencies import get_current_user, User
from app.db.supabase import get_supabase_client
from app.models.schemas import (
    SkillCreate,
    SkillUpdate,
    SkillResponse,
    SkillShareToggle,
    SkillImportResult,
    SkillImportResponse,
    SkillImportUrlRequest,
    SkillFileResponse,
    SkillFileContentResponse,
    SkillFileRename,
    SkillFolderCreate,
    SkillFolderRename,
)
from app.services.skill_format import (
    parse_skill_md,
    generate_skill_md,
    categorize_file,
    SkillFormatError,
)
from app.services.skill_source import (
    parse_skill_source,
    fetch_skill_from_github,
    SkillSourceError,
)

router = APIRouter(prefix="/skills", tags=["skills"])

logger = logging.getLogger(__name__)


@router.post("", response_model=SkillResponse)
async def create_skill(
    skill: SkillCreate,
    current_user: User = Depends(get_current_user),
):
    """Create a new skill for the current user."""
    supabase = get_supabase_client()

    insert_data = {
        "user_id": current_user.id,
        "name": skill.name,
        "description": skill.description,
        "instructions": skill.instructions,
        "enabled": skill.enabled,
    }
    if skill.license is not None:
        insert_data["license"] = skill.license
    if skill.compatibility is not None:
        insert_data["compatibility"] = skill.compatibility
    if skill.metadata is not None:
        insert_data["metadata"] = skill.metadata

    try:
        result = supabase.table("skills").insert(insert_data).execute()
    except Exception as e:
        if "duplicate" in str(e).lower() or "unique" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A skill with this name already exists"
            )
        raise

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create skill"
        )

    return result.data[0]


@router.get("", response_model=list[SkillResponse])
async def list_skills(
    current_user: User = Depends(get_current_user),
):
    """List visible skills (own + global), ordered by created_at desc."""
    supabase = get_supabase_client()

    result = supabase.table("skills").select("*").or_(
        f"user_id.is.null,user_id.eq.{current_user.id}"
    ).order("created_at", desc=True).execute()

    return result.data or []


_NAME_RE = re.compile(r'^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
_MAX_IMPORT_SIZE = 50 * 1024 * 1024  # 50 MB
_MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB per attached file


def ingest_skill(
    supabase,
    user_id: str,
    parsed: dict,
    files: list[tuple[str, bytes]],
    source_url: str | None = None,
) -> SkillImportResult:
    """Insert one parsed skill + its attached files. Shared by all import paths.

    ``parsed`` is the output of ``parse_skill_md``; ``files`` is a list of
    ``(relative_path, content_bytes)`` already stripped of the standard
    scripts/|references/|assets/ prefixes. Never raises for the common failure
    modes — returns a ``SkillImportResult`` describing success or the error.
    """
    skill_name = parsed.get("name", "unknown")

    if not _NAME_RE.match(skill_name) or '--' in skill_name:
        return SkillImportResult(
            name=skill_name, success=False, error=f"Invalid skill name: {skill_name}",
        )

    desc = parsed.get("description", "")
    if len(desc) < 20:
        return SkillImportResult(
            name=skill_name, success=False,
            error="Description must be at least 20 characters",
        )

    instructions = parsed.get("instructions", "")
    if not instructions:
        return SkillImportResult(
            name=skill_name, success=False, error="Instructions cannot be empty",
        )

    insert_data = {
        "user_id": user_id,
        "name": skill_name,
        "description": desc,
        "instructions": instructions,
        "enabled": True,
    }
    if parsed.get("license"):
        insert_data["license"] = parsed["license"]
    if parsed.get("compatibility"):
        insert_data["compatibility"] = parsed["compatibility"]
    if parsed.get("metadata"):
        insert_data["metadata"] = parsed["metadata"]
    if source_url:
        insert_data["source_url"] = source_url

    try:
        result = supabase.table("skills").insert(insert_data).execute()
    except Exception as e:
        if "duplicate" in str(e).lower() or "unique" in str(e).lower():
            return SkillImportResult(
                name=skill_name, success=False,
                error="A skill with this name already exists",
            )
        raise

    if not result.data:
        return SkillImportResult(
            name=skill_name, success=False, error="Failed to insert skill",
        )

    skill_id = result.data[0]["id"]

    for relative, file_content in files:
        if not relative or not file_content:
            continue
        # SECURITY (C-001): the archive/source supplies these paths — never trust them.
        # Normalize and reject traversal so the storage key can't escape the caller's
        # {user_id}/{skill_id}/ prefix into another tenant's namespace.
        safe_relative = _safe_skill_relpath(relative)
        if safe_relative is None:
            logger.warning(
                "Skipping skill file with unsafe path %r for skill %s", relative, skill_id
            )
            continue
        relative = safe_relative
        file_size = len(file_content)
        if file_size > _MAX_FILE_SIZE:
            continue
        mime = mimetypes.guess_type(relative)[0] or "application/octet-stream"
        storage_path = f"{user_id}/{skill_id}/{relative}"
        try:
            supabase.storage.from_("skill-files").upload(
                storage_path, file_content,
                file_options={"content-type": mime, "upsert": "true"},
            )
            supabase.table("skill_files").upsert({
                "skill_id": skill_id,
                "user_id": user_id,
                "filename": relative,
                "storage_path": storage_path,
                "file_size": file_size,
                "mime_type": mime,
            }, on_conflict="skill_id,filename").execute()
        except Exception:
            pass  # file upload failure is non-fatal

    return SkillImportResult(name=skill_name, success=True, skill_id=skill_id)


@router.post("/import", response_model=SkillImportResponse)
async def import_skills(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Import skill(s) from a .zip file following the Agent Skills open standard.

    Supports single skill (SKILL.md at root or in a directory) and bulk
    import (multiple directories each containing a SKILL.md).
    """
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File must be a .zip archive",
        )

    content = await file.read()
    if len(content) > _MAX_IMPORT_SIZE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File exceeds 50 MB limit",
        )

    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid ZIP file",
        )

    # Find all SKILL.md files and group by containing directory
    skill_dirs: dict[str, str] = {}  # dir_prefix -> SKILL.md path in zip
    for name in zf.namelist():
        basename = name.rsplit("/", 1)[-1] if "/" in name else name
        if basename == "SKILL.md":
            # Determine the skill directory prefix
            parts = name.split("/")
            if len(parts) == 1:
                # SKILL.md at root
                skill_dirs[""] = name
            else:
                # e.g., "my-skill/SKILL.md" -> prefix "my-skill/"
                dir_prefix = "/".join(parts[:-1]) + "/"
                skill_dirs[dir_prefix] = name

    if not skill_dirs:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No SKILL.md found in the archive",
        )

    supabase = get_supabase_client()
    results: list[SkillImportResult] = []

    for dir_prefix, skill_md_path in skill_dirs.items():
        skill_name = "unknown"
        try:
            skill_md_content = zf.read(skill_md_path).decode("utf-8")
            parsed = parse_skill_md(skill_md_content)
            skill_name = parsed["name"]

            # Collect attached files (everything in this dir except SKILL.md),
            # stripping standard directory prefixes for flat storage.
            files: list[tuple[str, bytes]] = []
            for entry in zf.namelist():
                if not entry.startswith(dir_prefix) or entry == skill_md_path:
                    continue
                if entry.endswith("/"):
                    continue  # skip directories

                relative = entry[len(dir_prefix):]
                for prefix in ("scripts/", "references/", "assets/"):
                    if relative.startswith(prefix):
                        relative = relative[len(prefix):]
                        break
                if not relative:
                    continue
                files.append((relative, zf.read(entry)))

            results.append(ingest_skill(supabase, current_user.id, parsed, files))

        except SkillFormatError as e:
            results.append(SkillImportResult(
                name=skill_name, success=False, error=str(e),
            ))
        except Exception as e:
            results.append(SkillImportResult(
                name=skill_name, success=False, error=str(e),
            ))

    zf.close()

    imported = sum(1 for r in results if r.success)
    failed = sum(1 for r in results if not r.success)
    return SkillImportResponse(imported=imported, failed=failed, results=results)


@router.post("/import-from-url", response_model=SkillImportResponse)
async def import_skill_from_url(
    request: SkillImportUrlRequest,
    current_user: User = Depends(get_current_user),
):
    """Import a skill from a remote registry (skills.sh / GitHub).

    Accepts a skills.sh URL, a GitHub URL, the ``npx skills add`` command, or an
    ``owner/repo/skill`` shorthand. Resolves it to a GitHub repo, downloads the
    repo tarball, locates the matching skill folder, and runs it through the same
    ingestion pipeline as the .zip importer.
    """
    try:
        src = parse_skill_source(request.source)
    except SkillSourceError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    try:
        parsed, files, source_url = await fetch_skill_from_github(src)
    except SkillSourceError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    supabase = get_supabase_client()
    result = ingest_skill(supabase, current_user.id, parsed, files, source_url=source_url)

    return SkillImportResponse(
        imported=1 if result.success else 0,
        failed=0 if result.success else 1,
        results=[result],
    )


@router.get("/{skill_id}", response_model=SkillResponse)
async def get_skill(
    skill_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get a single skill by ID."""
    supabase = get_supabase_client()

    result = supabase.table("skills").select("*").eq(
        "id", skill_id
    ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()

    if not result or not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Skill not found"
        )

    return result.data


@router.patch("/{skill_id}", response_model=SkillResponse)
async def update_skill(
    skill_id: str,
    skill: SkillUpdate,
    current_user: User = Depends(get_current_user),
):
    """Update a skill's name, description, instructions, or enabled status.

    Only the owner can update their own skills.
    """
    supabase = get_supabase_client()

    update_data = skill.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update"
        )

    try:
        result = supabase.table("skills").update(
            update_data
        ).eq("id", skill_id).eq("user_id", current_user.id).execute()
    except Exception as e:
        if "duplicate" in str(e).lower() or "unique" in str(e).lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A skill with this name already exists"
            )
        raise

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Skill not found or access denied"
        )

    return result.data[0]


@router.delete("/{skill_id}")
async def delete_skill(
    skill_id: str,
    current_user: User = Depends(get_current_user),
):
    """Delete a skill (own only, not global).

    Global skills (user_id IS NULL) cannot be deleted by regular users.
    """
    supabase = get_supabase_client()

    # Check skill exists and is visible to user
    check = supabase.table("skills").select("id, user_id").eq(
        "id", skill_id
    ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()

    if not check or not check.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Skill not found or access denied"
        )

    # Cannot delete global skills
    if check.data["user_id"] is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot delete global skills"
        )

    # Clean up storage files before deleting skill
    files = supabase.table("skill_files").select("storage_path").eq("skill_id", skill_id).execute()
    if files.data:
        paths = [f["storage_path"] for f in files.data]
        try:
            supabase.storage.from_("skill-files").remove(paths)
        except Exception:
            pass
    # skill_files rows cascade-delete via FK

    # Delete skill (only own skills)
    supabase.table("skills").delete().eq(
        "id", skill_id
    ).eq("user_id", current_user.id).execute()

    return {"status": "deleted"}


@router.patch("/{skill_id}/share", response_model=SkillResponse)
async def share_skill(
    skill_id: str,
    share_request: SkillShareToggle,
    current_user: User = Depends(get_current_user),
):
    """Toggle skill sharing between global (shared with all) and private.

    - is_global=True: Share skill with all users (sets user_id to NULL, records shared_by)
    - is_global=False: Make skill private (sets user_id to current user, clears shared_by)
    """
    supabase = get_supabase_client()

    # Fetch skill by ID (no user filter - need to see all skills for unshare)
    skill = supabase.table("skills").select("*").eq(
        "id", skill_id
    ).maybe_single().execute()

    if not skill or not skill.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Skill not found"
        )

    if share_request.is_global:
        # Share: skill must be owned by current user
        if skill.data["user_id"] != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You can only share your own skills"
            )
        result = supabase.table("skills").update({
            "user_id": None,
            "shared_by": current_user.id,
        }).eq("id", skill_id).execute()
    else:
        # Unshare: skill must currently be global (user_id IS NULL)
        if skill.data["user_id"] is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Skill is not currently shared"
            )
        # Only the original owner can make it private again
        if skill.data.get("shared_by") != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the original owner can make this skill private"
            )
        result = supabase.table("skills").update({
            "user_id": current_user.id,
            "shared_by": None,
        }).eq("id", skill_id).is_("user_id", "null").execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update skill sharing"
        )

    return result.data[0]


@router.get("/{skill_id}/export")
async def export_skill(
    skill_id: str,
    current_user: User = Depends(get_current_user),
):
    """Export a skill as a .zip file following the Agent Skills open standard."""
    supabase = get_supabase_client()

    # Fetch skill (own + global)
    result = supabase.table("skills").select("*").eq(
        "id", skill_id
    ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()

    if not result or not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Skill not found",
        )

    skill = result.data
    skill_name = skill["name"]

    # Generate SKILL.md
    skill_md = generate_skill_md(
        name=skill_name,
        description=skill["description"],
        instructions=skill["instructions"],
        license=skill.get("license"),
        compatibility=skill.get("compatibility"),
        metadata=skill.get("metadata"),
    )

    # Fetch attached files
    files_result = supabase.table("skill_files").select("*").eq(
        "skill_id", skill_id
    ).execute()
    skill_files = files_result.data or []

    # Build ZIP in memory
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{skill_name}/SKILL.md", skill_md)

        for sf in skill_files:
            storage_path = sf["storage_path"]
            filename = sf["filename"]
            mime_type = sf.get("mime_type", "application/octet-stream")

            # Download file content from storage
            try:
                signed = supabase.storage.from_("skill-files").create_signed_url(
                    storage_path, 60
                )
                url = signed.get("signedURL") or signed.get("signedUrl", "")
                if not url:
                    continue
                async with httpx.AsyncClient() as client:
                    resp = await client.get(url)
                    resp.raise_for_status()
                    file_content = resp.content
            except Exception:
                continue

            # Categorize into standard directory
            category = categorize_file(filename, mime_type)
            zf.writestr(f"{skill_name}/{category}/{filename}", file_content)

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{skill_name}.zip"',
        },
    )


# --- Skill Files ---

@router.post("/{skill_id}/files", response_model=SkillFileResponse)
async def upload_skill_file(
    skill_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Upload a file to a skill. Overwrites existing file with same name."""
    supabase = get_supabase_client()

    # Verify skill exists and user owns it
    check = supabase.table("skills").select("id, user_id").eq(
        "id", skill_id
    ).eq("user_id", current_user.id).maybe_single().execute()

    if not check or not check.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Skill not found or access denied"
        )

    # Read file content
    content = await file.read()
    file_size = len(content)

    if file_size == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File is empty"
        )

    # 10 MB limit
    if file_size > 10 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File size exceeds 10 MB limit"
        )

    # SECURITY (C-002): the raw multipart filename is attacker-controlled — normalize
    # and reject traversal before it becomes a storage key (mirrors the import path).
    filename = _normalize_skill_path(file.filename or "untitled")
    mime_type = file.content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    storage_path = f"{current_user.id}/{skill_id}/{filename}"

    # Upload to storage (overwrite if exists)
    try:
        supabase.storage.from_("skill-files").upload(
            storage_path, content,
            file_options={"content-type": mime_type, "upsert": "true"},
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Storage upload failed: {e}"
        )

    # Upsert metadata row
    row = {
        "skill_id": skill_id,
        "user_id": current_user.id,
        "filename": filename,
        "storage_path": storage_path,
        "file_size": file_size,
        "mime_type": mime_type,
    }
    result = supabase.table("skill_files").upsert(
        row, on_conflict="skill_id,filename"
    ).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save file metadata"
        )

    return result.data[0]


@router.get("/{skill_id}/files", response_model=list[SkillFileResponse])
async def list_skill_files(
    skill_id: str,
    current_user: User = Depends(get_current_user),
):
    """List files attached to a skill."""
    supabase = get_supabase_client()

    # Verify skill visibility (own + global)
    check = supabase.table("skills").select("id").eq(
        "id", skill_id
    ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()

    if not check or not check.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Skill not found"
        )

    result = supabase.table("skill_files").select("*").eq(
        "skill_id", skill_id
    ).order("filename").execute()

    return result.data or []


SKILLKEEP_FILENAME = ".skillkeep"


def _normalize_skill_path(raw: str, *, allow_root: bool = False) -> str:
    """Strip surrounding slashes, reject traversal, empty segments, and NUL bytes.

    Treats BOTH '/' and '\\' as separators: Supabase Storage normalizes backslashes,
    so '..\\..' escapes a prefix exactly like '../..' would. Without this, a crafted
    skill file path escapes the caller's {user_id}/{skill_id}/ storage prefix into
    another tenant's namespace (findings C-001 / C-002).
    """
    if "\x00" in raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Path cannot contain NUL bytes",
        )
    cleaned = raw.replace("\\", "/").strip().strip("/")
    if not cleaned:
        if allow_root:
            return ""
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Path cannot be empty",
        )
    segments = cleaned.split("/")
    for seg in segments:
        if not seg or seg in (".", ".."):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Path cannot contain empty segments, '.', or '..'",
            )
    return "/".join(segments)


def _safe_skill_relpath(raw: str) -> str | None:
    """Non-raising variant of `_normalize_skill_path` for batch import (`ingest_skill`).

    Returns the normalized relative path, or ``None`` if it is unsafe (traversal,
    absolute, empty, or NUL byte) — the caller skips unsafe entries rather than
    aborting the whole import.
    """
    try:
        return _normalize_skill_path(raw)
    except HTTPException:
        return None


@router.patch("/{skill_id}/files/{file_id}", response_model=SkillFileResponse)
async def rename_skill_file(
    skill_id: str,
    file_id: str,
    body: SkillFileRename,
    current_user: User = Depends(get_current_user),
):
    """Rename a skill file. The new filename may include path segments, which
    moves the file to that folder."""
    supabase = get_supabase_client()

    # Verify ownership and load current row
    file_check = supabase.table("skill_files").select("*").eq(
        "id", file_id
    ).eq("skill_id", skill_id).eq("user_id", current_user.id).maybe_single().execute()

    if not file_check or not file_check.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found or access denied",
        )

    file_data = file_check.data
    old_filename = file_data["filename"]
    new_filename = _normalize_skill_path(body.filename)

    if new_filename == old_filename:
        return file_data

    # Reject collisions
    collision = supabase.table("skill_files").select("id").eq(
        "skill_id", skill_id
    ).eq("filename", new_filename).maybe_single().execute()
    if collision and collision.data:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A file named '{new_filename}' already exists in this skill",
        )

    old_storage_path = file_data["storage_path"]
    new_storage_path = f"{current_user.id}/{skill_id}/{new_filename}"

    try:
        supabase.storage.from_("skill-files").move(old_storage_path, new_storage_path)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Storage rename failed: {e}",
        )

    update = supabase.table("skill_files").update({
        "filename": new_filename,
        "storage_path": new_storage_path,
    }).eq("id", file_id).execute()

    if not update.data:
        # Best-effort rollback of the storage move
        try:
            supabase.storage.from_("skill-files").move(new_storage_path, old_storage_path)
        except Exception:
            pass
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update file metadata",
        )

    return update.data[0]


@router.post("/{skill_id}/folders", response_model=SkillFileResponse)
async def create_skill_folder(
    skill_id: str,
    body: SkillFolderCreate,
    current_user: User = Depends(get_current_user),
):
    """Create an empty folder by writing a hidden .skillkeep placeholder."""
    supabase = get_supabase_client()

    check = supabase.table("skills").select("id, user_id").eq(
        "id", skill_id
    ).eq("user_id", current_user.id).maybe_single().execute()
    if not check or not check.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Skill not found or access denied",
        )

    folder_path = _normalize_skill_path(body.path)
    placeholder = f"{folder_path}/{SKILLKEEP_FILENAME}"
    storage_path = f"{current_user.id}/{skill_id}/{placeholder}"

    # Refuse to create a folder that already contains anything (including its own placeholder)
    existing = supabase.table("skill_files").select("id").eq(
        "skill_id", skill_id
    ).like("filename", f"{folder_path}/%").limit(1).execute()
    if existing.data:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Folder already exists",
        )

    try:
        supabase.storage.from_("skill-files").upload(
            storage_path, b"",
            file_options={"content-type": "application/octet-stream", "upsert": "true"},
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Storage upload failed: {e}",
        )

    row = {
        "skill_id": skill_id,
        "user_id": current_user.id,
        "filename": placeholder,
        "storage_path": storage_path,
        "file_size": 0,
        "mime_type": "application/octet-stream",
    }
    result = supabase.table("skill_files").upsert(
        row, on_conflict="skill_id,filename"
    ).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save placeholder metadata",
        )

    return result.data[0]


@router.patch("/{skill_id}/folders")
async def rename_skill_folder(
    skill_id: str,
    body: SkillFolderRename,
    current_user: User = Depends(get_current_user),
):
    """Rename a folder by bulk-renaming every file whose filename starts with
    the old path prefix."""
    supabase = get_supabase_client()

    check = supabase.table("skills").select("id, user_id").eq(
        "id", skill_id
    ).eq("user_id", current_user.id).maybe_single().execute()
    if not check or not check.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Skill not found or access denied",
        )

    old_path = _normalize_skill_path(body.old_path)
    new_path = _normalize_skill_path(body.new_path)

    if old_path == new_path:
        return {"renamed": 0}

    old_prefix = f"{old_path}/"
    files_result = supabase.table("skill_files").select("*").eq(
        "skill_id", skill_id
    ).like("filename", f"{old_prefix}%").execute()

    files = files_result.data or []
    if not files:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Folder not found",
        )

    # Build the (file, new_filename) pairs and check for external collisions
    rename_pairs: list[tuple[dict, str]] = []
    for f in files:
        rest = f["filename"][len(old_prefix):]
        rename_pairs.append((f, f"{new_path}/{rest}"))

    new_filenames = [nf for _, nf in rename_pairs]
    original_filenames = {f["filename"] for f, _ in rename_pairs}

    if new_filenames:
        collisions = supabase.table("skill_files").select("filename").eq(
            "skill_id", skill_id
        ).in_("filename", new_filenames).execute()
        external = [
            c["filename"] for c in (collisions.data or [])
            if c["filename"] not in original_filenames
        ]
        if external:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Rename would overwrite existing file(s): {', '.join(external[:3])}",
            )

    moved: list[tuple[str, str]] = []
    try:
        for f, new_filename in rename_pairs:
            old_storage_path = f["storage_path"]
            new_storage_path = f"{current_user.id}/{skill_id}/{new_filename}"
            supabase.storage.from_("skill-files").move(old_storage_path, new_storage_path)
            moved.append((old_storage_path, new_storage_path))

            supabase.table("skill_files").update({
                "filename": new_filename,
                "storage_path": new_storage_path,
            }).eq("id", f["id"]).execute()
    except Exception as e:
        # Best-effort rollback of storage moves that already happened
        for from_path, to_path in moved:
            try:
                supabase.storage.from_("skill-files").move(to_path, from_path)
            except Exception:
                pass
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Folder rename failed: {e}",
        )

    return {"renamed": len(rename_pairs)}


@router.delete("/{skill_id}/folders")
async def delete_skill_folder(
    skill_id: str,
    path: str,
    current_user: User = Depends(get_current_user),
):
    """Delete a folder and every file inside it (including any .skillkeep)."""
    supabase = get_supabase_client()

    check = supabase.table("skills").select("id, user_id").eq(
        "id", skill_id
    ).eq("user_id", current_user.id).maybe_single().execute()
    if not check or not check.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Skill not found or access denied",
        )

    folder_path = _normalize_skill_path(path)
    prefix = f"{folder_path}/"

    files_result = supabase.table("skill_files").select("id, storage_path").eq(
        "skill_id", skill_id
    ).like("filename", f"{prefix}%").execute()

    files = files_result.data or []
    if not files:
        return {"deleted": 0}

    storage_paths = [f["storage_path"] for f in files]
    try:
        supabase.storage.from_("skill-files").remove(storage_paths)
    except Exception:
        # Storage may have already been cleaned; continue to remove DB rows
        pass

    supabase.table("skill_files").delete().eq(
        "skill_id", skill_id
    ).like("filename", f"{prefix}%").execute()

    return {"deleted": len(files)}


@router.delete("/{skill_id}/files/{file_id}")
async def delete_skill_file(
    skill_id: str,
    file_id: str,
    current_user: User = Depends(get_current_user),
):
    """Delete a file from a skill."""
    supabase = get_supabase_client()

    # Fetch file and verify ownership
    file_check = supabase.table("skill_files").select("*").eq(
        "id", file_id
    ).eq("skill_id", skill_id).eq("user_id", current_user.id).maybe_single().execute()

    if not file_check or not file_check.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found or access denied"
        )

    # Remove from storage
    try:
        supabase.storage.from_("skill-files").remove([file_check.data["storage_path"]])
    except Exception:
        pass

    # Delete metadata row
    supabase.table("skill_files").delete().eq("id", file_id).execute()

    return {"status": "deleted"}


# Set of MIME types that are safe to preview as text
_TEXT_MIME_PREFIXES = ("text/",)
_TEXT_MIME_TYPES = {
    "application/json",
    "application/javascript",
    "application/x-python",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/sql",
    "application/x-sh",
    "application/x-shellscript",
    "application/toml",
    "application/csv",
}


def _is_text_mime(mime: str) -> bool:
    for prefix in _TEXT_MIME_PREFIXES:
        if mime.startswith(prefix):
            return True
    return mime in _TEXT_MIME_TYPES


@router.get("/{skill_id}/files/{file_id}/content", response_model=SkillFileContentResponse)
async def get_skill_file_content(
    skill_id: str,
    file_id: str,
    current_user: User = Depends(get_current_user),
):
    """Get file content (text) or download URL (binary)."""
    supabase = get_supabase_client()

    # Verify skill visibility (own + global)
    skill_check = supabase.table("skills").select("id").eq(
        "id", skill_id
    ).or_(f"user_id.is.null,user_id.eq.{current_user.id}").maybe_single().execute()

    if not skill_check or not skill_check.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Skill not found"
        )

    # Fetch file metadata
    file_check = supabase.table("skill_files").select("*").eq(
        "id", file_id
    ).eq("skill_id", skill_id).maybe_single().execute()

    if not file_check or not file_check.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found"
        )

    file_data = file_check.data
    storage_path = file_data["storage_path"]
    mime_type = file_data["mime_type"]

    # Create signed download URL
    signed = supabase.storage.from_("skill-files").create_signed_url(storage_path, 3600)
    download_url = signed.get("signedURL") or signed.get("signedUrl", "")

    if not download_url:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate download URL"
        )

    content = None
    if _is_text_mime(mime_type):
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(download_url)
                resp.raise_for_status()
                content = resp.text
        except Exception:
            # Fall back to binary-style response if download fails
            pass

    return SkillFileContentResponse(
        filename=file_data["filename"],
        mime_type=mime_type,
        download_url=download_url,
        content=content,
    )
