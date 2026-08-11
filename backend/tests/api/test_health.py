"""API tests for health and auth endpoints."""

import httpx
import pytest

pytestmark = pytest.mark.api


async def test_health_returns_ok(api: httpx.AsyncClient):
    resp = await api.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


async def test_unauthenticated_request_rejected(api: httpx.AsyncClient):
    resp = await api.get("/threads")
    assert resp.status_code == 403


async def test_invalid_token_rejected(api: httpx.AsyncClient):
    resp = await api.get(
        "/threads",
        headers={"Authorization": "Bearer invalid-token-abc123"},
    )
    assert resp.status_code in (401, 403)


async def test_valid_token_returns_user(api1: httpx.AsyncClient):
    resp = await api1.get("/auth/me")
    assert resp.status_code == 200
    data = resp.json()
    assert data["email"] == "test@test.com"
    assert data["is_admin"] is True


async def test_user2_is_not_admin(api2: httpx.AsyncClient):
    resp = await api2.get("/auth/me")
    assert resp.status_code == 200
    assert resp.json()["is_admin"] is False
