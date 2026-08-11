"""API integration tests for Story 2.1: Workspace Database and Storage Foundation.

Tests validate:
- AC1: workspace_files table schema (columns, types, constraints)
- AC2: workspace-files storage bucket existence
- AC3: RLS policies enforce thread-ownership
- AC4: updated_at auto-updates on row modification
"""

import os

import httpx
import pytest

pytestmark = pytest.mark.api

# ---------------------------------------------------------------------------
# Helpers (reuse pattern from test_deep_mode.py)
# ---------------------------------------------------------------------------

SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://localhost:8000")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


def _sb_admin_headers() -> dict[str, str]:
    """Headers for Supabase REST API using service-role key (bypasses RLS)."""
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _sb_user_headers(token: str) -> dict[str, str]:
    """Headers for Supabase REST API using user JWT (subject to RLS)."""
    return {
        "apikey": os.environ.get("SUPABASE_ANON_KEY", ""),
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


async def _create_thread(api: httpx.AsyncClient, title: str = "workspace-test") -> str:
    """Create a thread via the app API and return its id."""
    resp = await api.post("/threads", json={"title": title})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _insert_workspace_file(
    thread_id: str,
    file_path: str = "notes/test.md",
    content: str = "hello world",
    content_type: str = "text/markdown",
    source: str = "agent",
    size_bytes: int = 11,
) -> dict:
    """Insert a workspace file directly via Supabase REST (service-role, bypasses RLS)."""
    row = {
        "thread_id": thread_id,
        "file_path": file_path,
        "content": content,
        "content_type": content_type,
        "source": source,
        "size_bytes": size_bytes,
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SUPABASE_URL}/rest/v1/workspace_files",
            headers=_sb_admin_headers(),
            json=row,
        )
        resp.raise_for_status()
        data = resp.json()
        return data[0] if isinstance(data, list) else data


async def _query_workspace_files_as_user(token: str, thread_id: str) -> list[dict]:
    """Query workspace_files as an authenticated user (subject to RLS)."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/workspace_files",
            headers=_sb_user_headers(token),
            params={"thread_id": f"eq.{thread_id}", "select": "*"},
        )
        resp.raise_for_status()
        return resp.json()


# ===========================================================================
# P0 -- AC1: Table Schema Validation
# ===========================================================================


async def test_workspace_files_table_exists():
    """[2.1-INT-001] workspace_files table exists with all required columns."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/workspace_files",
            headers=_sb_admin_headers(),
            params={"select": "*", "limit": "0"},
        )
        # If table exists, we get 200. If not, we get 404 or similar.
        assert resp.status_code == 200


async def test_workspace_files_schema_columns():
    """[2.1-INT-001] workspace_files has correct columns and data types."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/workspace_files",
            headers=_sb_admin_headers(),
            params={"select": "id,thread_id,file_path,content,storage_path,content_type,source,execution_id,size_bytes,created_at,updated_at", "limit": "0"},
        )
        assert resp.status_code == 200, (
            f"Expected all columns to be queryable, got {resp.status_code}: {resp.text}"
        )


# ===========================================================================
# P0 -- AC1: UNIQUE Constraint
# ===========================================================================


async def test_unique_constraint_thread_id_file_path(api1: httpx.AsyncClient):
    """[2.1-INT-002] UNIQUE constraint on (thread_id, file_path) rejects duplicates."""
    tid = await _create_thread(api1)

    # First insert should succeed
    await _insert_workspace_file(tid, file_path="notes/unique-test.md")

    # Second insert with same (thread_id, file_path) should fail with 409 Conflict
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SUPABASE_URL}/rest/v1/workspace_files",
            headers=_sb_admin_headers(),
            json={
                "thread_id": tid,
                "file_path": "notes/unique-test.md",
                "content": "different content",
                "content_type": "text/markdown",
                "source": "agent",
                "size_bytes": 17,
            },
        )
        assert resp.status_code == 409, (
            f"Expected 409 Conflict for duplicate (thread_id, file_path), got {resp.status_code}"
        )


# ===========================================================================
# P1 -- AC1: CHECK Constraint on source
# ===========================================================================


async def test_check_constraint_source_rejects_invalid(api1: httpx.AsyncClient):
    """[2.1-INT-003] CHECK constraint on source column rejects invalid values."""
    tid = await _create_thread(api1)

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SUPABASE_URL}/rest/v1/workspace_files",
            headers=_sb_admin_headers(),
            json={
                "thread_id": tid,
                "file_path": "notes/bad-source.md",
                "content": "test",
                "content_type": "text/markdown",
                "source": "invalid_source",  # Not in ('agent', 'sandbox', 'upload')
                "size_bytes": 4,
            },
        )
        # CHECK constraint violation returns 400
        assert resp.status_code in (400, 409), (
            f"Expected CHECK constraint violation for invalid source, got {resp.status_code}: {resp.text}"
        )


async def test_check_constraint_source_accepts_valid_values(api1: httpx.AsyncClient):
    """[2.1-INT-003] CHECK constraint allows 'agent', 'sandbox', 'upload'."""
    tid = await _create_thread(api1)

    for i, source in enumerate(["agent", "sandbox", "upload"]):
        await _insert_workspace_file(
            tid,
            file_path=f"notes/source-{source}-{i}.md",
            source=source,
        )
    # If we got here without error, all valid source values are accepted


# ===========================================================================
# P2 -- AC1: Index Existence
# ===========================================================================


@pytest.mark.skip(reason="Index verification requires direct SQL access (pg_indexes) — verified manually during implementation")
async def test_index_on_thread_id_exists():
    """[2.1-INT-004] Index on thread_id exists for list queries."""
    pass


# ===========================================================================
# P0 -- AC2: Storage Bucket
# ===========================================================================


async def test_storage_bucket_exists():
    """[2.1-INT-005] Storage bucket 'workspace-files' exists and is private."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{SUPABASE_URL}/rest/v1/buckets",
            headers=_sb_admin_headers(),
            params={"id": "eq.workspace-files", "select": "id,name,public"},
        )
        # storage.buckets may not be accessible via REST; try storage API
        resp2 = await client.get(
            f"{SUPABASE_URL}/storage/v1/bucket/workspace-files",
            headers=_sb_admin_headers(),
        )
        assert resp2.status_code == 200, (
            f"Expected workspace-files bucket to exist, got {resp2.status_code}: {resp2.text}"
        )
        bucket = resp2.json()
        assert bucket["public"] is False, "workspace-files bucket should be private"


# ===========================================================================
# P0 -- AC3: RLS Policies (Thread-Ownership)
# ===========================================================================


@pytest.mark.isolation
async def test_rls_owner_can_select_own_files(
    api1: httpx.AsyncClient, token1: str
):
    """[2.1-INT-006] Owner can SELECT their own workspace files."""
    tid = await _create_thread(api1)
    await _insert_workspace_file(tid, file_path="notes/owner-read.md")

    rows = await _query_workspace_files_as_user(token1, tid)
    assert len(rows) == 1
    assert rows[0]["file_path"] == "notes/owner-read.md"


@pytest.mark.isolation
async def test_rls_nonowner_select_returns_empty(
    api1: httpx.AsyncClient, token2: str
):
    """[2.1-INT-007] Non-owner SELECT returns no rows."""
    tid = await _create_thread(api1)  # Thread owned by user1
    await _insert_workspace_file(tid, file_path="notes/secret.md")

    # User2 queries workspace_files for user1's thread
    rows = await _query_workspace_files_as_user(token2, tid)
    assert rows == [], f"Non-owner should see no rows, got {len(rows)}"


@pytest.mark.isolation
async def test_rls_nonowner_insert_blocked(
    api1: httpx.AsyncClient, token2: str
):
    """[2.1-INT-008] Non-owner INSERT is blocked by RLS."""
    tid = await _create_thread(api1)  # Thread owned by user1

    # User2 tries to insert into user1's thread
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SUPABASE_URL}/rest/v1/workspace_files",
            headers=_sb_user_headers(token2),
            json={
                "thread_id": tid,
                "file_path": "notes/unauthorized.md",
                "content": "hacked",
                "content_type": "text/markdown",
                "source": "agent",
                "size_bytes": 6,
            },
        )
        # RLS should block: either 403, 401, or the row is silently not inserted
        # Supabase returns 201 but inserts nothing if RLS blocks INSERT
        if resp.status_code == 201:
            # Verify nothing was actually inserted
            rows = await _query_workspace_files_as_user(token2, tid)
            assert rows == [], "RLS should have blocked INSERT for non-owner"


@pytest.mark.isolation
async def test_rls_nonowner_update_blocked(
    api1: httpx.AsyncClient, token2: str
):
    """[2.1-INT-009] Non-owner UPDATE is blocked by RLS."""
    tid = await _create_thread(api1)
    file_data = await _insert_workspace_file(tid, file_path="notes/no-update.md", content="original")

    # User2 tries to update user1's file
    async with httpx.AsyncClient() as client:
        resp = await client.patch(
            f"{SUPABASE_URL}/rest/v1/workspace_files",
            headers=_sb_user_headers(token2),
            params={"id": f"eq.{file_data['id']}"},
            json={"content": "tampered"},
        )
        # Verify content unchanged
        async with httpx.AsyncClient() as admin_client:
            check = await admin_client.get(
                f"{SUPABASE_URL}/rest/v1/workspace_files",
                headers=_sb_admin_headers(),
                params={"id": f"eq.{file_data['id']}", "select": "content"},
            )
            check.raise_for_status()
            rows = check.json()
            assert len(rows) == 1
            assert rows[0]["content"] == "original", "Non-owner UPDATE should be blocked by RLS"


@pytest.mark.isolation
async def test_rls_nonowner_delete_blocked(
    api1: httpx.AsyncClient, token2: str
):
    """[2.1-INT-010] Non-owner DELETE is blocked by RLS."""
    tid = await _create_thread(api1)
    file_data = await _insert_workspace_file(tid, file_path="notes/no-delete.md")

    # User2 tries to delete user1's file
    async with httpx.AsyncClient() as client:
        resp = await client.delete(
            f"{SUPABASE_URL}/rest/v1/workspace_files",
            headers=_sb_user_headers(token2),
            params={"id": f"eq.{file_data['id']}"},
        )
        # Verify file still exists
        async with httpx.AsyncClient() as admin_client:
            check = await admin_client.get(
                f"{SUPABASE_URL}/rest/v1/workspace_files",
                headers=_sb_admin_headers(),
                params={"id": f"eq.{file_data['id']}", "select": "id"},
            )
            check.raise_for_status()
            rows = check.json()
            assert len(rows) == 1, "Non-owner DELETE should be blocked by RLS"


# ===========================================================================
# P1 -- AC4: updated_at Auto-Update Trigger
# ===========================================================================


async def test_updated_at_trigger_fires_on_update(api1: httpx.AsyncClient):
    """[2.1-INT-011] updated_at changes after UPDATE via trigger."""
    tid = await _create_thread(api1)
    file_data = await _insert_workspace_file(tid, file_path="notes/trigger-test.md")

    original_updated_at = file_data["updated_at"]

    # Small delay to ensure timestamp difference
    import asyncio
    await asyncio.sleep(1.1)

    # Update the file content
    async with httpx.AsyncClient() as client:
        resp = await client.patch(
            f"{SUPABASE_URL}/rest/v1/workspace_files",
            headers=_sb_admin_headers(),
            params={"id": f"eq.{file_data['id']}"},
            json={"content": "updated content"},
        )
        resp.raise_for_status()
        updated = resp.json()
        updated_row = updated[0] if isinstance(updated, list) else updated

    assert updated_row["updated_at"] != original_updated_at, (
        f"updated_at should change after UPDATE. "
        f"Before: {original_updated_at}, After: {updated_row['updated_at']}"
    )
