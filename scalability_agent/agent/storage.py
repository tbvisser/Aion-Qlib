"""Small, httpx-based client for Supabase Storage.

Mirrors ``webapp/api/supabase_storage.py`` (same endpoints, same service-role
auth) but trimmed to the two operations the agent needs: downloading uploaded
trade files and uploading rendered report artifacts. Both buckets are private;
the service role key is what lets the agent cross org boundaries, which is
fine here because -- as with its database role -- the agent only ever touches
paths carried on the job/upload rows the platform wrote.
"""
from __future__ import annotations

import urllib.parse

import httpx

from .config import get_settings


def _base_url() -> str:
    return get_settings().supabase_url.rstrip("/") + "/storage/v1"


def _service_headers(content_type: str | None = None) -> dict[str, str]:
    key = get_settings().supabase_service_role_key
    if not key:
        raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY is not configured")
    headers: dict[str, str] = {"Authorization": f"Bearer {key}"}
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _encode_path(path: str) -> str:
    """Encode a storage object path so slashes survive the URL path segment."""
    return urllib.parse.quote(str(path).replace("\\", "/"), safe="")


def download_bytes(bucket: str, path: str) -> bytes:
    """Download a private storage object using the service role."""
    url = f"{_base_url()}/object/{bucket}/{_encode_path(path)}"
    headers = _service_headers()
    with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        resp = client.get(url, headers=headers)
    if resp.status_code >= 400:
        raise RuntimeError(f"Storage download failed ({resp.status_code}): {resp.text}")
    return resp.content


def upload_bytes(
    bucket: str,
    path: str,
    data: bytes,
    content_type: str = "application/octet-stream",
) -> None:
    """Upload bytes to a private Supabase Storage bucket using the service role.

    Upserts: a retried analyze job produces the same artifact path, and the
    second attempt must be able to overwrite the first attempt's partial file.
    """
    url = f"{_base_url()}/object/{bucket}/{_encode_path(path)}"
    headers = _service_headers(content_type=content_type)
    with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        resp = client.post(url, headers=headers, params={"upsert": "true"}, content=data)
    if resp.status_code >= 400:
        raise RuntimeError(f"Storage upload failed ({resp.status_code}): {resp.text}")
