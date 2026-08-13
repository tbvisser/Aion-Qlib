"""Small, httpx-based client for Supabase Storage.

The webapp already depends on httpx and already reads SUPABASE_SERVICE_ROLE_KEY
for admin-like operations. This avoids pulling in the Supabase Python client just
to upload a file and mint a signed URL.
"""
from __future__ import annotations

import urllib.parse
from pathlib import Path

import httpx

from .config import get_settings

_StoragePath = str | Path


def _base_url() -> str:
    settings = get_settings()
    return settings.supabase_url.rstrip("/") + "/storage/v1"


def _service_headers(content_type: str | None = None) -> dict[str, str]:
    settings = get_settings()
    key = settings.supabase_service_role_key
    if not key:
        raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY is not configured")
    headers: dict[str, str] = {"Authorization": f"Bearer {key}"}
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _encode_path(path: _StoragePath) -> str:
    """Encode a storage object path so slashes survive the URL path segment."""
    return urllib.parse.quote(str(path).replace("\\", "/"), safe="")


def upload_bytes(
    bucket: str,
    path: _StoragePath,
    data: bytes,
    *,
    content_type: str = "application/octet-stream",
    upsert: bool = False,
) -> None:
    """Upload bytes to a private Supabase Storage bucket using the service role."""
    url = f"{_base_url()}/object/{bucket}/{_encode_path(path)}"
    headers = _service_headers(content_type=content_type)
    params = {"upsert": "true" if upsert else "false"}
    with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        resp = client.post(url, headers=headers, params=params, content=data)
    if resp.status_code >= 400:
        raise RuntimeError(f"Storage upload failed ({resp.status_code}): {resp.text}")


def create_signed_url(
    bucket: str,
    path: _StoragePath,
    *,
    expires_in: int = 3600,
) -> str:
    """Mint a signed download URL for a private storage object.

    Returns the absolute URL, including the Supabase base URL and storage path.
    """
    url = f"{_base_url()}/object/sign/{bucket}/{_encode_path(path)}"
    headers = _service_headers(content_type="application/json")
    with httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
        resp = client.post(url, headers=headers, json={"expiresIn": expires_in})
    if resp.status_code >= 400:
        raise RuntimeError(f"Storage sign failed ({resp.status_code}): {resp.text}")
    signed = resp.json().get("signedURL")
    if not signed:
        raise RuntimeError("Storage sign response missing signedURL")
    return get_settings().supabase_url.rstrip("/") + "/storage/v1" + signed


def download_bytes(
    bucket: str,
    path: _StoragePath,
) -> bytes:
    """Download a private storage object using the service role."""
    url = f"{_base_url()}/object/{bucket}/{_encode_path(path)}"
    headers = _service_headers()
    with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        resp = client.get(url, headers=headers)
    if resp.status_code >= 400:
        raise RuntimeError(f"Storage download failed ({resp.status_code}): {resp.text}")
    return resp.content
