"""Folder navigation service for ls, tree, grep, glob, and read commands."""
import fnmatch
import logging
import re
from typing import Optional
from uuid import UUID

logger = logging.getLogger(__name__)

# Constants
MAX_READ_LINES = 500  # Prevent context window overflow


def _is_valid_uuid(value: str) -> bool:
    """Check if string is a valid UUID."""
    try:
        UUID(value)
        return True
    except ValueError:
        return False


def _resolve_path(path: str, supabase=None, user_id: Optional[str] = None) -> Optional[str]:
    """
    Resolve a path string to a folder_id or None for root.

    Args:
        path: Either "root"/"" (root), a folder UUID, or an exact folder name.
        supabase: Supabase client (required to resolve a name).
        user_id: Current user's id (required to scope a name lookup).

    Returns:
        None for root, UUID string for a specific folder.

    Raises:
        ValueError: If the path is not "root"/UUID and the name matches zero or
            multiple visible folders (or no client was provided to resolve it).
    """
    if path is None:
        return None
    path = path.strip()
    if path == "" or path.lower() == "root":
        return None

    if _is_valid_uuid(path):
        return path

    # Otherwise treat it as a folder name and resolve against the user's
    # visible folders (global or own). Agents naturally refer to folders by the
    # human-readable name from the user's request, so accept that too.
    if supabase is not None and user_id is not None:
        res = _folder_visibility_filter(
            supabase.table("folders").select("id, name"), user_id
        ).ilike("name", path).execute()
        matches = res.data or []
        if len(matches) == 1:
            return matches[0]["id"]
        if not matches:
            raise ValueError(
                f"No folder named '{path}'. Use 'root', a folder UUID, or an exact folder name."
            )
        listed = ", ".join(f"{m['name']} (id: {m['id']})" for m in matches)
        raise ValueError(
            f"Multiple folders match '{path}': {listed}. Pass the specific folder UUID."
        )

    raise ValueError(f"Invalid path: '{path}'. Use 'root' or a valid folder UUID.")


def _folder_visibility_filter(query, user_id: str):
    """Apply standard folder visibility filter: global folders OR user's own folders."""
    return query.or_(f"user_id.is.null,user_id.eq.{user_id}")


def _doc_visibility_filter(query, user_id: str, supabase, folder_id: Optional[str] = None):
    """
    Apply document visibility filter based on folder ownership.

    Documents in global folders are visible to all users.
    Documents in private folders or unfiled are only visible to their owner.
    """
    if folder_id:
        # Check if the folder is global
        folder_check = supabase.table("folders").select("user_id").eq(
            "id", folder_id
        ).maybe_single().execute()
        if folder_check and folder_check.data and folder_check.data["user_id"] is None:
            # Global folder - show all documents in it
            return query
    # Private folder or unfiled - only show user's own documents
    return query.eq("user_id", user_id)


async def execute_ls(path: str, supabase, user_id: str) -> str:
    """
    List contents of a folder (folders and documents).

    Args:
        path: "root" for root level, or a folder UUID
        supabase: Supabase client
        user_id: Current user's ID for access control

    Returns:
        Formatted string listing folders and documents
    """
    try:
        folder_id = _resolve_path(path, supabase, user_id)
    except ValueError as e:
        return str(e)

    # Get folder name for display
    folder_name = "root"
    if folder_id:
        # Verify folder exists and user has access
        folder_result = _folder_visibility_filter(
            supabase.table("folders").select("id, name").eq("id", folder_id),
            user_id
        ).execute()
        if not folder_result.data:
            return f"Error: Folder not found (id: {folder_id})"
        folder_name = folder_result.data[0]["name"]

    # Query subfolders - filtered by user visibility
    if folder_id:
        folders_query = supabase.table("folders").select("id, name, user_id").eq("parent_id", folder_id)
    else:
        folders_query = supabase.table("folders").select("id, name, user_id").is_("parent_id", "null")

    folders_result = _folder_visibility_filter(folders_query, user_id).order("name").execute()
    folders = folders_result.data or []

    # Query documents - filtered by visibility
    if folder_id:
        docs_query = supabase.table("documents").select("id, filename").eq("folder_id", folder_id).eq("status", "completed")
        docs_query = _doc_visibility_filter(docs_query, user_id, supabase, folder_id)
        docs_result = docs_query.order("filename").execute()
        docs = docs_result.data or []
        is_root = False
    else:
        docs_result = supabase.table("documents").select("id, filename").is_("folder_id", "null").eq("status", "completed").eq("user_id", user_id).order("filename").execute()
        docs = docs_result.data or []
        is_root = True

    # Build output
    lines = [f"Contents of '{folder_name}':", ""]

    if folders:
        lines.append("Folders:")
        for f in folders:
            # Mark global folders (user_id is null)
            global_prefix = "[global] " if f.get("user_id") is None else ""
            lines.append(f"  {global_prefix}{f['name']}/ (id: {f['id']})")
        lines.append("")

    if docs:
        lines.append("Documents:")
        for d in docs:
            # Mark unfiled documents when listing root
            unfiled_prefix = "[unfiled] " if is_root else ""
            lines.append(f"  {unfiled_prefix}{d['filename']} (id: {d['id']})")
        lines.append("")

    if not folders and not docs:
        lines.append("(empty)")

    return "\n".join(lines).rstrip()


async def execute_tree(path: str, supabase, user_id: str, depth: int = 3, limit: int = 50) -> str:
    """
    Display folder tree with documents.

    Args:
        path: "root" for root level, or a folder UUID
        supabase: Supabase client
        user_id: Current user's ID for access control
        depth: Maximum depth to traverse (default 3)
        limit: Maximum items to display (default 50)

    Returns:
        Formatted tree string with folders and documents
    """
    try:
        folder_id = _resolve_path(path, supabase, user_id)
    except ValueError as e:
        return str(e)

    # Get start folder name
    root_name = "root"
    if folder_id:
        folder_result = _folder_visibility_filter(
            supabase.table("folders").select("id, name").eq("id", folder_id),
            user_id
        ).execute()
        if not folder_result.data:
            return f"Error: Folder not found (id: {folder_id})"
        root_name = folder_result.data[0]["name"]

    # Get folder tree via RPC - now with user_id filtering
    tree_result = supabase.rpc("get_folder_tree", {
        "start_folder_id": folder_id,
        "max_depth": depth,
        "p_user_id": user_id,
    }).execute()

    folders = tree_result.data or []

    # Build folder lookup for tree structure
    folder_map = {}
    root_folders = []

    for f in folders:
        folder_map[f["id"]] = {
            "data": f,
            "children": [],
            "docs": []
        }

    # Organize into tree structure
    for f in folders:
        if f["depth"] == 0:
            root_folders.append(f["id"])
        else:
            parent_id = f["parent_id"]
            if parent_id in folder_map:
                folder_map[parent_id]["children"].append(f["id"])

    # Get all folder IDs including start folder
    all_folder_ids = list(folder_map.keys())
    if folder_id:
        all_folder_ids.append(folder_id)

    # Query documents for all folders - respect visibility per folder
    if all_folder_ids:
        # For documents, we need to figure out which folders are global
        # Get folder user_id for each folder in the tree
        global_folder_ids = set()
        for fid, node in folder_map.items():
            if node["data"].get("user_id") is None:
                global_folder_ids.add(fid)

        # Also check if start_folder_id is global
        if folder_id:
            start_check = supabase.table("folders").select("user_id").eq("id", folder_id).maybe_single().execute()
            if start_check and start_check.data and start_check.data["user_id"] is None:
                global_folder_ids.add(folder_id)

        # Query docs in global folders (all users' docs visible)
        docs_in_folders = []
        if global_folder_ids:
            global_docs = supabase.table("documents").select(
                "id, filename, folder_id"
            ).in_("folder_id", list(global_folder_ids)).eq("status", "completed").order("filename").execute()
            docs_in_folders.extend(global_docs.data or [])

        # Query docs in private folders (only user's own docs)
        private_folder_ids = [fid for fid in all_folder_ids if fid not in global_folder_ids]
        if private_folder_ids:
            private_docs = supabase.table("documents").select(
                "id, filename, folder_id"
            ).in_("folder_id", private_folder_ids).eq("status", "completed").eq("user_id", user_id).order("filename").execute()
            docs_in_folders.extend(private_docs.data or [])

        # Assign documents to their folders
        for d in docs_in_folders:
            fid = d["folder_id"]
            if fid in folder_map:
                folder_map[fid]["docs"].append(d)

    # Also get unfiled documents for root (only user's own)
    unfiled_docs = []
    if not folder_id:
        unfiled_result = supabase.table("documents").select(
            "id, filename"
        ).is_("folder_id", "null").eq("status", "completed").eq("user_id", user_id).order("filename").execute()
        unfiled_docs = unfiled_result.data or []

    # Build tree output
    root_label = f"{root_name}/ (uuid: {folder_id})" if folder_id else f"{root_name}/"
    lines = [root_label]
    item_count = 1
    truncated = False

    def add_items(folder_ids: list, indent: int) -> bool:
        """Add folder items recursively. Returns True if truncated."""
        nonlocal item_count, truncated

        for fid in folder_ids:
            if item_count >= limit:
                truncated = True
                return True

            node = folder_map[fid]
            folder_data = node["data"]

            prefix = "  " * indent

            global_tag = "[global] " if folder_data.get("user_id") is None else ""
            lines.append(f"{prefix}{global_tag}{folder_data['name']}/ (uuid: {folder_data['id']})")
            item_count += 1

            for doc in node["docs"]:
                if item_count >= limit:
                    truncated = True
                    return True
                lines.append(f"{prefix}  {doc['filename']} (uuid: {doc['id']})")
                item_count += 1

            if node["children"]:
                if add_items(node["children"], indent + 1):
                    return True

        return False

    # Add unfiled documents first (for root)
    if unfiled_docs:
        for doc in unfiled_docs:
            if item_count >= limit:
                truncated = True
                break
            lines.append(f"  [unfiled] {doc['filename']} (uuid: {doc['id']})")
            item_count += 1

    # Add folder tree
    if not truncated:
        add_items(root_folders, 1)

    if truncated:
        lines.append("")
        lines.append(f"... (truncated at {limit} items)")

    return "\n".join(lines)


async def execute_grep(
    pattern: str,
    supabase,
    user_id: str,
    path: str = "root",
    case_sensitive: bool = False,
    max_results: int = 20
) -> str:
    """
    Search document content for regex pattern.

    Args:
        pattern: Regex pattern to search for
        supabase: Supabase client
        user_id: Current user's ID for access control
        path: "root" for all docs, or folder UUID for scoped search
        case_sensitive: Whether to match case (default: False)
        max_results: Maximum documents to return (default: 20)

    Returns:
        Formatted string with matching documents and line excerpts
    """
    # Compile regex with error handling
    try:
        flags = 0 if case_sensitive else re.IGNORECASE
        regex = re.compile(pattern, flags)
    except re.error as e:
        return f"Error: Invalid regex pattern '{pattern}': {e}"

    # Resolve path to determine scope
    try:
        folder_id = _resolve_path(path, supabase, user_id)
    except ValueError as e:
        return str(e)

    # Get folder subtree IDs if scoped to a folder
    folder_ids = None
    is_scoped_to_global = False
    if folder_id:
        # Check if scoped folder is global
        folder_check = supabase.table("folders").select("user_id").eq("id", folder_id).maybe_single().execute()
        if folder_check and folder_check.data and folder_check.data["user_id"] is None:
            is_scoped_to_global = True

        # Get all folders under this folder using get_folder_tree RPC (with user filter)
        tree_result = supabase.rpc("get_folder_tree", {
            "start_folder_id": folder_id,
            "max_depth": 10,
            "p_user_id": user_id,
        }).execute()

        folders = tree_result.data or []
        folder_ids = [folder_id]
        folder_ids.extend([f["id"] for f in folders])

    # Query documents with full_markdown
    query = supabase.table("documents").select(
        "id, filename, folder_id, full_markdown"
    ).eq("status", "completed").not_.is_("full_markdown", "null")

    if folder_ids:
        query = query.in_("folder_id", folder_ids)
        if not is_scoped_to_global:
            # Private folder scope - only user's docs
            query = query.eq("user_id", user_id)
        # If global folder scope, show all docs
    else:
        # Root scope - only user's own docs + docs in global folders
        # We need two queries: user's own docs + docs in global folders
        pass

    if not folder_ids:
        # Root scope: get user's own docs
        user_docs_result = supabase.table("documents").select(
            "id, filename, folder_id, full_markdown"
        ).eq("status", "completed").not_.is_("full_markdown", "null").eq("user_id", user_id).execute()
        user_docs = user_docs_result.data or []

        # Also get docs in global folders (any user's docs)
        global_folders_result = supabase.table("folders").select("id").is_("user_id", "null").execute()
        global_folder_ids = [f["id"] for f in (global_folders_result.data or [])]

        global_docs = []
        if global_folder_ids:
            global_docs_result = supabase.table("documents").select(
                "id, filename, folder_id, full_markdown"
            ).eq("status", "completed").not_.is_("full_markdown", "null").in_("folder_id", global_folder_ids).execute()
            global_docs = global_docs_result.data or []

        # Deduplicate (user's own docs in global folders would appear in both)
        seen_ids = set()
        docs = []
        for d in user_docs + global_docs:
            if d["id"] not in seen_ids:
                seen_ids.add(d["id"])
                docs.append(d)
    else:
        docs_result = query.execute()
        docs = docs_result.data or []

    # Search each document
    matches = []
    for doc in docs:
        full_markdown = doc.get("full_markdown", "")
        if not full_markdown:
            continue

        lines = full_markdown.split("\n")
        matching_lines = []

        for line_num, line in enumerate(lines, start=1):
            if regex.search(line):
                excerpt = line[:200] + "..." if len(line) > 200 else line
                matching_lines.append((line_num, excerpt.strip()))
                if len(matching_lines) >= 5:
                    break

        if matching_lines:
            matches.append({
                "id": doc["id"],
                "filename": doc["filename"],
                "lines": matching_lines
            })

            if len(matches) >= max_results:
                break

    # Format output
    if not matches:
        return f"No documents found matching '{pattern}'."

    output_lines = [f"Found {len(matches)} document(s) matching '{pattern}':", ""]

    for match in matches:
        output_lines.append(f"**{match['filename']}** (id: {match['id']})")
        for line_num, excerpt in match["lines"]:
            output_lines.append(f"  Line {line_num}: {excerpt}")
        output_lines.append("")

    return "\n".join(output_lines).rstrip()


async def execute_glob(
    pattern: str,
    supabase,
    user_id: str,
    max_results: int = 50
) -> str:
    """
    Find documents by filename pattern.

    Args:
        pattern: Filename pattern with wildcards (*, ?, [seq], **)
        supabase: Supabase client
        user_id: Current user's ID for access control
        max_results: Maximum documents to return (default: 50)

    Returns:
        Formatted string with matching documents grouped by folder
    """
    # Query user's own completed documents
    user_docs_result = supabase.table("documents").select(
        "id, filename, folder_id"
    ).eq("status", "completed").eq("user_id", user_id).execute()
    user_docs = user_docs_result.data or []

    # Query docs in global folders (any user's docs)
    global_folders_result = supabase.table("folders").select("id").is_("user_id", "null").execute()
    global_folder_ids = [f["id"] for f in (global_folders_result.data or [])]

    global_docs = []
    if global_folder_ids:
        global_docs_result = supabase.table("documents").select(
            "id, filename, folder_id"
        ).eq("status", "completed").in_("folder_id", global_folder_ids).execute()
        global_docs = global_docs_result.data or []

    # Deduplicate
    seen_ids = set()
    docs = []
    for d in user_docs + global_docs:
        if d["id"] not in seen_ids:
            seen_ids.add(d["id"])
            docs.append(d)

    # Query visible folders for path building
    folders_result = _folder_visibility_filter(
        supabase.table("folders").select("id, name, parent_id, user_id"),
        user_id
    ).execute()
    folders = folders_result.data or []

    # Build folder lookup: id -> {name, parent_id}
    folder_lookup = {f["id"]: f for f in folders}

    def build_folder_path(folder_id: str) -> str:
        """Build full folder path from folder_id by traversing parent chain."""
        if not folder_id:
            return "[knowledgebase]"

        parts = []
        current_id = folder_id
        visited = set()

        while current_id and current_id not in visited:
            visited.add(current_id)
            folder = folder_lookup.get(current_id)
            if not folder:
                break
            parts.append(folder["name"])
            current_id = folder.get("parent_id")

        if not parts:
            return "[knowledgebase]"

        return "/".join(reversed(parts))

    def matches_pattern(doc_path: str, filename: str, pattern: str) -> bool:
        """Check if document matches glob pattern."""
        pattern_lower = pattern.lower()
        filename_lower = filename.lower()
        full_path_lower = f"{doc_path}/{filename}".lower() if doc_path != "[knowledgebase]" else filename_lower

        if "**" in pattern:
            if "**/" in pattern_lower:
                _, file_pattern = pattern_lower.rsplit("**/", 1)
                return fnmatch.fnmatch(filename_lower, file_pattern)
            else:
                file_pattern = pattern_lower.replace("**", "")
                if file_pattern.startswith("/"):
                    file_pattern = file_pattern[1:]
                return fnmatch.fnmatch(filename_lower, file_pattern) if file_pattern else True

        if "/" in pattern:
            folder_pattern, file_pattern = pattern_lower.rsplit("/", 1)
            path_lower = doc_path.lower()
            return (fnmatch.fnmatch(path_lower, folder_pattern) and
                    fnmatch.fnmatch(filename_lower, file_pattern))

        return fnmatch.fnmatch(filename_lower, pattern_lower)

    # Find matching documents
    matches = []
    for doc in docs:
        folder_path = build_folder_path(doc.get("folder_id"))
        filename = doc["filename"]

        if matches_pattern(folder_path, filename, pattern):
            matches.append({
                "id": doc["id"],
                "filename": filename,
                "folder_path": folder_path
            })

            if len(matches) >= max_results:
                break

    # Format output
    if not matches:
        return f"No documents found matching '{pattern}'."

    # Group by folder path
    by_folder: dict[str, list] = {}
    for match in matches:
        path = match["folder_path"]
        if path not in by_folder:
            by_folder[path] = []
        by_folder[path].append(match)

    output_lines = [f"Found {len(matches)} document(s) matching '{pattern}':", ""]

    sorted_paths = sorted(by_folder.keys(), key=lambda p: (p == "[knowledgebase]", p))

    for folder_path in sorted_paths:
        output_lines.append(f"{folder_path}/")
        for match in by_folder[folder_path]:
            output_lines.append(f"  {match['filename']} (id: {match['id']})")
        output_lines.append("")

    return "\n".join(output_lines).rstrip()


async def execute_read(
    document_id: str,
    supabase,
    user_id: str,
    start_line: Optional[int] = None,
    end_line: Optional[int] = None,
) -> str:
    """
    Read document content (full or line range).

    Args:
        document_id: UUID of the document to read
        supabase: Supabase client
        user_id: Current user's ID for access control
        start_line: First line to read (1-indexed, optional)
        end_line: Last line to read (inclusive, optional)

    Returns:
        Formatted string with document content and line numbers
    """
    # Validate document_id format
    if not _is_valid_uuid(document_id):
        return f"Error: Invalid document ID '{document_id}'. Must be a valid UUID."

    # Fetch document - check ownership OR in global folder
    result = supabase.table("documents").select(
        "id, filename, full_markdown, user_id, folder_id"
    ).eq("id", document_id).eq("status", "completed").maybe_single().execute()

    if not result or not result.data:
        return f"Error: Document not found or access denied (id: {document_id})"

    doc = result.data

    # Access check: user owns the doc, OR doc is in a global folder
    if doc["user_id"] != user_id:
        # Check if document is in a global folder
        folder_id = doc.get("folder_id")
        if folder_id:
            folder_check = supabase.table("folders").select("user_id").eq(
                "id", folder_id
            ).maybe_single().execute()
            if not (folder_check and folder_check.data and folder_check.data["user_id"] is None):
                return f"Error: Document not found or access denied (id: {document_id})"
        else:
            # Unfiled doc owned by someone else
            return f"Error: Document not found or access denied (id: {document_id})"

    full_markdown = doc.get("full_markdown")

    if not full_markdown:
        return f"Error: Document content not available. Document '{doc['filename']}' may need re-ingestion."

    # Split into lines
    lines = full_markdown.split("\n")
    total_lines = len(lines)

    # Validate and apply line range
    if start_line is None and end_line is None:
        actual_start = 1
        actual_end = min(total_lines, MAX_READ_LINES)
        truncated = total_lines > MAX_READ_LINES
    else:
        if start_line is not None and start_line < 1:
            return f"Error: start_line must be >= 1 (got {start_line})"
        if end_line is not None and end_line < 1:
            return f"Error: end_line must be >= 1 (got {end_line})"
        if start_line is not None and end_line is not None and start_line > end_line:
            return f"Error: start_line ({start_line}) cannot be greater than end_line ({end_line})"

        actual_start = start_line if start_line else 1
        actual_end = end_line if end_line else total_lines

        if actual_start > total_lines:
            return f"Error: start_line ({actual_start}) exceeds document length ({total_lines} lines)"

        actual_end = min(actual_end, total_lines)

        requested_lines = actual_end - actual_start + 1
        if requested_lines > MAX_READ_LINES:
            actual_end = actual_start + MAX_READ_LINES - 1
            truncated = True
        else:
            truncated = False

    # Extract requested lines (convert to 0-indexed)
    selected_lines = lines[actual_start - 1 : actual_end]

    # Format output
    if actual_start == 1 and actual_end == total_lines and not truncated:
        header = f"**Document: {doc['filename']}** ({total_lines} lines)"
    else:
        header = f"**Document: {doc['filename']}** (lines {actual_start}-{actual_end} of {total_lines})"

    width = len(str(actual_end))

    output_lines = [header, ""]
    for i, line in enumerate(selected_lines, start=actual_start):
        output_lines.append(f"{i:>{width}}: {line}")

    if truncated:
        output_lines.append("")
        output_lines.append(f"... (truncated at {MAX_READ_LINES} lines, use line range to read more)")

    return "\n".join(output_lines)
