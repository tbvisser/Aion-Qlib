"""User-scoped MCP token mint and verify."""
from __future__ import annotations

import time

import pytest

from webapp.api.auth import Principal
from webapp.api.mcp_user_token import mint_user_token, verify_user_token


@pytest.fixture
def principal():
    return Principal(
        user_id="11111111-1111-1111-1111-111111111111",
        email="u@example.com",
        org_id="22222222-2222-2222-2222-222222222222",
        org_role="owner",
    )


def test_mint_and_verify_roundtrip(principal):
    token, exp = mint_user_token(principal, service_token="shared-secret")
    claims = verify_user_token(token, service_token="shared-secret")
    assert claims is not None
    assert claims.user_id == principal.user_id
    assert claims.org_id == principal.org_id
    assert claims.exp == exp


def test_wrong_secret_rejected(principal):
    token, _ = mint_user_token(principal, service_token="shared-secret")
    assert verify_user_token(token, service_token="other") is None


def test_expired_token_rejected(principal, monkeypatch):
    fixed = 1_700_000_000
    monkeypatch.setattr(time, "time", lambda: fixed)
    token, _ = mint_user_token(principal, service_token="secret", ttl_seconds=60)
    monkeypatch.setattr(time, "time", lambda: fixed + 7200)
    assert verify_user_token(token, service_token="secret") is None
