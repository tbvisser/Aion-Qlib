"""Sandbox code execution service."""
import asyncio
import base64
import logging
import os
import re
import tempfile
import time
import mimetypes
from typing import AsyncGenerator, Any

from app.config import get_settings
from app.db.supabase import get_supabase_client
from app.services.sandbox_session_manager import get_session_manager
from app.services.sandbox_security import get_python_security_policy
from app.services.langsmith import traceable

logger = logging.getLogger(__name__)

# MIME type map for common generated file extensions
MIME_TYPES = {
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".csv": "text/csv",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".pdf": "application/pdf",
    ".html": "text/html",
    ".txt": "text/plain",
    ".zip": "application/zip",
    ".svg": "image/svg+xml",
}


def _get_content_type(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    return MIME_TYPES.get(ext, mimetypes.guess_type(filename)[0] or "application/octet-stream")


@traceable(name="execute_code_sandbox", run_type="tool")
async def run_code_execution(
    code: str,
    thread_id: str,
    user_id: str,
    libraries: list[str] | None = None,
    output_filenames: list[str] | None = None,
) -> AsyncGenerator[dict[str, Any], None]:
    """Execute code in a sandboxed container and yield SSE events."""
    settings = get_settings()

    if not settings.sandbox_enabled:
        yield {
            "type": "code_execution_error",
            "execution_id": "",
            "error": "Code execution is not enabled. Set SANDBOX_ENABLED=true to activate.",
        }
        return

    supabase = get_supabase_client()

    # Insert execution record
    exec_result = supabase.table("code_executions").insert({
        "user_id": user_id,
        "thread_id": thread_id,
        "language": "python",
        "code": code,
        "status": "running",
        "libraries": libraries or [],
    }).execute()

    execution_id = exec_result.data[0]["id"] if exec_result.data else "unknown"

    # Yield start event
    code_preview = code[:200] + ("..." if len(code) > 200 else "")
    yield {
        "type": "code_execution_start",
        "execution_id": execution_id,
        "language": "python",
        "code_preview": code_preview,
    }

    start_time = time.time()

    try:
        # Get or create session
        manager = get_session_manager()
        managed = await manager.get_or_create_session(thread_id, user_id)
        session = managed.session

        # Create output directory (and any subdirectories for nested filenames) inside container.
        # Create dirs in both /sandbox/output/ and /sandbox/ (working dir) since
        # LLM-generated code may use relative paths from /sandbox/.
        loop = asyncio.get_running_loop()
        mkdir_cmds = ["mkdir -p /sandbox/output"]
        if output_filenames:
            subdirs = set()
            for fn in output_filenames:
                fn_clean = fn.replace("\\", "/").strip("/")
                parent = os.path.dirname(fn_clean)
                if parent and ".." not in parent.split("/"):
                    subdirs.add(parent)
            for d in sorted(subdirs):
                mkdir_cmds.append(f"mkdir -p /sandbox/output/{d}")
                mkdir_cmds.append(f"mkdir -p /sandbox/{d}")
        try:
            await loop.run_in_executor(
                None, session.execute_command, " && ".join(mkdir_cmds)
            )
        except Exception:
            pass  # Directory may already exist

        # Inject tool stubs if bridge is available
        if settings.tool_registry_enabled and managed.session_token:
            try:
                from app.services.stub_generator import generate_bridge_client, generate_stubs
                from app.services.tool_registry import get_tool_registry

                registry = get_tool_registry()
                # Write bridge client using Python to avoid shell escaping issues
                client_code = generate_bridge_client()
                client_b64 = base64.b64encode(client_code.encode("utf-8")).decode("ascii")
                write_client_py = (
                    f"import base64, pathlib; "
                    f"pathlib.Path('/sandbox/bridge_client.py').write_text("
                    f"base64.b64decode('{client_b64}').decode('utf-8'))"
                )
                await loop.run_in_executor(None, session.run, write_client_py)

                # Generate and write typed stubs only for bridge-allowlisted tools
                # (SECURITY D-001): don't hand the sandbox stubs for execute_code /
                # save_skill / write_* / task that POST /bridge/call would reject.
                allowlist = set(settings.sandbox_bridge_tool_allowlist)
                all_schemas = [
                    t.openai_schema for t in registry._tools.values()
                    if t.openai_schema and t.name in allowlist
                ]
                if all_schemas:
                    stubs_code = generate_stubs(all_schemas)
                    stubs_b64 = base64.b64encode(stubs_code.encode("utf-8")).decode("ascii")
                    write_stubs_py = (
                        f"import base64, pathlib; "
                        f"pathlib.Path('/sandbox/tools.py').write_text("
                        f"base64.b64decode('{stubs_b64}').decode('utf-8'))"
                    )
                    await loop.run_in_executor(None, session.run, write_stubs_py)

                # Verify files were written
                verify_result = await loop.run_in_executor(
                    None, session.run,
                    "import os; print('bridge_client.py:', os.path.exists('/sandbox/bridge_client.py'), "
                    "'tools.py:', os.path.exists('/sandbox/tools.py'))"
                )
                verify_out = getattr(verify_result, 'stdout', str(verify_result)) or ''
                logger.info(f"Injected bridge client and {len(all_schemas)} tool stubs into sandbox. Verify: {verify_out.strip()}")
            except Exception as e:
                logger.warning(f"Failed to inject bridge stubs: {e}", exc_info=True)

        # Inject workspace files into sandbox
        try:
            import io
            import tarfile
            from app.services.workspace_service import list_files as ws_list_files, read_file as ws_read_file

            ws_files = await ws_list_files(thread_id, user_id)
            if ws_files:
                # Size guards
                MAX_FILES = 20
                MAX_TOTAL_BYTES = 50 * 1024 * 1024  # 50MB
                MAX_FILE_BYTES = 5 * 1024 * 1024  # 5MB per file

                if len(ws_files) > MAX_FILES:
                    logger.warning(f"[SANDBOX] Workspace has {len(ws_files)} files, limiting to {MAX_FILES}")
                    ws_files = sorted(ws_files, key=lambda f: f.get("updated_at", ""), reverse=True)[:MAX_FILES]

                total_size = sum(f.get("size_bytes", 0) for f in ws_files)
                if total_size > MAX_TOTAL_BYTES:
                    logger.warning(f"[SANDBOX] Workspace injection skipped: {len(ws_files)} files totaling {total_size / 1024 / 1024:.1f}MB exceeds 50MB limit")
                else:
                    # Create workspace directory
                    try:
                        await loop.run_in_executor(None, session.execute_command, "mkdir -p /sandbox/workspace")
                    except Exception:
                        pass

                    text_count = 0
                    binary_count = 0
                    for ws_file in ws_files:
                        file_path = ws_file.get("file_path", "")
                        storage_path = ws_file.get("storage_path")
                        file_size = ws_file.get("size_bytes", 0)

                        # Sanitize file_path: reject traversal, backslashes, special chars
                        if not file_path or ".." in file_path or "\\" in file_path or "'" in file_path or '"' in file_path:
                            logger.warning(f"[SANDBOX] Rejected unsafe workspace file path: {file_path!r}")
                            continue
                        if file_size > MAX_FILE_BYTES:
                            logger.warning(f"[SANDBOX] Skipping {file_path}: {file_size / 1024 / 1024:.1f}MB exceeds 5MB per-file limit")
                            continue

                        try:
                            if not storage_path:
                                # Text file — inject via tar archive (safe, no shell interpolation)
                                content = await ws_read_file(thread_id, file_path, user_id)
                                file_bytes = content.encode("utf-8")
                                tar_buffer = io.BytesIO()
                                with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
                                    info = tarfile.TarInfo(name=file_path)
                                    info.size = len(file_bytes)
                                    tar.addfile(info, io.BytesIO(file_bytes))
                                tar_buffer.seek(0)

                                container = session._container if hasattr(session, '_container') else None
                                if container:
                                    await loop.run_in_executor(
                                        None, container.put_archive, "/sandbox/workspace", tar_buffer.getvalue()
                                    )
                                else:
                                    # Fallback: use base64 with sanitized path
                                    content_b64 = base64.b64encode(file_bytes).decode("ascii")
                                    # Use repr() for safe string embedding
                                    safe_path = repr(f"/sandbox/workspace/{file_path}")
                                    write_py = (
                                        f"import base64, pathlib, os; "
                                        f"p = pathlib.Path({safe_path}); "
                                        f"os.makedirs(str(p.parent), exist_ok=True); "
                                        f"p.write_bytes(base64.b64decode('{content_b64}'))"
                                    )
                                    await loop.run_in_executor(None, session.run, write_py)
                                text_count += 1
                            else:
                                # Binary file — download and inject via put_archive
                                file_bytes = supabase.storage.from_("workspace-files").download(storage_path)
                                tar_buffer = io.BytesIO()
                                with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
                                    info = tarfile.TarInfo(name=file_path)
                                    info.size = len(file_bytes)
                                    tar.addfile(info, io.BytesIO(file_bytes))
                                tar_buffer.seek(0)

                                container = session._container if hasattr(session, '_container') else None
                                if container:
                                    await loop.run_in_executor(
                                        None, container.put_archive, "/sandbox/workspace", tar_buffer.getvalue()
                                    )
                                else:
                                    # Fallback: use base64 with sanitized path
                                    content_b64 = base64.b64encode(file_bytes).decode("ascii")
                                    safe_path = repr(f"/sandbox/workspace/{file_path}")
                                    write_py = (
                                        f"import base64, pathlib, os; "
                                        f"p = pathlib.Path({safe_path}); "
                                        f"os.makedirs(str(p.parent), exist_ok=True); "
                                        f"p.write_bytes(base64.b64decode('{content_b64}'))"
                                    )
                                    await loop.run_in_executor(None, session.run, write_py)
                                binary_count += 1
                        except Exception as e:
                            logger.warning(f"[SANDBOX] Failed to inject workspace file {file_path}: {e}")

                    if text_count + binary_count > 0:
                        logger.info(f"[SANDBOX] Injected {text_count + binary_count} workspace files ({text_count} text, {binary_count} binary) into sandbox")
        except Exception as e:
            logger.warning(f"[SANDBOX] Workspace file injection failed: {e}")

        # Install libraries if needed
        if libraries:
            for lib in libraries:
                try:
                    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.\-\[\]]*([<>=!~][=]?[a-zA-Z0-9._*\-]+)*', lib):
                        logger.warning(f"Rejected invalid library name: {lib}")
                        yield {
                            "type": "code_stderr",
                            "content": f"Warning: Rejected invalid library name: {lib}\n",
                        }
                        continue
                    install_cmd = f"pip install -q -- {lib}"
                    await loop.run_in_executor(
                        None, session.execute_command, install_cmd
                    )
                    logger.info(f"Installed library: {lib}")
                except Exception as e:
                    logger.warning(f"Failed to install {lib}: {e}")
                    yield {
                        "type": "code_stderr",
                        "content": f"Warning: Failed to install {lib}: {e}\n",
                    }

        # Prepend PYTHONPATH setup for bridge access
        if settings.tool_registry_enabled and managed.session_token:
            preamble = "import sys; sys.path.insert(0, '/sandbox'); sys.path.insert(0, '/usr/lib/python3')\n"
            code = preamble + code

        # Security policy: explicitly reject code that violates the sandbox policy
        # BEFORE running it. llm-sandbox attaches the policy to the session but does
        # NOT auto-enforce it on run(), so without this check dangerous calls
        # (subprocess, os.system, eval/exec, ctypes, …) would execute. This is the
        # sandbox-layer defense behind the model-level refusal.
        is_safe, violations = await loop.run_in_executor(None, session.is_safe, code)
        if not is_safe:
            reasons = "; ".join(
                getattr(v, "description", None) or getattr(v, "pattern", None) or str(v)
                for v in violations
            ) or "violates the sandbox security policy"
            msg = f"Code blocked by sandbox security policy: {reasons}"
            logger.warning(f"[SANDBOX] {msg}")
            try:
                supabase.table("code_executions").update({
                    "status": "blocked",
                    "error_message": msg[:5000],
                    "execution_time_ms": int((time.time() - start_time) * 1000),
                }).eq("id", execution_id).execute()
            except Exception:
                pass
            yield {
                "type": "code_execution_error",
                "execution_id": execution_id,
                "error": msg,
            }
            return

        # Execute the code
        result = await loop.run_in_executor(None, session.run, code)

        stdout = (result.stdout if result.stdout is not None else "") if hasattr(result, 'stdout') else (str(result) if result else "")
        stderr = (result.stderr if result.stderr is not None else "") if hasattr(result, 'stderr') else ""
        exit_code = result.exit_code if hasattr(result, 'exit_code') else 0

        # Stream stdout/stderr
        if stdout:
            yield {"type": "code_stdout", "content": stdout}
        if stderr:
            yield {"type": "code_stderr", "content": stderr}

        execution_time_ms = int((time.time() - start_time) * 1000)

        # Handle output files — auto-discover from /sandbox/output/ and merge
        # with any LLM-declared filenames (which may be flat/incorrect).
        files_info = []

        # Auto-discover files actually present in /sandbox/output/ (recursive)
        discovered_filenames = set()
        try:
            discover_code = (
                "import os\n"
                "base = '/sandbox/output'\n"
                "for root, dirs, files in os.walk(base):\n"
                "    for f in files:\n"
                "        full = os.path.join(root, f)\n"
                "        rel = os.path.relpath(full, base)\n"
                "        print(rel)\n"
            )
            find_result = await loop.run_in_executor(None, session.run, discover_code)
            found_output = getattr(find_result, 'stdout', str(find_result)) or ''
            for line in found_output.strip().splitlines():
                line = line.strip().replace("\\", "/")
                if line and ".." not in line:
                    discovered_filenames.add(line)
        except Exception as e:
            logger.debug(f"Auto-discover output files failed: {e}")

        # Build final file list: discovered files take priority.
        # Only include declared filenames that aren't already covered
        # by a discovered file with the same basename in a subdirectory.
        discovered_basenames = {os.path.basename(f) for f in discovered_filenames}
        all_filenames = set(discovered_filenames)
        if output_filenames:
            for fn in output_filenames:
                fn_clean = fn.replace("\\", "/").strip("/")
                # Skip flat names whose basename already exists in a discovered nested path
                if "/" not in fn_clean and fn_clean in discovered_basenames:
                    continue
                # Skip if already discovered at this exact path
                if fn_clean in discovered_filenames:
                    continue
                all_filenames.add(fn_clean)

        for filename in sorted(all_filenames):
                # Sanitize: normalize path, block traversal, strip leading slashes
                filename = filename.replace("\\", "/").strip("/")
                if not filename or ".." in filename.split("/"):
                    logger.warning(f"Rejected suspicious output filename: {filename}")
                    continue
                container_path = f"/sandbox/output/{filename}"
                # Fallback: code may write to /sandbox/ (working dir) instead of /sandbox/output/
                fallback_path = f"/sandbox/{filename}"
                try:
                    # Copy file from container to temp file
                    with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(filename)[1]) as tmp:
                        tmp_path = tmp.name

                    try:
                        await loop.run_in_executor(
                            None, session.copy_from_runtime, container_path, tmp_path
                        )
                    except Exception:
                        # Try fallback path (working directory)
                        await loop.run_in_executor(
                            None, session.copy_from_runtime, fallback_path, tmp_path
                        )

                    # Get file size
                    file_size = os.path.getsize(tmp_path)
                    content_type = _get_content_type(filename)

                    # Upload to Supabase Storage
                    storage_path = f"{user_id}/{thread_id}/{filename}"
                    with open(tmp_path, "rb") as f:
                        file_data = f.read()

                    supabase.storage.from_("workspace-files").upload(
                        storage_path,
                        file_data,
                        {"content-type": content_type, "upsert": "true"},
                    )

                    # Create signed URL (1 hour expiry)
                    signed = supabase.storage.from_("workspace-files").create_signed_url(
                        storage_path, 3600
                    )
                    download_url = signed.get("signedURL", "") if isinstance(signed, dict) else ""

                    # Record in workspace_files
                    supabase.table("workspace_files").upsert({
                        "thread_id": thread_id,
                        "file_path": filename,
                        "content": None,
                        "storage_path": storage_path,
                        "content_type": content_type,
                        "source": "sandbox",
                        "execution_id": execution_id,
                        "size_bytes": file_size,
                    }, on_conflict="thread_id,file_path").execute()

                    files_info.append({
                        "filename": filename,
                        "download_url": download_url,
                        "file_size": file_size,
                        "content_type": content_type,
                    })

                except Exception as e:
                    logger.warning(f"Failed to retrieve output file {filename}: {e}")
                    files_info.append({
                        "filename": filename,
                        "download_url": "",
                        "file_size": 0,
                        "content_type": "",
                        "error": str(e),
                    })
                finally:
                    # Clean up temp file
                    try:
                        if 'tmp_path' in locals():
                            os.unlink(tmp_path)
                    except Exception:
                        pass

        # Update execution record
        supabase.table("code_executions").update({
            "stdout": stdout[:50000] if stdout else None,
            "stderr": stderr[:50000] if stderr else None,
            "exit_code": exit_code,
            "execution_time_ms": execution_time_ms,
            "status": "completed",
        }).eq("id", execution_id).execute()

        # Yield completion event
        yield {
            "type": "code_execution_complete",
            "execution_id": execution_id,
            "exit_code": exit_code,
            "execution_time_ms": execution_time_ms,
            "stdout": stdout,
            "stderr": stderr,
            "files": files_info,
        }

    except Exception as e:
        execution_time_ms = int((time.time() - start_time) * 1000)
        error_msg = str(e)
        logger.error(f"Code execution failed: {error_msg}")

        # Update execution record with failure
        try:
            supabase.table("code_executions").update({
                "status": "failed",
                "error_message": error_msg[:5000],
                "execution_time_ms": execution_time_ms,
            }).eq("id", execution_id).execute()
        except Exception:
            pass

        yield {
            "type": "code_execution_error",
            "execution_id": execution_id,
            "error": error_msg,
        }
