"""Supabase identity for the qlib API.

The browser already holds a Supabase session -- it is what gates the SPA and
what the RAG backend authenticates with. This module makes the qlib half of the
platform trust the same tokens, so one login covers both and there is exactly
one identity model rather than two.

The verification logic is deliberately a close port of
``rag/backend/app/dependencies.py``. Two implementations of JWT checking that
drift apart is how one of them ends up weaker than the other, so where this
differs from that file it is only in what it returns, never in what it accepts.

On top of the user it resolves an *organisation*, because ownership here is
two-level: a row belongs to a person, and is scoped to the org that person was
acting in. That pairing is what ``aion``'s row level security policies read.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import httpx
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from .config import get_settings
from .db import DatabaseNotConfigured, user_tx

log = logging.getLogger(__name__)

security = HTTPBearer()

# Asymmetric algorithms accepted when verifying against the Supabase JWKS.
# HS256 is deliberately absent. Supabase signs with an asymmetric key, so a
# symmetric branch would add a second and weaker trust anchor the real issuer
# never uses: anyone holding SUPABASE_JWT_SECRET could mint a token for any
# user. The accepted set is pinned here and never read from the token header,
# which is attacker-controlled.
_ASYMMETRIC_ALGS = {"ES256", "ES384", "ES512", "RS256", "RS384", "RS512"}
_JWKS_TTL_SECONDS = 600
_jwks_cache: dict = {"keys": None, "fetched_at": 0.0}


def _fetch_jwks(force: bool = False) -> list[dict]:
    settings = get_settings()
    now = time.monotonic()
    if (
        not force
        and _jwks_cache["keys"] is not None
        and (now - _jwks_cache["fetched_at"]) < _JWKS_TTL_SECONDS
    ):
        return _jwks_cache["keys"]
    url = f"{settings.supabase_url}/auth/v1/.well-known/jwks.json"
    resp = httpx.get(url, headers={"apikey": settings.supabase_anon_key}, timeout=10)
    resp.raise_for_status()
    keys = resp.json().get("keys", [])
    _jwks_cache["keys"] = keys
    _jwks_cache["fetched_at"] = now
    return keys


def _jwk_for_kid(kid: str | None) -> dict | None:
    key = next((k for k in _fetch_jwks() if k.get("kid") == kid), None)
    if key is None:
        # The signing key may have rotated since we cached -- refresh once
        # before calling the token unverifiable.
        key = next((k for k in _fetch_jwks(force=True) if k.get("kid") == kid), None)
    return key


def _decode(token: str) -> dict:
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid token: {exc}")

    alg = header.get("alg")
    if alg not in _ASYMMETRIC_ALGS:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            f"Invalid token: unsupported algorithm {alg!r}",
        )

    try:
        key = _jwk_for_kid(header.get("kid"))
    except httpx.HTTPError as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            f"Could not fetch token verification keys: {exc}",
        )
    if key is None:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Invalid token: no matching signing key"
        )

    try:
        return jwt.decode(
            token, key, algorithms=sorted(_ASYMMETRIC_ALGS), audience="authenticated"
        )
    except JWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"Invalid token: {exc}")


@dataclass(frozen=True)
class Principal:
    """Who is asking, and on whose behalf.

    ``org_id`` is not decoration: every row in the ``aion`` schema carries one,
    and it decides which colleagues a shared item reaches.
    """

    user_id: str
    email: str | None
    org_id: str
    org_role: str

    @property
    def is_org_admin(self) -> bool:
        return self.org_role in ("owner", "admin")


def _resolve_org(user_id: str, requested: str | None) -> tuple[str, str]:
    """Pick the org this request acts in, and the caller's role in it.

    Runs under the caller's own RLS context on purpose. ``org_members`` is only
    selectable by fellow members, so an ``X-Aion-Org`` naming an org the caller
    does not belong to simply returns no row -- membership is checked by the
    database rather than by a comparison this function could get wrong.
    """
    with user_tx(user_id) as cur:
        if requested:
            cur.execute(
                "SELECT org_id, role FROM public.org_members "
                "WHERE org_id = %s AND user_id = %s",
                (requested, user_id),
            )
            row = cur.fetchone()
            if row is None:
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN,
                    "You are not a member of the requested organisation.",
                )
            return str(row["org_id"]), row["role"]

        cur.execute(
            "SELECT m.org_id, m.role FROM public.org_members m "
            "JOIN public.user_profiles p ON p.user_id = m.user_id "
            "WHERE m.user_id = %s AND m.org_id = p.default_org_id",
            (user_id,),
        )
        row = cur.fetchone()
        if row is not None:
            return str(row["org_id"]), row["role"]

        # No default set (or it points at an org they have since left). Fall
        # back to the oldest membership rather than failing the request -- the
        # signup trigger guarantees at least one exists.
        cur.execute(
            "SELECT org_id, role FROM public.org_members "
            "WHERE user_id = %s ORDER BY created_at LIMIT 1",
            (user_id,),
        )
        row = cur.fetchone()
        if row is None:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "This account belongs to no organisation, so it has nowhere to "
                "store work. An administrator needs to invite it to one.",
            )
        return str(row["org_id"]), row["role"]


async def get_principal(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    x_aion_org: str | None = Header(default=None, alias="X-Aion-Org"),
) -> Principal:
    payload = _decode(credentials.credentials)

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Invalid token: missing user ID"
        )

    try:
        org_id, org_role = _resolve_org(user_id, x_aion_org)
    except DatabaseNotConfigured as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))

    return Principal(
        user_id=user_id,
        email=payload.get("email"),
        org_id=org_id,
        org_role=org_role,
    )


async def require_org_admin(
    principal: Principal = Depends(get_principal),
) -> Principal:
    """Gate for operations that rewrite shared state.

    The data refresh, macro refresh and catalog reindex all rebuild stores that
    every member reads. They are infrastructure operations wearing the clothes
    of ordinary endpoints, so they are restricted rather than merely audited.
    """
    if not principal.is_org_admin:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "This rebuilds data shared by everyone in the organisation, so it "
            "is restricted to organisation admins.",
        )
    return principal
