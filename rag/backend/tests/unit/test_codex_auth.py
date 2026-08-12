"""Unit tests for Codex credential read/refresh (plan 12, task 2)."""
import base64
import json
import time

import httpx
import pytest

from app.services import codex_auth
from app.services.codex_auth import CodexAuth, CodexAuthError


def _b64url(d: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()


def _jwt(payload: dict) -> str:
    return f"{_b64url({'alg': 'none'})}.{_b64url(payload)}.sig"


def _write_auth(tmp_path, tokens: dict, **extra):
    p = tmp_path / "auth.json"
    p.write_text(json.dumps({"auth_mode": "chatgpt", "tokens": tokens, **extra}))
    return p


# --- fake httpx so refresh never hits the network ---------------------------
class _FakeResp:
    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data or {}
        self.text = text

    def json(self):
        return self._json


class _FakeClient:
    def __init__(self, resp, captured):
        self._resp = resp
        self._captured = captured

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None, headers=None):
        self._captured["url"] = url
        self._captured["json"] = json
        return self._resp


def _patch_httpx(monkeypatch, resp, captured):
    monkeypatch.setattr(
        codex_auth.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp, captured)
    )


def test_account_id_prefers_direct_field(tmp_path):
    p = _write_auth(tmp_path, {"access_token": "a", "account_id": "acct-123"})
    assert CodexAuth(p).account_id() == "acct-123"


def test_account_id_falls_back_to_id_token_claim(tmp_path):
    id_token = _jwt({"https://api.openai.com/auth": {"chatgpt_account_id": "acct-jwt"}})
    p = _write_auth(tmp_path, {"access_token": "a", "id_token": id_token})
    assert CodexAuth(p).account_id() == "acct-jwt"


async def test_returns_valid_token_without_network(tmp_path, monkeypatch):
    access = _jwt({"exp": time.time() + 3600})
    p = _write_auth(tmp_path, {"access_token": access, "refresh_token": "r"})

    def _boom(*a, **k):
        raise AssertionError("refresh must not be called for a valid token")

    monkeypatch.setattr(codex_auth.httpx, "AsyncClient", _boom)
    assert await CodexAuth(p).get_access_token() == access


async def test_refreshes_expired_token(tmp_path, monkeypatch):
    expired = _jwt({"exp": time.time() - 10})
    p = _write_auth(tmp_path, {"access_token": expired, "refresh_token": "r-old"})
    new_access = _jwt({"exp": time.time() + 3600})
    captured: dict = {}
    _patch_httpx(
        monkeypatch,
        _FakeResp(200, {"access_token": new_access, "refresh_token": "r-new"}),
        captured,
    )

    token = await CodexAuth(p).get_access_token()

    assert token == new_access
    # Refresh request was well-formed.
    assert captured["json"]["grant_type"] == "refresh_token"
    assert captured["json"]["client_id"] == codex_auth.CODEX_CLIENT_ID
    assert captured["json"]["refresh_token"] == "r-old"
    # File was updated atomically with rotated tokens + last_refresh.
    on_disk = json.loads(p.read_text())
    assert on_disk["tokens"]["access_token"] == new_access
    assert on_disk["tokens"]["refresh_token"] == "r-new"
    assert "last_refresh" in on_disk


async def test_force_refresh_even_when_valid(tmp_path, monkeypatch):
    access = _jwt({"exp": time.time() + 3600})
    p = _write_auth(tmp_path, {"access_token": access, "refresh_token": "r"})
    new_access = _jwt({"exp": time.time() + 7200})
    _patch_httpx(monkeypatch, _FakeResp(200, {"access_token": new_access}), {})
    assert await CodexAuth(p).get_access_token(force_refresh=True) == new_access


async def test_refresh_failure_raises(tmp_path, monkeypatch):
    expired = _jwt({"exp": time.time() - 10})
    p = _write_auth(tmp_path, {"access_token": expired, "refresh_token": "r"})
    _patch_httpx(monkeypatch, _FakeResp(400, {}, text="invalid_grant"), {})
    with pytest.raises(CodexAuthError):
        await CodexAuth(p).get_access_token()


async def test_missing_file_raises(tmp_path):
    with pytest.raises(CodexAuthError):
        await CodexAuth(tmp_path / "nope.json").get_access_token()
