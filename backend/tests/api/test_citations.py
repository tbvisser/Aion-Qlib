"""API tests for the web citation source endpoint (GET /citations/web-source/{id})."""

import base64
import json
import uuid

import pytest

from app.db.supabase import get_supabase_client


def _user_id_from_token(token: str) -> str:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))["sub"]


def _seed_snapshot(user_id: str, source_id: str, **overrides) -> None:
    row = {
        "user_id": user_id,
        "source_id": source_id,
        "url": "https://example.com/test-page",
        "title": "Test Page",
        "content": "Full captured page text for the snapshot.",
        "content_type": "text/markdown",
        "fetched_at": "2026-06-04T10:15:00+00:00",
    }
    row.update(overrides)
    get_supabase_client().table("web_snapshots").upsert(
        row, on_conflict="user_id,source_id"
    ).execute()


def _delete_snapshot(user_id: str, source_id: str) -> None:
    get_supabase_client().table("web_snapshots").delete().eq("user_id", user_id).eq(
        "source_id", source_id
    ).execute()


@pytest.mark.asyncio
async def test_web_source_returns_snapshot_for_owner(api1, token1):
    uid = _user_id_from_token(token1)
    source_id = f"web_test{uuid.uuid4().hex[:8]}"
    _seed_snapshot(uid, source_id)
    try:
        resp = await api1.get(f"/citations/web-source/{source_id}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["content"] == "Full captured page text for the snapshot."
        assert body["content_type"] == "text/markdown"
        assert body["uri"] == "https://example.com/test-page"
        assert body["fetched_at"] == "2026-06-04T10:15:00+00:00"
    finally:
        _delete_snapshot(uid, source_id)


@pytest.mark.asyncio
async def test_web_source_missing_returns_null(api1):
    resp = await api1.get(f"/citations/web-source/web_missing{uuid.uuid4().hex[:8]}")
    assert resp.status_code == 200
    assert resp.json()["content"] is None
    assert resp.json()["fetched_at"] is None


@pytest.mark.asyncio
async def test_web_source_isolated_between_users(api2, token1):
    """User 2 cannot read user 1's snapshot (user_id filter is the auth boundary)."""
    uid1 = _user_id_from_token(token1)
    source_id = f"web_iso{uuid.uuid4().hex[:8]}"
    _seed_snapshot(uid1, source_id, content="user1 only", url="https://example.com/private")
    try:
        resp = await api2.get(f"/citations/web-source/{source_id}")
        assert resp.status_code == 200
        assert resp.json()["content"] is None
    finally:
        _delete_snapshot(uid1, source_id)


@pytest.mark.asyncio
async def test_web_source_requires_auth(api):
    resp = await api.get("/citations/web-source/web_anything")
    assert resp.status_code in (401, 403)
