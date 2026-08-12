"""API integration tests for Story 2.4: Workspace REST Endpoints.

Tests validate:
- AC3: GET /threads/{id}/files returns file list
- AC4: GET /threads/{id}/files/{path} returns file content
- AC6: Workspace REST endpoints enforce thread ownership
"""

import os

import httpx
import pytest

pytestmark = pytest.mark.api

API_BASE = os.environ.get("API_BASE_URL", "http://localhost:8001")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://localhost:8000")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

# Test-user creds come from the environment (loaded from backend/.env by the root
# conftest), not source — see backend/.env.example.
TEST_USER_1 = {
    "email": os.environ.get("TEST_USER1_EMAIL", "test@test.com"),
    "password": os.environ.get("TEST_USER1_PASSWORD", ""),
}
TEST_USER_2 = {
    "email": os.environ.get("TEST_USER2_EMAIL", "test2@test.com"),
    "password": os.environ.get("TEST_USER2_PASSWORD", ""),
}


async def _get_token(email: str, password: str) -> str:
    if not password:
        pytest.skip(
            "Test-user password not set — configure TEST_USER1_PASSWORD / "
            "TEST_USER2_PASSWORD in backend/.env (see .env.example)."
        )
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
            headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            json={"email": email, "password": password},
        )
        resp.raise_for_status()
        return resp.json()["access_token"]


def _sb_admin_headers() -> dict[str, str]:
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


async def _create_thread_and_file(token: str, file_path: str = "notes/test.md", content: str = "# Test"):
    """Create a thread via API, then insert a workspace file via service-role."""
    async with httpx.AsyncClient(base_url=API_BASE) as client:
        resp = await client.post(
            "/threads",
            json={"title": "workspace-rest-test"},
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        assert resp.status_code == 201
        thread_id = resp.json()["id"]

    # Insert file via admin (bypasses RLS)
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SUPABASE_URL}/rest/v1/workspace_files",
            headers=_sb_admin_headers(),
            json={
                "thread_id": thread_id,
                "file_path": file_path,
                "content": content,
                "content_type": "text/markdown",
                "source": "agent",
                "size_bytes": len(content.encode("utf-8")),
            },
        )
        resp.raise_for_status()

    return thread_id


# ===========================================================================
# AC3: GET /threads/{id}/files returns file list
# ===========================================================================


async def test_list_workspace_files_returns_files():
    """[2.4-INT-001] GET /threads/{id}/files returns workspace files for the thread."""
    token = await _get_token(**TEST_USER_1)
    thread_id = await _create_thread_and_file(token)

    async with httpx.AsyncClient(base_url=API_BASE) as client:
        resp = await client.get(
            f"/threads/{thread_id}/files",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        files = resp.json()
        assert len(files) >= 1
        assert files[0]["file_path"] == "notes/test.md"
        assert files[0]["content_type"] == "text/markdown"
        assert files[0]["source"] == "agent"


async def test_list_workspace_files_empty_thread():
    """[2.4-INT-002] GET /threads/{id}/files returns empty list for thread with no files."""
    token = await _get_token(**TEST_USER_1)

    async with httpx.AsyncClient(base_url=API_BASE) as client:
        resp = await client.post(
            "/threads",
            json={"title": "empty-workspace"},
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        assert resp.status_code == 201
        thread_id = resp.json()["id"]

        resp = await client.get(
            f"/threads/{thread_id}/files",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert resp.json() == []


# ===========================================================================
# AC4: GET /threads/{id}/files/{path} returns file content
# ===========================================================================


async def test_get_workspace_file_returns_content():
    """[2.4-INT-003] GET /threads/{id}/files/{path} returns text content."""
    token = await _get_token(**TEST_USER_1)
    thread_id = await _create_thread_and_file(token, content="# Hello World")

    async with httpx.AsyncClient(base_url=API_BASE) as client:
        resp = await client.get(
            f"/threads/{thread_id}/files/notes/test.md",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert "Hello World" in resp.text


async def test_get_workspace_file_download_flag():
    """[2.4-INT-004] GET /threads/{id}/files/{path}?download=true returns content as attachment."""
    token = await _get_token(**TEST_USER_1)
    thread_id = await _create_thread_and_file(token, content="download me")

    async with httpx.AsyncClient(base_url=API_BASE) as client:
        resp = await client.get(
            f"/threads/{thread_id}/files/notes/test.md",
            headers={"Authorization": f"Bearer {token}"},
            params={"download": "true"},
        )
        assert resp.status_code == 200
        assert "attachment" in resp.headers.get("content-disposition", "")


async def test_get_workspace_file_not_found():
    """[2.4-INT-005] GET /threads/{id}/files/{path} returns 404 for missing file."""
    token = await _get_token(**TEST_USER_1)

    async with httpx.AsyncClient(base_url=API_BASE) as client:
        resp = await client.post(
            "/threads",
            json={"title": "no-file-test"},
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        thread_id = resp.json()["id"]

        resp = await client.get(
            f"/threads/{thread_id}/files/nonexistent.md",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 404


# ===========================================================================
# AC6: Thread ownership enforcement
# ===========================================================================


@pytest.mark.isolation
async def test_list_files_forbidden_for_nonowner():
    """[2.4-INT-006] GET /threads/{id}/files returns 403 for non-owner."""
    token1 = await _get_token(**TEST_USER_1)
    token2 = await _get_token(**TEST_USER_2)
    thread_id = await _create_thread_and_file(token1)

    async with httpx.AsyncClient(base_url=API_BASE) as client:
        resp = await client.get(
            f"/threads/{thread_id}/files",
            headers={"Authorization": f"Bearer {token2}"},
        )
        assert resp.status_code == 403


@pytest.mark.isolation
async def test_get_file_forbidden_for_nonowner():
    """[2.4-INT-007] GET /threads/{id}/files/{path} returns 403 for non-owner."""
    token1 = await _get_token(**TEST_USER_1)
    token2 = await _get_token(**TEST_USER_2)
    thread_id = await _create_thread_and_file(token1)

    async with httpx.AsyncClient(base_url=API_BASE) as client:
        resp = await client.get(
            f"/threads/{thread_id}/files/notes/test.md",
            headers={"Authorization": f"Bearer {token2}"},
        )
        assert resp.status_code == 403
