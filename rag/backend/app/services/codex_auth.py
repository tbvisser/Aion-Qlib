"""Codex (Sign in with ChatGPT) credential lifecycle.

Reads the OAuth tokens that the official `codex login` writes to
``~/.codex/auth.json`` and keeps the access token fresh. We deliberately do NOT
implement the browser/PKCE sign-in flow here — the Codex CLI owns that and is
maintained by OpenAI. This module only consumes and refreshes the cached tokens.

auth.json shape (file-based credential store):

    {
      "auth_mode": "chatgpt",
      "OPENAI_API_KEY": null,
      "tokens": {
        "id_token": "<jwt>",
        "access_token": "<jwt>",
        "refresh_token": "<opaque>",
        "account_id": "<chatgpt account id>"
      },
      "last_refresh": "2026-..."
    }

The access token is a short-lived JWT; we refresh it via the OAuth token
endpoint using the refresh token. Refreshes are serialized with an asyncio lock
and written back atomically so concurrent agent/sub-agent calls don't stampede
or corrupt the file.

NOTE: the Codex backend is an undocumented endpoint and these mechanics are
reverse-engineered; they can change without notice.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# OpenAI's public OAuth client id for the Codex CLI, and the token endpoint used
# to exchange a refresh token for a fresh access token.
CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"

# Refresh proactively when the access token has less than this many seconds left.
_REFRESH_SKEW_SECONDS = 60


class CodexAuthError(RuntimeError):
    """Raised when Codex credentials are missing, malformed, or unrefreshable."""


def _default_auth_path() -> Path:
    """Resolve the auth.json path: CODEX_HOME setting -> $CODEX_HOME -> ~/.codex."""
    # Imported lazily so this module stays importable without app config loaded.
    try:
        from app.config import get_settings

        configured = (get_settings().codex_home or "").strip()
    except Exception:  # pragma: no cover - config not available
        configured = ""
    home = configured or os.environ.get("CODEX_HOME") or os.path.join(
        os.path.expanduser("~"), ".codex"
    )
    return Path(home) / "auth.json"


def _decode_jwt_claims(token: str) -> dict[str, Any]:
    """Decode a JWT payload WITHOUT signature verification (we only read claims)."""
    if not token or token.count(".") < 2:
        return {}
    payload_b64 = token.split(".")[1]
    # Restore base64url padding.
    payload_b64 += "=" * (-len(payload_b64) % 4)
    try:
        raw = base64.urlsafe_b64decode(payload_b64.encode("ascii"))
        claims = json.loads(raw)
        return claims if isinstance(claims, dict) else {}
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return {}


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CodexAuth:
    """Reads and refreshes Codex credentials from a single auth.json file."""

    def __init__(
        self,
        auth_path: Path | None = None,
        *,
        token_url: str = CODEX_TOKEN_URL,
        client_id: str = CODEX_CLIENT_ID,
    ) -> None:
        self._auth_path = Path(auth_path) if auth_path else _default_auth_path()
        self._token_url = token_url
        self._client_id = client_id
        self._lock = asyncio.Lock()

    # -- file IO ------------------------------------------------------------
    def _read(self) -> dict[str, Any]:
        if not self._auth_path.exists():
            raise CodexAuthError(
                f"Codex credentials not found at {self._auth_path}. "
                "Install the Codex CLI (npm i -g @openai/codex) and run `codex login`."
            )
        try:
            data = json.loads(self._auth_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise CodexAuthError(
                f"Could not read Codex credentials at {self._auth_path}: {e}. "
                "Re-run `codex login`."
            ) from e
        if not isinstance(data, dict):
            raise CodexAuthError(f"Malformed Codex auth.json at {self._auth_path}.")
        return data

    def _write(self, data: dict[str, Any]) -> None:
        """Atomically replace auth.json (temp file + os.replace on same dir).

        The temp file is created with 0600 perms so the refreshed OAuth tokens
        never become group/world-readable on POSIX multi-user hosts: os.replace
        preserves the temp file's mode, not the destination's. (No-op on Windows.)
        """
        tmp = self._auth_path.parent / (self._auth_path.name + ".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps(data, indent=2))
            os.chmod(tmp, 0o600)  # also tightens a pre-existing stale .tmp
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        os.replace(tmp, self._auth_path)

    # -- claims -------------------------------------------------------------
    def account_id(self) -> str | None:
        """ChatGPT account id, sent as the ChatGPT-Account-ID header.

        Prefer the explicit ``tokens.account_id`` written by recent codex; fall
        back to the namespaced claim inside the id_token JWT.
        """
        tokens = self._read().get("tokens") or {}
        direct = tokens.get("account_id")
        if direct:
            return direct
        claims = _decode_jwt_claims(tokens.get("id_token") or "")
        auth_claim = claims.get("https://api.openai.com/auth") or {}
        if isinstance(auth_claim, dict):
            return auth_claim.get("chatgpt_account_id")
        return None

    @staticmethod
    def _access_token_expiry(access_token: str) -> float | None:
        exp = _decode_jwt_claims(access_token).get("exp")
        if isinstance(exp, (int, float)):
            return float(exp)
        return None

    # -- token acquisition --------------------------------------------------
    async def get_access_token(self, *, force_refresh: bool = False) -> str:
        """Return a valid access token, refreshing if expired or forced.

        ``force_refresh=True`` is used by the client on a 401 to recover from a
        token that expired between the proactive check and the API call.
        """
        async with self._lock:
            data = self._read()
            tokens = data.get("tokens") or {}
            access = tokens.get("access_token")
            refresh = tokens.get("refresh_token")

            if not force_refresh and access:
                exp = self._access_token_expiry(access)
                # exp is None when unparseable — assume valid and let a real 401
                # trigger a reactive refresh rather than refreshing every call.
                if exp is None or (exp - time.time()) > _REFRESH_SKEW_SECONDS:
                    return access

            if not refresh:
                if access and not force_refresh:
                    return access
                raise CodexAuthError(
                    f"No refresh_token in {self._auth_path}; run `codex login`."
                )

            data = await self._refresh(data)
            new_access = (data.get("tokens") or {}).get("access_token")
            if not new_access:
                raise CodexAuthError("Codex token refresh returned no access_token.")
            return new_access

    async def _refresh(self, data: dict[str, Any]) -> dict[str, Any]:
        tokens = data.get("tokens") or {}
        refresh_token = tokens.get("refresh_token")
        payload = {
            "client_id": self._client_id,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": "openid profile email",
        }
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    self._token_url,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                )
        except httpx.HTTPError as e:
            raise CodexAuthError(f"Codex token refresh request failed: {e}") from e

        if resp.status_code != 200:
            raise CodexAuthError(
                f"Codex token refresh failed ({resp.status_code}). "
                f"Run `codex login` to re-authenticate. {resp.text[:200]}"
            )

        body = resp.json()
        if body.get("access_token"):
            tokens["access_token"] = body["access_token"]
        # Refresh tokens may be rotated; id_token may be reissued.
        if body.get("refresh_token"):
            tokens["refresh_token"] = body["refresh_token"]
        if body.get("id_token"):
            tokens["id_token"] = body["id_token"]
        data["tokens"] = tokens
        data["last_refresh"] = _utcnow_iso()
        self._write(data)
        logger.info("Refreshed Codex access token (%s)", self._auth_path)
        return data


# Module-level singleton so the refresh lock is shared across all callers.
_instance: CodexAuth | None = None


def get_codex_auth() -> CodexAuth:
    global _instance
    if _instance is None:
        _instance = CodexAuth()
    return _instance


def reset_codex_auth() -> None:
    """Test/seam helper to drop the cached singleton."""
    global _instance
    _instance = None
