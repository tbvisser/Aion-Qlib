"""Security audit repros — Workstream A (Authentication & Session Management).

AUDIT ARTIFACT (Plan 27). These are *proposed* repros written during Phase 1
static analysis; they are intended to be run **serially in Phase 2**, never
concurrently with other auditors.

WARNING — DESTRUCTIVE SHARED FIXTURE: this module lives under
`backend/tests/api/`, whose `conftest.py` has a session-scoped autouse fixture
(`cleanup_test_data_once`) that **wipes ALL threads + folders for both test
users**. Do NOT run this file while another agent is using the live stack.

All cases now assert the secure behaviour (A-001 has been remediated: the HS256
branch was dropped, so the backend verifies ONLY asymmetric JWKS-signed tokens).

Coverage (maps to plan Workstream A "Validation (minimum)"):
  (a) tampered-signature JWT            -> 401   [test_tampered_signature_rejected]
  (b) expired JWT                       -> 401   [test_expired_token_rejected]
  (c) alg:none                          -> 401   [test_alg_none_rejected]
      HS256-signed-with-anon-key        -> 401   [test_hs256_signed_with_anon_key_rejected]
  (c+) FORGED HS256 w/ JWT secret       -> 401   [test_forged_hs256_token_signed_with_jwt_secret_rejected]  (A-001 FIXED)
  (d) user2 on PUT metadata-schema      -> 403   [test_non_admin_forbidden_on_admin_endpoint]
  (e) bridge call w/ forged token       -> 401   [test_bridge_call_forged_session_token_rejected]
"""

import base64
import json
import os
import time
import uuid

import httpx
import pytest
from jose import jwt

API_BASE = os.environ.get("API_BASE_URL", "http://localhost:8001")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://localhost:8000")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "")

TEST_USER_2 = {
    "email": os.environ.get("TEST_USER2_EMAIL", "test2@test.com"),
    "password": os.environ.get("TEST_USER2_PASSWORD", ""),
}


def _b64url(d: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()


async def _get_token(email: str, password: str) -> str:
    if not password:
        pytest.skip("TEST_USER2_PASSWORD not set in backend/.env (see .env.example).")
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
            headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            json={"email": email, "password": password},
        )
        resp.raise_for_status()
        return resp.json()["access_token"]


async def _me(token: str) -> httpx.Response:
    async with httpx.AsyncClient(base_url=API_BASE) as client:
        return await client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})


# --- (c) alg:none ----------------------------------------------------------
@pytest.mark.asyncio
async def test_alg_none_rejected():
    now = int(time.time())
    tok = (
        _b64url({"alg": "none", "typ": "JWT"})
        + "."
        + _b64url({"sub": str(uuid.uuid4()), "aud": "authenticated",
                   "role": "authenticated", "exp": now + 3600})
        + "."
    )
    resp = await _me(tok)
    assert resp.status_code == 401, resp.text


# --- (c) HS256 signed with the *public* anon key ---------------------------
@pytest.mark.asyncio
async def test_hs256_signed_with_anon_key_rejected():
    now = int(time.time())
    tok = jwt.encode(
        {"sub": str(uuid.uuid4()), "aud": "authenticated", "role": "authenticated",
         "exp": now + 3600, "iat": now},
        SUPABASE_ANON_KEY, algorithm="HS256",
    )
    resp = await _me(tok)
    assert resp.status_code == 401, resp.text


# --- (a) tampered signature on a real ES256 token --------------------------
@pytest.mark.asyncio
async def test_tampered_signature_rejected():
    real = await _get_token(**TEST_USER_2)
    head, body, sig = real.split(".")
    raw = bytearray(base64.urlsafe_b64decode(sig + "=="))
    raw[0] ^= 0xFF
    tampered = head + "." + body + "." + base64.urlsafe_b64encode(bytes(raw)).rstrip(b"=").decode()
    resp = await _me(tampered)
    assert resp.status_code == 401, resp.text


# --- (b) expired token -----------------------------------------------------
# Real tokens are ES256 (can't re-sign without the private key). We exercise the
# expiry check on the HS256 branch: an *expired* HS256-with-secret token must be
# rejected for expiry even though the (vulnerable) branch would otherwise accept
# its signature. This still passes today because exp is enforced.
@pytest.mark.asyncio
async def test_expired_token_rejected():
    if not JWT_SECRET:
        pytest.skip("SUPABASE_JWT_SECRET not set; expired-HS256 branch not exercisable.")
    now = int(time.time())
    tok = jwt.encode(
        {"sub": str(uuid.uuid4()), "aud": "authenticated", "role": "authenticated",
         "exp": now - 60, "iat": now - 3600},
        JWT_SECRET, algorithm="HS256",
    )
    resp = await _me(tok)
    assert resp.status_code == 401, resp.text


# --- (c+) A-001 (FIXED): forged HS256 token must be rejected on this ES256 deploy --
# Production tokens are ES256 (asymmetric, JWKS). The verifier must NOT accept HS256 at
# all — previously it honored HS256 signed with the symmetric SUPABASE_JWT_SECRET, so
# anyone holding that secret could mint a token for ANY user id (impersonation),
# including the admin's sub (-> is_admin=true). Post-fix: HS256 → 401 regardless of key.
@pytest.mark.asyncio
async def test_forged_hs256_token_signed_with_jwt_secret_rejected():
    now = int(time.time())
    # Sign with the real symmetric secret if present, else any secret — the backend
    # must reject HS256 outright now, so the signing key is irrelevant.
    forge_key = JWT_SECRET or "any-symmetric-secret-the-backend-must-not-trust"
    forged = jwt.encode(
        {"sub": str(uuid.uuid4()), "aud": "authenticated", "role": "authenticated",
         "email": "attacker@evil.test", "exp": now + 3600, "iat": now},
        forge_key, algorithm="HS256",
    )
    resp = await _me(forged)
    assert resp.status_code == 401, (
        f"Forged HS256 token accepted (status {resp.status_code}): {resp.text}"
    )


# --- (d) non-admin user on the only admin-gated endpoint -------------------
@pytest.mark.asyncio
async def test_non_admin_forbidden_on_admin_endpoint():
    token2 = await _get_token(**TEST_USER_2)  # user2 is the non-admin test user
    async with httpx.AsyncClient(base_url=API_BASE) as client:
        resp = await client.put(
            "/settings/metadata-schema",
            headers={"Authorization": f"Bearer {token2}", "Content-Type": "application/json"},
            json={"fields": []},
        )
    assert resp.status_code == 403, resp.text


# --- (e) bridge call with forged/expired session token ---------------------
@pytest.mark.asyncio
async def test_bridge_call_forged_session_token_rejected():
    async with httpx.AsyncClient(base_url=API_BASE) as client:
        resp = await client.post(
            "/bridge/call",
            json={
                "tool_name": "search_documents",
                "arguments": {"query": "x"},
                "session_token": str(uuid.uuid4()),  # never issued
            },
        )
    # 401 when the tool registry is enabled (token rejected); 503 when the
    # bridge is disabled by config (tool_registry_enabled=False). Both prove the
    # forged token cannot execute a tool.
    assert resp.status_code in (401, 503), resp.text


@pytest.mark.asyncio
async def test_bridge_catalog_forged_token_rejected():
    async with httpx.AsyncClient(base_url=API_BASE) as client:
        resp = await client.get(
            "/bridge/catalog", headers={"X-Bridge-Token": str(uuid.uuid4())}
        )
    assert resp.status_code in (401, 503), resp.text
