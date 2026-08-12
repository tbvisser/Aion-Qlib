import time

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from postgrest.exceptions import APIError
from pydantic import BaseModel

from app.config import get_settings
from app.db.supabase import get_supabase_client

security = HTTPBearer()

# Asymmetric algorithms accepted when verifying via the Supabase JWKS endpoint.
# HS256 is handled separately with the shared secret, so a token can't downgrade
# from asymmetric to HMAC-with-the-public-key (the classic alg-confusion attack).
_ASYMMETRIC_ALGS = {"ES256", "ES384", "ES512", "RS256", "RS384", "RS512"}
_JWKS_TTL_SECONDS = 600
_jwks_cache: dict = {"keys": None, "fetched_at": 0.0}


def _fetch_jwks(force: bool = False) -> list[dict]:
    """Fetch and cache the Supabase JWKS used to verify asymmetric tokens."""
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
        # Signing key may have rotated since we cached — refresh once.
        key = next((k for k in _fetch_jwks(force=True) if k.get("kid") == kid), None)
    return key


def _decode_supabase_jwt(token: str) -> dict:
    """Verify a Supabase access token's signature, audience, and expiry.

    This deployment signs tokens with asymmetric keys (ES256/RS*) published at the
    JWKS endpoint, so we verify ONLY against those. We deliberately do not accept
    HS256: a symmetric-secret branch is a second, weaker trust anchor — anyone holding
    SUPABASE_JWT_SECRET could forge a token for any user — that the real IdP never uses
    for signing (finding A-001). The accepted algorithm set is pinned to
    _ASYMMETRIC_ALGS and is never derived from the attacker-controlled token header.
    """
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token: {e}"
        )

    alg = header.get("alg")
    if alg not in _ASYMMETRIC_ALGS:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: unsupported algorithm {alg!r}",
        )

    try:
        key = _jwk_for_kid(header.get("kid"))
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Could not fetch token verification keys: {e}",
        )
    if key is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token: no matching signing key",
        )

    try:
        return jwt.decode(
            token, key, algorithms=sorted(_ASYMMETRIC_ALGS), audience="authenticated"
        )
    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token: {e}"
        )


class User(BaseModel):
    id: str
    email: str | None = None
    is_admin: bool = False


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> User:
    """Verify Supabase JWT token and extract user info, including admin status."""
    payload = _decode_supabase_jwt(credentials.credentials)

    user_id = payload.get("sub")
    email = payload.get("email")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token: missing user ID",
        )

    # Query user_profiles for admin status
    supabase = get_supabase_client()
    is_admin = False
    try:
        profile_result = supabase.table("user_profiles").select("is_admin").eq(
            "user_id", user_id
        ).maybe_single().execute()
        if profile_result and profile_result.data:
            is_admin = profile_result.data.get("is_admin", False)
    except APIError as e:
        # Handle 204 No Content - user has no profile entry yet
        if e.code != "204":
            raise

    return User(id=user_id, email=email, is_admin=is_admin)


async def get_admin_user(
    current_user: User = Depends(get_current_user)
) -> User:
    """Require the current user to be an admin."""
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required"
        )
    return current_user
