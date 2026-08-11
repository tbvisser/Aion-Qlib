"""Two-user cross-tenant isolation tests (Workstream B1 — backend ownership filters).

DRAFT REPRO — written during the Phase-1 security audit. Phase 2 runs it serially.

WHY THIS FILE IS SELF-CONTAINED
-------------------------------
The shared ``backend/tests/api/conftest.py`` has a *session-scoped autouse* fixture
that wipes ALL threads + folders for both test users. To keep this repro safe to run
on its own (and to avoid depending on that destructive fixture's ordering), this file:
  * reuses ONE token per user (module-scoped) — GoTrue 400-rate-limits rapid logins;
  * creates only the resources it needs and tears them down in its own fixtures;
  * never calls the session cleanup helper.

It still lives under ``tests/api`` so it inherits the same creds/env loading. If you
must run ONLY this file without triggering the session wipe, deselect the autouse
fixture, e.g.::

    pytest backend/tests/api/test_security_isolation.py \
        -p no:cacheprovider -o addopts="" -k isolation

THREAT MODEL
------------
The backend talks to Supabase with the service-role key, which BYPASSES RLS. So the
application-level ownership predicate (``.eq("user_id", current_user.id)`` or a
thread-ownership join) is the *only* tenant-isolation boundary for these endpoints.
For every resource type below: user1 creates it, then user2 (a different, valid,
authenticated user) attempts to GET / PATCH / DELETE it by id. Expected: 403 or 404
(never 200, never the other tenant's data, never a successful mutation).

Each parametrized case is independent; a failure on one resource doesn't mask others.
"""
from __future__ import annotations

import io
import os
import uuid

import httpx
import pytest
import pytest_asyncio

API_BASE = os.environ.get("API_BASE_URL", "http://localhost:8001")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://localhost:8000")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

_USER1 = {
    "email": os.environ.get("TEST_USER1_EMAIL", "test@test.com"),
    "password": os.environ.get("TEST_USER1_PASSWORD", ""),
}
_USER2 = {
    "email": os.environ.get("TEST_USER2_EMAIL", "test2@test.com"),
    "password": os.environ.get("TEST_USER2_PASSWORD", ""),
}

# A cross-tenant access attempt must be refused. We accept either "denied" (403) or
# "as if it doesn't exist" (404) — both are valid IDOR-safe responses. We explicitly
# reject 200 and 5xx.
DENIED = {403, 404}

# Seven handlers correctly DENY cross-tenant access (0 rows, no foreign data) but
# surface it as HTTP 500 instead of 404, because they call PostgREST `.single()` on
# the empty result and the global handler maps the resulting error to 500 (+ echoes
# raw PGRST116 text). That status/hygiene defect is tracked as **finding F-002** (and
# its 6-endpoint amplifier), NOT as an isolation failure: no tenant data crosses. So
# for those endpoints we accept 500 as a (sloppy) denial. The IDOR regression still
# holds — a real cross-tenant leak would return 200, which is excluded here. When
# F-002 is fixed (`.maybe_single()`/explicit 404), switch these back to `DENIED`.
DENIED_OR_ERR = {403, 404, 500}


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


@pytest_asyncio.fixture(scope="module")
async def tokens() -> dict[str, str]:
    """One token per user for the whole module (avoid GoTrue login rate limits)."""
    return {
        "u1": await _get_token(**_USER1),
        "u2": await _get_token(**_USER2),
    }


@pytest_asyncio.fixture
async def c1(tokens):
    async with httpx.AsyncClient(
        base_url=API_BASE, headers={"Authorization": f"Bearer {tokens['u1']}"}, timeout=30.0
    ) as client:
        yield client


@pytest_asyncio.fixture
async def c2(tokens):
    async with httpx.AsyncClient(
        base_url=API_BASE, headers={"Authorization": f"Bearer {tokens['u2']}"}, timeout=30.0
    ) as client:
        yield client


# --------------------------------------------------------------------------- #
# Resource builders — each returns (ids_dict, cleanup_coro). user1 owns them.   #
# --------------------------------------------------------------------------- #

@pytest_asyncio.fixture
async def thread_u1(c1):
    r = await c1.post("/threads", json={"title": "iso-thread"})
    assert r.status_code == 201, r.text
    tid = r.json()["id"]
    yield tid
    await c1.delete(f"/threads/{tid}")


@pytest_asyncio.fixture
async def message_u1(c1, thread_u1):
    """A persisted user message in user1's thread (created via the SSE endpoint).

    We don't need to consume the whole stream — the user row is inserted before the
    model is called. We read the messages list to grab its id.
    """
    # Fire a send; the user message is persisted synchronously before streaming.
    async with c1.stream("POST", f"/threads/{thread_u1}/messages",
                         json={"content": "hello isolation"}) as resp:
        assert resp.status_code == 200, await resp.aread()
        # Drain a little then bail — we only need the user row to exist.
        async for _ in resp.aiter_bytes():
            break
    r = await c1.get(f"/threads/{thread_u1}/messages")
    assert r.status_code == 200, r.text
    msgs = r.json()
    assert msgs, "expected at least the user message"
    yield {"thread_id": thread_u1, "message_id": msgs[0]["id"]}


@pytest_asyncio.fixture
async def folder_u1(c1):
    r = await c1.post("/folders", json={"name": f"iso-{uuid.uuid4().hex[:8]}"})
    assert r.status_code == 200, r.text
    fid = r.json()["id"]
    yield fid
    await c1.delete(f"/folders/{fid}")


@pytest_asyncio.fixture
async def document_u1(c1):
    files = {"file": ("iso.txt", io.BytesIO(b"isolation secret payload"), "text/plain")}
    r = await c1.post("/documents/upload", files=files)
    assert r.status_code in (200, 201), r.text
    doc = r.json()
    yield doc["id"]
    await c1.delete(f"/documents/{doc['id']}")


@pytest_asyncio.fixture
async def skill_u1(c1):
    r = await c1.post("/skills", json={
        "name": f"iso-skill-{uuid.uuid4().hex[:6]}",
        "description": "isolation test skill with a sufficiently long description",
        "instructions": "do the thing",
        "enabled": True,
    })
    assert r.status_code == 200, r.text
    sid = r.json()["id"]
    # attach a private text file so we can test file-content IDOR
    files = {"file": ("notes.txt", io.BytesIO(b"private skill file body"), "text/plain")}
    fr = await c1.post(f"/skills/{sid}/files", files=files)
    assert fr.status_code == 200, fr.text
    yield {"skill_id": sid, "file_id": fr.json()["id"]}
    await c1.delete(f"/skills/{sid}")


@pytest_asyncio.fixture
async def workspace_file_u1(c1, thread_u1):
    files = {"file": ("ws.txt", io.BytesIO(b"workspace secret"), "text/plain")}
    r = await c1.post(f"/threads/{thread_u1}/files/upload", files=files)
    assert r.status_code == 201, r.text
    yield {"thread_id": thread_u1, "file_path": r.json()["file_path"]}
    # cascades with the thread


@pytest_asyncio.fixture
async def harness_run_u1(c1, thread_u1):
    r = await c1.post(f"/threads/{thread_u1}/harness",
                      json={"harness_type": "contract_review", "input_file_ids": []})
    if r.status_code not in (200, 201):
        pytest.skip(f"harness create unavailable ({r.status_code}): {r.text}")
    yield {"thread_id": thread_u1, "run_id": r.json()["id"]}
    await c1.delete(f"/threads/{thread_u1}/harness")


# --------------------------------------------------------------------------- #
# Cross-tenant READ attempts (user2 reading user1's resource by id).           #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_thread_read_isolation(c2, thread_u1):
    assert (await c2.get(f"/threads/{thread_u1}")).status_code in DENIED


@pytest.mark.asyncio
async def test_thread_messages_read_isolation(c2, message_u1):
    r = await c2.get(f"/threads/{message_u1['thread_id']}/messages")
    assert r.status_code in DENIED_OR_ERR  # F-002: .single() 500s on deny; 0 rows, no leak


@pytest.mark.asyncio
async def test_thread_todos_read_isolation(c2, thread_u1):
    # Endpoint returns [] on PermissionError; assert it does NOT leak rows.
    r = await c2.get(f"/threads/{thread_u1}/todos")
    assert r.status_code in DENIED or r.json() == []


@pytest.mark.asyncio
async def test_thread_compactions_read_isolation(c2, thread_u1):
    assert (await c2.get(f"/threads/{thread_u1}/compactions")).status_code in DENIED


@pytest.mark.asyncio
async def test_check_citations_isolation(c2, message_u1):
    r = await c2.post(
        f"/threads/{message_u1['thread_id']}/messages/{message_u1['message_id']}/check-citations"
    )
    assert r.status_code in DENIED_OR_ERR  # F-002: .single() 500s on deny; 0 rows, no leak


@pytest.mark.asyncio
async def test_document_read_isolation(c2, document_u1):
    assert (await c2.get(f"/documents/{document_u1}")).status_code in DENIED_OR_ERR  # F-002


@pytest.mark.asyncio
async def test_document_download_isolation(c2, document_u1):
    assert (await c2.get(f"/documents/{document_u1}/download")).status_code in DENIED


@pytest.mark.asyncio
async def test_document_chunks_isolation(c2, document_u1):
    assert (await c2.get(f"/documents/{document_u1}/chunks")).status_code in DENIED_OR_ERR  # F-002


@pytest.mark.asyncio
async def test_document_render_isolation(c2, document_u1):
    assert (await c2.get(f"/documents/{document_u1}/render")).status_code in DENIED


@pytest.mark.asyncio
async def test_chunks_by_ranges_isolation(c2, document_u1):
    """The SECURITY DEFINER RPC must scope chunks to the caller's user_id even when
    user2 supplies user1's document_id."""
    r = await c2.post("/documents/chunks-by-ranges", json={
        "items": [{"document_id": document_u1, "chunk_ranges": [[0, 50]]}]
    })
    # Endpoint returns 200 with an empty grouping for non-owned docs (RPC filters by
    # user_id). The security assertion is: NO chunks leak.
    assert r.status_code == 200, r.text
    assert r.json().get("total_chunks", 0) == 0


@pytest.mark.asyncio
async def test_folder_read_isolation(c2, folder_u1):
    assert (await c2.get(f"/folders/{folder_u1}")).status_code in DENIED


@pytest.mark.asyncio
async def test_folder_ancestors_isolation(c2, folder_u1):
    r = await c2.get(f"/folders/{folder_u1}/ancestors")
    # Walk stops on first non-visible folder → empty path (no leak) is also acceptable.
    assert r.status_code in DENIED or r.json() == []


@pytest.mark.asyncio
async def test_skill_file_content_isolation(c2, skill_u1):
    """user2 must not read the body of user1's PRIVATE skill file."""
    r = await c2.get(f"/skills/{skill_u1['skill_id']}/files/{skill_u1['file_id']}/content")
    assert r.status_code in DENIED


@pytest.mark.asyncio
async def test_skill_files_list_isolation(c2, skill_u1):
    assert (await c2.get(f"/skills/{skill_u1['skill_id']}/files")).status_code in DENIED


@pytest.mark.asyncio
async def test_skill_export_isolation(c2, skill_u1):
    assert (await c2.get(f"/skills/{skill_u1['skill_id']}/export")).status_code in DENIED


@pytest.mark.asyncio
async def test_workspace_file_read_isolation(c2, workspace_file_u1):
    r = await c2.get(
        f"/threads/{workspace_file_u1['thread_id']}/files/{workspace_file_u1['file_path']}"
    )
    assert r.status_code in DENIED


@pytest.mark.asyncio
async def test_workspace_files_list_isolation(c2, workspace_file_u1):
    assert (await c2.get(f"/threads/{workspace_file_u1['thread_id']}/files")).status_code in DENIED


@pytest.mark.asyncio
async def test_harness_status_isolation(c2, harness_run_u1):
    r = await c2.get(f"/threads/{harness_run_u1['thread_id']}/harness")
    # get_harness_run_any joins threads on user_id → None for non-owner. Assert no leak.
    assert r.status_code in DENIED or r.json() is None


# --------------------------------------------------------------------------- #
# Cross-tenant WRITE attempts (user2 mutating user1's resource by id).          #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_thread_update_isolation(c2, thread_u1):
    assert (await c2.patch(f"/threads/{thread_u1}", json={"title": "pwned"})).status_code in DENIED


@pytest.mark.asyncio
async def test_thread_delete_isolation(c1, c2, thread_u1):
    assert (await c2.delete(f"/threads/{thread_u1}")).status_code in DENIED
    # Prove it still exists for the owner.
    assert (await c1.get(f"/threads/{thread_u1}")).status_code == 200


@pytest.mark.asyncio
async def test_thread_compact_isolation(c2, thread_u1):
    assert (await c2.post(f"/threads/{thread_u1}/compact")).status_code in DENIED


@pytest.mark.asyncio
async def test_document_delete_isolation(c1, c2, document_u1):
    assert (await c2.delete(f"/documents/{document_u1}")).status_code in DENIED
    assert (await c1.get(f"/documents/{document_u1}")).status_code == 200


@pytest.mark.asyncio
async def test_document_move_isolation(c2, document_u1):
    assert (await c2.patch(f"/documents/{document_u1}/move",
                           json={"folder_id": None})).status_code in DENIED_OR_ERR  # F-002


@pytest.mark.asyncio
async def test_document_retry_isolation(c2, document_u1):
    assert (await c2.post(f"/documents/{document_u1}/retry")).status_code in DENIED_OR_ERR  # F-002


@pytest.mark.asyncio
async def test_bulk_delete_isolation(c1, c2, document_u1):
    """user2's bulk-delete must report user1's doc as 'failed', not delete it."""
    r = await c2.post("/documents/bulk-delete", json={"document_ids": [document_u1]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert document_u1 in body["failed"]
    assert document_u1 not in body["succeeded"]
    assert (await c1.get(f"/documents/{document_u1}")).status_code == 200


@pytest.mark.asyncio
async def test_bulk_move_isolation(c1, c2, document_u1):
    r = await c2.post("/documents/bulk-move",
                      json={"document_ids": [document_u1], "folder_id": None})
    assert r.status_code == 200, r.text
    assert document_u1 in r.json()["failed"]


@pytest.mark.asyncio
async def test_folder_update_isolation(c2, folder_u1):
    assert (await c2.patch(f"/folders/{folder_u1}", json={"name": "pwned"})).status_code in DENIED


@pytest.mark.asyncio
async def test_folder_delete_isolation(c1, c2, folder_u1):
    assert (await c2.delete(f"/folders/{folder_u1}")).status_code in DENIED
    assert (await c1.get(f"/folders/{folder_u1}")).status_code == 200


@pytest.mark.asyncio
async def test_folder_move_isolation(c2, folder_u1):
    assert (await c2.patch(f"/folders/{folder_u1}/move",
                           json={"parent_id": None})).status_code in DENIED


@pytest.mark.asyncio
async def test_folder_share_isolation(c2, folder_u1):
    """user2 must not be able to globalize user1's folder."""
    assert (await c2.patch(f"/folders/{folder_u1}/share",
                           json={"is_global": True})).status_code in DENIED


@pytest.mark.asyncio
async def test_skill_update_isolation(c2, skill_u1):
    assert (await c2.patch(f"/skills/{skill_u1['skill_id']}",
                           json={"name": "pwned"})).status_code in DENIED


@pytest.mark.asyncio
async def test_skill_delete_isolation(c1, c2, skill_u1):
    assert (await c2.delete(f"/skills/{skill_u1['skill_id']}")).status_code in DENIED
    assert (await c1.get(f"/skills/{skill_u1['skill_id']}")).status_code == 200


@pytest.mark.asyncio
async def test_skill_share_isolation(c2, skill_u1):
    assert (await c2.patch(f"/skills/{skill_u1['skill_id']}/share",
                           json={"is_global": True})).status_code in DENIED


@pytest.mark.asyncio
async def test_skill_file_upload_isolation(c2, skill_u1):
    files = {"file": ("evil.txt", io.BytesIO(b"x"), "text/plain")}
    assert (await c2.post(f"/skills/{skill_u1['skill_id']}/files",
                          files=files)).status_code in DENIED


@pytest.mark.asyncio
async def test_skill_file_delete_isolation(c2, skill_u1):
    assert (await c2.delete(
        f"/skills/{skill_u1['skill_id']}/files/{skill_u1['file_id']}"
    )).status_code in DENIED


@pytest.mark.asyncio
async def test_workspace_upload_isolation(c2, thread_u1):
    files = {"file": ("evil.txt", io.BytesIO(b"x"), "text/plain")}
    assert (await c2.post(f"/threads/{thread_u1}/files/upload",
                          files=files)).status_code in DENIED


@pytest.mark.asyncio
async def test_harness_create_isolation(c2, thread_u1):
    assert (await c2.post(f"/threads/{thread_u1}/harness",
                          json={"harness_type": "contract_review",
                                "input_file_ids": []})).status_code in DENIED_OR_ERR  # F-002


@pytest.mark.asyncio
async def test_harness_cancel_isolation(c2, harness_run_u1):
    assert (await c2.delete(
        f"/threads/{harness_run_u1['thread_id']}/harness"
    )).status_code in DENIED


# --------------------------------------------------------------------------- #
# Web citation source — keyed on a content-derived source_id, scoped by user.   #
# A non-existent source_id returns a null-shaped body (not an error); the real  #
# assertion is that user2 cannot read user1's captured snapshot. Without a live #
# web-search capture we can only assert the negative (random id → null body).   #
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_web_citation_source_unknown_returns_null(c2):
    r = await c2.get(f"/citations/web-source/{uuid.uuid4()}")
    assert r.status_code == 200
    assert r.json()["content"] is None


@pytest.mark.asyncio
async def test_admin_metadata_schema_requires_admin(c2):
    """Non-admin user2 must be refused the only admin-gated write endpoint."""
    r = await c2.put("/settings/metadata-schema", json={"metadata_schema": []})
    assert r.status_code in {401, 403}
