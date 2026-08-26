"""Short-lived HMAC tokens so MCP hosts can act as a specific Aion user.

Hermes (and other external MCP clients) normally authenticate with the shared
``AION_MCP_TOKEN`` and inherit the configured service user. An authenticated
Aion user can mint a scoped token via ``POST /api/hermes/mcp-token`` and pass
it as ``Authorization: Bearer …`` to ``aion-mcp`` instead — DB-backed tools
then run under that user's RLS context.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass

from .auth import Principal

_PREFIX = "aionmcp."
_DEFAULT_TTL_SECONDS = 3600


@dataclass(frozen=True)
class McpUserClaims:
    user_id: str
    org_id: str
    exp: int


def _secret(service_token: str, dedicated: str) -> bytes:
    raw = (dedicated or service_token or "").strip()
    if not raw:
        raise ValueError("AION_MCP_TOKEN (or AION_MCP_USER_TOKEN_SECRET) is required to mint MCP user tokens")
    return raw.encode("utf-8")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def mint_user_token(
    principal: Principal,
    *,
    service_token: str,
    dedicated_secret: str = "",
    ttl_seconds: int = _DEFAULT_TTL_SECONDS,
) -> tuple[str, int]:
    """Return ``(token, expires_at_unix)``."""
    exp = int(time.time()) + ttl_seconds
    payload = {"sub": principal.user_id, "org": principal.org_id, "exp": exp}
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = hmac.new(_secret(service_token, dedicated_secret), body, hashlib.sha256).digest()
    token = f"{_PREFIX}{_b64url(body)}.{_b64url(sig)}"
    return token, exp


def verify_user_token(
    token: str,
    *,
    service_token: str,
    dedicated_secret: str = "",
) -> McpUserClaims | None:
    if not token.startswith(_PREFIX):
        return None
    rest = token[len(_PREFIX):]
    if "." not in rest:
        return None
    body_b64, sig_b64 = rest.rsplit(".", 1)
    try:
        body = _b64url_decode(body_b64)
        sig = _b64url_decode(sig_b64)
    except (ValueError, json.JSONDecodeError):
        return None
    expected = hmac.new(_secret(service_token, dedicated_secret), body, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return None
    user_id = payload.get("sub")
    org_id = payload.get("org")
    exp = payload.get("exp")
    if not isinstance(user_id, str) or not isinstance(org_id, str) or not isinstance(exp, int):
        return None
    if exp < int(time.time()):
        return None
    return McpUserClaims(user_id=user_id, org_id=org_id, exp=exp)


def claims_to_principal(claims: McpUserClaims) -> Principal:
    return Principal(
        user_id=claims.user_id,
        email=None,
        org_id=claims.org_id,
        org_role="owner",
    )
