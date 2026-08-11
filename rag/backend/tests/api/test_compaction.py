"""API tests for the thread-compaction endpoints.

The long-thread trigger test is marked ``slow`` -- it actually streams
messages through the chat loop, which is real-LLM-dependent and slow.
"""

import httpx
import pytest

pytestmark = pytest.mark.api


async def test_compactions_endpoint_empty_for_fresh_thread(api1: httpx.AsyncClient):
    """A new thread has no compactions; endpoint returns []."""
    thread = (await api1.post("/threads", json={})).json()
    resp = await api1.get(f"/threads/{thread['id']}/compactions")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_manual_compact_short_thread_returns_null(api1: httpx.AsyncClient):
    """Forcing compaction on an empty/short thread has nothing to evict."""
    thread = (await api1.post("/threads", json={})).json()
    resp = await api1.post(f"/threads/{thread['id']}/compact")
    assert resp.status_code == 200
    body = resp.json()
    # Either null (no compaction inserted) or a row with no evictions.
    assert body is None or body.get("evicted_message_count", 0) == 0


@pytest.mark.isolation
async def test_user2_cannot_see_user1_compactions(
    api1: httpx.AsyncClient, api2: httpx.AsyncClient
):
    """RLS: user2 cannot list compactions on user1's thread."""
    thread = (await api1.post("/threads", json={"title": "compaction iso"})).json()
    resp = await api2.get(f"/threads/{thread['id']}/compactions")
    assert resp.status_code == 404


@pytest.mark.isolation
async def test_user2_cannot_trigger_compaction_on_user1_thread(
    api1: httpx.AsyncClient, api2: httpx.AsyncClient
):
    """RLS: user2 cannot force a compaction on user1's thread."""
    thread = (await api1.post("/threads", json={"title": "compaction iso 2"})).json()
    resp = await api2.post(f"/threads/{thread['id']}/compact")
    assert resp.status_code == 404


async def test_compactions_endpoint_on_nonexistent_thread(api1: httpx.AsyncClient):
    resp = await api1.get(
        "/threads/00000000-0000-0000-0000-000000000000/compactions"
    )
    assert resp.status_code == 404


@pytest.mark.slow
async def test_long_thread_triggers_compaction(api1: httpx.AsyncClient):
    """Push enough chat messages through the real send_message pipeline to
    cross the trigger ratio. Requires backend env with a sufficiently small
    COMPACTION_TRIGGER_RATIO or LLM_CONTEXT_WINDOW (Level-4 manual test).

    Marked slow so CI's default `-m 'not slow'` selection skips it; run
    explicitly with `pytest -m slow` after configuring the env override.
    """
    thread = (await api1.post("/threads", json={})).json()
    for i in range(15):
        await api1.post(
            f"/threads/{thread['id']}/messages",
            json={"content": f"hello {i}"},
            timeout=60,
        )
    resp = await api1.get(f"/threads/{thread['id']}/compactions")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1
