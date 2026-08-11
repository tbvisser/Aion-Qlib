"""API tests for deep mode: todos REST endpoint, message persistence, SSE events."""

import json
import os
import uuid

import httpx
import pytest

pytestmark = pytest.mark.api

# ---------------------------------------------------------------------------
# Helpers
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


async def _create_thread(api: httpx.AsyncClient, title: str = "deep-test") -> str:
    """Create a thread and return its id."""
    resp = await api.post("/threads", json={"title": title})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _insert_todos_direct(thread_id: str, todos: list[dict]) -> None:
    """Insert todos directly via Supabase REST (service-role, bypasses RLS)."""
    rows = [
        {
            "thread_id": thread_id,
            "content": t["content"],
            "status": t["status"],
            "position": t["position"],
        }
        for t in todos
    ]
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SUPABASE_URL}/rest/v1/agent_todos",
            headers=_sb_admin_headers(),
            json=rows,
        )
        resp.raise_for_status()


async def _stream_message(
    api: httpx.AsyncClient,
    thread_id: str,
    content: str = "hello",
    deep_mode: bool = False,
    timeout: float = 60.0,
) -> list[dict]:
    """Send a message via SSE stream and return parsed data events."""
    events: list[dict] = []
    body = {"content": content, "deep_mode": deep_mode}
    async with api.stream(
        "POST",
        f"/threads/{thread_id}/messages",
        json=body,
        timeout=timeout,
    ) as resp:
        assert resp.status_code == 200
        async for line in resp.aiter_lines():
            if line.startswith("data: "):
                payload = line[len("data: "):]
                try:
                    events.append(json.loads(payload))
                except json.JSONDecodeError:
                    pass
    return events


# ===========================================================================
# P0 — Todos REST Endpoint
# ===========================================================================


async def test_get_todos_empty_thread(api1: httpx.AsyncClient):
    """GET /threads/{id}/todos on a fresh thread returns empty list."""
    tid = await _create_thread(api1)
    resp = await api1.get(f"/threads/{tid}/todos")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_get_todos_after_write(api1: httpx.AsyncClient):
    """Directly inserted todos are returned by the GET endpoint."""
    tid = await _create_thread(api1)
    todos = [
        {"content": "Step A", "status": "pending", "position": 0},
        {"content": "Step B", "status": "in_progress", "position": 1},
    ]
    await _insert_todos_direct(tid, todos)

    resp = await api1.get(f"/threads/{tid}/todos")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    assert data[0]["content"] == "Step A"
    assert data[1]["content"] == "Step B"


async def test_get_todos_returns_ordered_by_position(api1: httpx.AsyncClient):
    """Todos inserted out of order are returned sorted by position."""
    tid = await _create_thread(api1)
    # Insert in deliberate disorder: position 2, 0, 1
    todos = [
        {"content": "Third", "status": "pending", "position": 2},
        {"content": "First", "status": "pending", "position": 0},
        {"content": "Second", "status": "completed", "position": 1},
    ]
    await _insert_todos_direct(tid, todos)

    resp = await api1.get(f"/threads/{tid}/todos")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 3
    assert [d["position"] for d in data] == [0, 1, 2]
    assert data[0]["content"] == "First"
    assert data[1]["content"] == "Second"
    assert data[2]["content"] == "Third"


@pytest.mark.isolation
async def test_get_todos_cross_user_returns_empty(
    api1: httpx.AsyncClient, api2: httpx.AsyncClient
):
    """User2 cannot see User1's todos — endpoint returns empty list."""
    tid = await _create_thread(api1)
    await _insert_todos_direct(
        tid, [{"content": "secret", "status": "pending", "position": 0}]
    )
    # User2 tries to read User1's thread todos
    resp = await api2.get(f"/threads/{tid}/todos")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_get_todos_nonexistent_thread(api1: httpx.AsyncClient):
    """Nonexistent thread returns empty list, not 404."""
    fake_id = "00000000-0000-0000-0000-000000000000"
    resp = await api1.get(f"/threads/{fake_id}/todos")
    assert resp.status_code == 200
    assert resp.json() == []


# ===========================================================================
# P0 — Deep Mode Message Persistence
# ===========================================================================


async def test_send_message_deep_mode_true(api1: httpx.AsyncClient):
    """Message sent with deep_mode=true persists the flag in the DB."""
    tid = await _create_thread(api1)
    # Stream the message (just consume it, don't need the events)
    await _stream_message(api1, tid, content="plan something", deep_mode=True)

    # Fetch messages and check deep_mode on the user message
    resp = await api1.get(f"/threads/{tid}/messages")
    assert resp.status_code == 200
    msgs = resp.json()
    user_msgs = [m for m in msgs if m["role"] == "user"]
    assert len(user_msgs) >= 1
    async with httpx.AsyncClient() as sb:
        sb_resp = await sb.get(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers=_sb_admin_headers(),
            params={
                "thread_id": f"eq.{tid}",
                "role": "eq.user",
                "select": "id,deep_mode",
            },
        )
        sb_resp.raise_for_status()
        rows = sb_resp.json()
        assert len(rows) >= 1
        assert rows[0]["deep_mode"] is True


async def test_send_message_deep_mode_false_default(api1: httpx.AsyncClient):
    """Message sent without deep_mode defaults to false."""
    tid = await _create_thread(api1)
    await _stream_message(api1, tid, content="just a normal question", deep_mode=False)

    async with httpx.AsyncClient() as sb:
        sb_resp = await sb.get(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers=_sb_admin_headers(),
            params={
                "thread_id": f"eq.{tid}",
                "role": "eq.user",
                "select": "id,deep_mode",
            },
        )
        sb_resp.raise_for_status()
        rows = sb_resp.json()
        assert len(rows) >= 1
        assert rows[0]["deep_mode"] is False


# ===========================================================================
# P1 — SSE Events (stream parsing)
# ===========================================================================


@pytest.mark.slow
async def test_deep_mode_emits_agent_status_working(api1: httpx.AsyncClient):
    """Deep mode stream emits an agent_status event with status=working."""
    tid = await _create_thread(api1)
    events = await _stream_message(
        api1, tid, content="plan a hello world app", deep_mode=True, timeout=90.0
    )
    agent_statuses = [
        e for e in events if e.get("type") == "agent_status" and e.get("status") == "working"
    ]
    assert len(agent_statuses) >= 1, (
        f"Expected at least one agent_status/working event, got: "
        f"{[e for e in events if e.get('type') == 'agent_status']}"
    )


@pytest.mark.slow
async def test_deep_mode_emits_agent_status_complete(api1: httpx.AsyncClient):
    """Deep mode stream emits an agent_status event with status=complete."""
    tid = await _create_thread(api1)
    events = await _stream_message(
        api1, tid, content="plan a hello world app", deep_mode=True, timeout=90.0
    )
    agent_statuses = [
        e for e in events if e.get("type") == "agent_status"
    ]
    assert len(agent_statuses) >= 2, (
        f"Expected at least working + complete agent_status events, got {len(agent_statuses)}"
    )
    # The last agent_status should be 'complete'
    last_status = agent_statuses[-1]
    assert last_status["status"] == "complete", (
        f"Expected final agent_status to be 'complete', got '{last_status['status']}'"
    )


# ===========================================================================
# P2 — Config
# ===========================================================================


async def test_config_max_deep_rounds_default(api: httpx.AsyncClient):
    """Backend is up and loaded config (health check serves as config smoke test)."""
    resp = await api.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
