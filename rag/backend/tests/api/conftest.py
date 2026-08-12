"""API test fixtures — cleanup runs once at the start of the API test session."""

import logging
import os
import httpx
import pytest
import pytest_asyncio

log = logging.getLogger(__name__)

API_BASE = os.environ.get("API_BASE_URL", "http://localhost:8001")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://localhost:8000")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

# Test-user creds come from the environment (loaded from backend/.env by the root
# conftest), not source — see backend/.env.example. Emails default; passwords have
# no default so no secret lives in the repo.
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


async def _cleanup_user_data(client: httpx.AsyncClient) -> None:
    """Delete all threads and folders for a user. Threads cascade to messages/todos."""
    # Bounded loop with per-iteration progress check: a silent DELETE failure
    # used to spin forever and hang the session-scoped autouse fixture.
    for _ in range(20):  # at most 20 * 200 = 4000 threads per cleanup
        resp = await client.get("/threads", params={"limit": 200}, timeout=30.0)
        if resp.status_code != 200:
            log.warning(
                "cleanup: /threads returned %s, aborting cleanup early", resp.status_code
            )
            break
        payload = resp.json()
        threads = payload["threads"] if isinstance(payload, dict) else payload
        if not threads:
            break
        before = len(threads)
        deleted = 0
        for t in threads:
            r = await client.delete(f"/threads/{t['id']}", timeout=10.0)
            if r.status_code < 400:
                deleted += 1
            else:
                log.warning(
                    "cleanup: DELETE /threads/%s returned %s", t["id"], r.status_code
                )
        if deleted == 0:
            raise RuntimeError(
                f"cleanup made no progress ({before} threads remain after DELETE attempts)"
            )

    resp = await client.get("/folders", timeout=30.0)
    if resp.status_code == 200:
        folders = resp.json()
        with_parent = [f for f in folders if f.get("parent_id")]
        without_parent = [f for f in folders if not f.get("parent_id")]
        for f in with_parent + without_parent:
            await client.delete(f"/folders/{f['id']}", timeout=10.0)


@pytest_asyncio.fixture(autouse=True, scope="session")
async def cleanup_test_data_once():
    """Wipe all test data for both users once before the API test session starts.

    Setup-based cleanup: self-healing even if previous runs crashed.
    """
    token1 = await _get_token(**TEST_USER_1)
    token2 = await _get_token(**TEST_USER_2)

    async with httpx.AsyncClient(
        base_url=API_BASE,
        headers={"Authorization": f"Bearer {token1}"},
    ) as client1, httpx.AsyncClient(
        base_url=API_BASE,
        headers={"Authorization": f"Bearer {token2}"},
    ) as client2:
        await _cleanup_user_data(client1)
        await _cleanup_user_data(client2)

    yield

    # Best-effort teardown after all API tests
    try:
        async with httpx.AsyncClient(
            base_url=API_BASE,
            headers={"Authorization": f"Bearer {token1}"},
        ) as client1, httpx.AsyncClient(
            base_url=API_BASE,
            headers={"Authorization": f"Bearer {token2}"},
        ) as client2:
            await _cleanup_user_data(client1)
            await _cleanup_user_data(client2)
    except Exception as exc:
        log.debug("Teardown cleanup failed (non-critical): %s", exc)
