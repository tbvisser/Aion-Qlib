"""Root conftest — shared fixtures for all backend tests."""

import logging
import os
import httpx
import pytest
import pytest_asyncio
from dotenv import load_dotenv

# Load backend .env so SUPABASE_ANON_KEY etc. are available
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Supabase auth helpers
# ---------------------------------------------------------------------------

SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://localhost:8000")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

# Test-user creds come from the environment (loaded from backend/.env above), not
# source — see backend/.env.example. Emails default to the conventional accounts;
# passwords have no default so no secret lives in the repo.
TEST_USER_1 = {
    "email": os.environ.get("TEST_USER1_EMAIL", "test@test.com"),
    "password": os.environ.get("TEST_USER1_PASSWORD", ""),
}
TEST_USER_2 = {
    "email": os.environ.get("TEST_USER2_EMAIL", "test2@test.com"),
    "password": os.environ.get("TEST_USER2_PASSWORD", ""),
}


async def _get_token(email: str, password: str) -> str:
    """Authenticate via Supabase GoTrue and return a JWT."""
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


# ---------------------------------------------------------------------------
# Fixtures — auth tokens
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture(scope="session")
async def token1() -> str:
    """JWT for test user 1 (admin)."""
    return await _get_token(**TEST_USER_1)


@pytest_asyncio.fixture(scope="session")
async def token2() -> str:
    """JWT for test user 2 (non-admin)."""
    return await _get_token(**TEST_USER_2)


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def auth_headers_1(token1: str) -> dict[str, str]:
    """Authorization headers for user 1."""
    return _auth_headers(token1)


@pytest.fixture
def auth_headers_2(token2: str) -> dict[str, str]:
    """Authorization headers for user 2."""
    return _auth_headers(token2)


# ---------------------------------------------------------------------------
# Fixtures — HTTP clients
# ---------------------------------------------------------------------------

API_BASE = os.environ.get("API_BASE_URL", "http://localhost:8001")


@pytest_asyncio.fixture
async def api() -> httpx.AsyncClient:
    """Unauthenticated async HTTP client pointed at the backend."""
    async with httpx.AsyncClient(base_url=API_BASE) as client:
        yield client


@pytest_asyncio.fixture
async def api1(token1: str) -> httpx.AsyncClient:
    """Authenticated async HTTP client for user 1 (admin)."""
    headers = _auth_headers(token1)
    async with httpx.AsyncClient(base_url=API_BASE, headers=headers) as client:
        yield client


@pytest_asyncio.fixture
async def api2(token2: str) -> httpx.AsyncClient:
    """Authenticated async HTTP client for user 2 (non-admin)."""
    headers = _auth_headers(token2)
    async with httpx.AsyncClient(base_url=API_BASE, headers=headers) as client:
        yield client


