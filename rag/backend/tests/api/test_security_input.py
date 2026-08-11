"""Workstream C — Input handling, files & classic-injection security tests (DRAFT).

These are the Phase-1 repro/regression drafts for the findings in
`.agent/security-audit/findings/C-input-files.md`. They are written to run in
Phase 2 against the local stack; DO NOT run the whole `backend/tests/api` suite
casually — its session-scoped autouse fixture (conftest.py) wipes BOTH test
users' threads and folders.

Conventions:
- Self-contained: each test acquires its own token via the same Supabase
  password grant used by conftest, and cleans up the resources it creates.
- Resource-heavy / ingestion-touching cases are `@pytest.mark.skip`-marked so
  they never run by accident (RoE: no ingestion-heavy probes — host OOM risk).
- The SSRF refusal test MAY perform one live request (RoE allows a single live
  request, reusing one token).

Run a single test deliberately, e.g.:
    pytest backend/tests/api/test_security_input.py::test_skill_zip_slip_is_rejected
"""
from __future__ import annotations

import io
import os
import uuid
import zipfile

import httpx
import pytest
import pytest_asyncio

API_BASE = os.environ.get("API_BASE_URL", "http://localhost:8001")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://localhost:8000")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

TEST_USER_1 = {
    "email": os.environ.get("TEST_USER1_EMAIL", "test@test.com"),
    "password": os.environ.get("TEST_USER1_PASSWORD", ""),
}

pytestmark = pytest.mark.asyncio


async def _get_token(email: str, password: str) -> str:
    if not password:
        pytest.skip(
            "Test-user password not set — configure TEST_USER1_PASSWORD in "
            "backend/.env (see .env.example)."
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
async def _token() -> str:
    """One token per module — a STRING, not a live client. Holding a module-scoped
    httpx.AsyncClient across pytest-asyncio's function-scoped event loops caused
    'Event loop is closed' teardown flakes (the transport binds to the first test's
    loop). Caching only the token sidesteps that while still avoiding re-login."""
    return await _get_token(**TEST_USER_1)


@pytest_asyncio.fixture
async def client(_token):
    """Fresh authenticated client per test, bound to the test's own event loop,
    reusing the module-cached token (no re-login → no GoTrue rate limit)."""
    async with httpx.AsyncClient(
        base_url=API_BASE,
        headers={"Authorization": f"Bearer {_token}"},
        timeout=30.0,
    ) as c:
        yield c


# Minimal valid SKILL.md (name pattern ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$,
# description >= 20 chars, non-empty instructions).
def _skill_md(name: str) -> str:
    return (
        "---\n"
        f"name: {name}\n"
        "description: A security test skill used by the input-handling audit suite.\n"
        "---\n"
        "# Instructions\n\nDo nothing of consequence.\n"
    )


async def _delete_skill_if_present(client: httpx.AsyncClient, name: str) -> None:
    """Best-effort cleanup: find a skill by name among visible skills and delete it."""
    resp = await client.get("/skills")
    if resp.status_code != 200:
        return
    for s in resp.json():
        if s.get("name") == name and s.get("user_id"):  # only delete own (non-global)
            await client.delete(f"/skills/{s['id']}")


# ---------------------------------------------------------------------------
# C-001 — zip-slip via skill import must not produce traversing filenames/keys
# ---------------------------------------------------------------------------
async def test_skill_zip_slip_is_rejected(client):
    """A .zip whose attached file traverses out of the skill dir must NOT result in
    a stored skill_file whose filename/storage_path escapes the caller's prefix.

    Regression for finding C-001 (FIXED): `ingest_skill` now runs every entry through
    `_safe_skill_relpath`, skipping traversing/backslash/NUL paths before the key build.

    Repro for finding C-001 (skills.py import loop + ingest_skill storage key).
    Expected after fix: traversal entries are normalized/skipped; the created
    skill (if any) has no file whose filename contains '..'.
    """
    skill_name = f"zipslip-{uuid.uuid4().hex[:8]}"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{skill_name}/SKILL.md", _skill_md(skill_name))
        # Malicious attached file: traverses up out of "{skill_name}/".
        zf.writestr(f"{skill_name}/../../pwned-{skill_name}.py", b"print('owned')")
        # A second traversal flavor after prefix-stripping (scripts/ is stripped).
        zf.writestr(f"{skill_name}/scripts/../../../esc-{skill_name}.py", b"x = 1")
    buf.seek(0)

    try:
        resp = await client.post(
            "/skills/import",
            files={"file": ("evil.zip", buf.getvalue(), "application/zip")},
        )
        # Import itself may succeed (the skill is valid); the assertion is on the
        # files that got stored.
        assert resp.status_code in (200, 400), resp.text

        listing = await client.get("/skills")
        assert listing.status_code == 200
        created = next(
            (s for s in listing.json() if s.get("name") == skill_name and s.get("user_id")),
            None,
        )
        if created is None:
            return  # import rejected entirely — acceptable

        files_resp = await client.get(f"/skills/{created['id']}/files")
        assert files_resp.status_code == 200
        for f in files_resp.json():
            assert ".." not in f["filename"], (
                f"zip-slip: stored skill file escaped with filename={f['filename']!r}"
            )
    finally:
        await _delete_skill_if_present(client, skill_name)


# ---------------------------------------------------------------------------
# C-002 — raw multipart filename must not traverse the skill-files storage key
# ---------------------------------------------------------------------------
async def test_skill_file_upload_rejects_traversal_filename(client):
    """POST /skills/{id}/files with a traversal filename must normalize the stored
    filename/storage_path (no '..'). Regression for finding C-002 (FIXED):
    `upload_skill_file` now runs the multipart filename through `_normalize_skill_path`,
    which raises 400 on traversal.
    """
    skill_name = f"upltrav-{uuid.uuid4().hex[:8]}"
    create = await client.post(
        "/skills",
        json={
            "name": skill_name,
            "description": "Security test skill for traversal filename upload check.",
            "instructions": "noop",
        },
    )
    assert create.status_code == 200, create.text
    skill_id = create.json()["id"]
    try:
        resp = await client.post(
            f"/skills/{skill_id}/files",
            files={"file": ("../../pwn.txt", b"data", "text/plain")},
        )
        # After fix: either rejected (400) or stored under a normalized name.
        if resp.status_code == 200:
            assert ".." not in resp.json()["filename"]
            files_resp = await client.get(f"/skills/{skill_id}/files")
            for f in files_resp.json():
                assert ".." not in f["filename"]
        else:
            assert resp.status_code == 400, resp.text
    finally:
        await client.delete(f"/skills/{skill_id}")


# ---------------------------------------------------------------------------
# C-005 / C-006 — workspace path traversal & null byte on the file GET endpoint
# ---------------------------------------------------------------------------
async def test_workspace_get_file_traversal_returns_404(client):
    """GET /threads/{tid}/files/{path:path} with a traversal path must not return
    a foreign file. Documents the (currently safe-by-accident) behavior for C-005.
    """
    # Create a thread to own the workspace.
    t = await client.post("/threads", json={"title": "sec-input ws traversal"})
    assert t.status_code in (200, 201), t.text
    thread_id = t.json()["id"]
    try:
        for path in (
            "..%2f..%2f..%2fetc%2fpasswd",
            "....//....//etc/passwd",
            "uploads/../../secret",
        ):
            r = await client.get(f"/threads/{thread_id}/files/{path}")
            assert r.status_code in (400, 404), (
                f"traversal path {path!r} unexpectedly returned {r.status_code}"
            )
    finally:
        await client.delete(f"/threads/{thread_id}")


async def test_workspace_path_nul_byte_rejected(client):
    """A workspace file_path containing a NUL byte must yield a clean 4xx, not a 500
    or a persisted row. Regression guard for C-006 (plan-26 fix is content-only).
    """
    t = await client.post("/threads", json={"title": "sec-input ws nul"})
    assert t.status_code in (200, 201), t.text
    thread_id = t.json()["id"]
    try:
        # %00 in the path segment.
        r = await client.get(f"/threads/{thread_id}/files/uploads%2Ffile%00.txt")
        assert r.status_code in (400, 404), r.status_code
        assert r.status_code != 500, "NUL in path surfaced as a 500 (unsanitized)"
    finally:
        await client.delete(f"/threads/{thread_id}")


# ---------------------------------------------------------------------------
# C-007 / Check 5 — ILIKE / search special chars must return safely (no 500, no
# filter-syntax injection). Covers documents + threads search escaping.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "needle",
    [
        "100%",            # ILIKE wildcard
        "a_b",             # ILIKE single-char wildcard
        "x,y)",            # PostgREST or()/filter delimiters
        "'; DROP TABLE--",  # classic SQLi probe
        ").or.(user_id.eq.00000000-0000-0000-0000-000000000000",  # PostgREST inj probe
        "\\",
    ],
)
async def test_search_special_chars_safe(client, needle):
    """Search endpoints must treat metacharacters literally and never 500 / leak.

    Asserts the documents and threads search endpoints return 200 with a
    well-formed payload for adversarial inputs (escaping verified at
    documents.py:321 and threads.py:145).
    """
    r1 = await client.get("/documents/search", params={"q": needle})
    assert r1.status_code == 200, f"/documents/search 500'd on {needle!r}: {r1.text}"
    body1 = r1.json()
    assert "documents" in body1 and isinstance(body1["documents"], list)

    r2 = await client.get("/threads", params={"search": needle, "limit": 5})
    assert r2.status_code == 200, f"/threads search 500'd on {needle!r}: {r2.text}"
    body2 = r2.json()
    assert "threads" in body2 and isinstance(body2["threads"], list)


# ---------------------------------------------------------------------------
# C-009 / Check 6 — SSRF: import-from-url must refuse internal/metadata targets.
# This is the one test allowed to make a live request (RoE).
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "source",
    [
        "http://localhost:8001/bridge/health",   # the backend itself (would chain → /bridge/*)
        "http://169.254.169.254/",               # cloud metadata
        "http://localhost:8000/rest/v1/skills",  # Kong/Supabase
        "http://127.0.0.1:8002/",                # sandbox bridge port
        "file:///etc/passwd",
    ],
)
async def test_import_from_url_refuses_internal_targets(client, source):
    """POST /skills/import-from-url must reject non-GitHub/non-skills.sh sources.

    These all fail source parsing (not a github.com / skills.sh URL and not a bare
    owner/repo), so the backend never issues an outbound request to them — the URL
    host is always server-constructed as api.github.com (skill_source.py:167).
    Expected: 400 (bad source); never a 2xx, never a proxied internal response.
    """
    resp = await client.post("/skills/import-from-url", json={"source": source})
    assert resp.status_code == 400, (
        f"import-from-url did not refuse internal target {source!r}: "
        f"{resp.status_code} {resp.text[:300]}"
    )
    # Must not have imported anything.
    body = resp.json()
    assert "imported" not in body or body.get("imported", 0) == 0


# ---------------------------------------------------------------------------
# C-003 — oversize upload rejected. Resource-heavy → skipped by default.
# ---------------------------------------------------------------------------
@pytest.mark.skip(reason="Resource-heavy (51MB body); enable deliberately in Phase 2")
async def test_oversize_document_rejected_400(client):
    """A >50MB document upload must be rejected with 400.

    NOTE: this currently passes only AFTER the whole body is buffered in RAM
    (finding C-003). Enable manually; do not run alongside other workstreams.
    """
    big = b"\x00" * (51 * 1024 * 1024)
    resp = await client.post(
        "/documents/upload",
        files={"file": ("big.txt", big, "text/plain")},
    )
    assert resp.status_code == 400
    assert "too large" in resp.text.lower()


# ---------------------------------------------------------------------------
# C-010 — polyglot/active-content upload must not be served as active type.
# Touches ingestion (document upload triggers background processing) → skip by
# default to honor the no-ingestion-probe rule. The workspace variant (no Docling)
# is the safer live check in Phase 2.
# ---------------------------------------------------------------------------
@pytest.mark.skip(reason="Triggers ingestion; verify the workspace serve-path neutralization in Phase 2")
async def test_html_polyglot_uploaded_as_txt_not_served_active(client):
    """An .html payload uploaded as .txt must never come back with an active
    (script-bearing) content type. Asserts the workspace serve path downgrades
    HTML/SVG/XML to text/plain + nosniff (workspace.py:_safe_inline_media_type).
    """
    t = await client.post("/threads", json={"title": "sec-input polyglot"})
    thread_id = t.json()["id"]
    try:
        payload = b"<script>alert(1)</script><html>hi</html>"
        up = await client.post(
            f"/threads/{thread_id}/files/upload",
            files={"file": ("note.txt", payload, "text/plain")},
        )
        assert up.status_code == 201, up.text
        got = await client.get(f"/threads/{thread_id}/files/uploads/note.txt")
        ctype = got.headers.get("content-type", "")
        assert "text/html" not in ctype
        assert got.headers.get("x-content-type-options") == "nosniff"
    finally:
        await client.delete(f"/threads/{thread_id}")


# ---------------------------------------------------------------------------
# C-004 — per-user ingestion quota. Placeholder for intended future behavior.
# ---------------------------------------------------------------------------
@pytest.mark.skip(reason="Ingestion-heavy + asserts not-yet-implemented quota (finding C-004)")
async def test_no_per_user_upload_quota_documented(client):
    """Placeholder: after C-004 is fixed, queuing more than the per-user document
    limit should return 429/400. Currently there is no such limit (the gap is the
    finding). Kept skip-marked so it never queues ingestion work.
    """
    pytest.xfail("Per-user ingestion quota not implemented (finding C-004)")
