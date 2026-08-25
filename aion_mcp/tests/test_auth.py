"""Auth checks for the Aion MCP server."""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from aion_mcp.auth import authorize_request
from webapp.api.auth import Principal
from webapp.api.mcp_user_token import mint_user_token


def _request(host: str = "127.0.0.1", auth: str | None = None) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if auth is not None:
        headers.append((b"authorization", auth.encode()))
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/mcp",
        "headers": headers,
        "client": (host, 12345),
    }
    return Request(scope)


def test_loopback_allowed_without_token():
    auth = authorize_request(_request("127.0.0.1"), "")
    assert auth.mode == "loopback"
    assert auth.principal is None


def test_non_loopback_rejected_without_token():
    with pytest.raises(HTTPException) as exc:
        authorize_request(_request("10.0.0.5"), "")
    assert exc.value.status_code == 401


def test_bearer_service_token_when_configured():
    auth = authorize_request(_request("10.0.0.5", "Bearer secret"), "secret")
    assert auth.mode == "service"


def test_wrong_bearer_rejected():
    with pytest.raises(HTTPException) as exc:
        authorize_request(_request("10.0.0.5", "Bearer wrong"), "secret")
    assert exc.value.status_code == 401


def test_user_token_accepted():
    principal = Principal(
        user_id="11111111-1111-1111-1111-111111111111",
        email=None,
        org_id="22222222-2222-2222-2222-222222222222",
        org_role="owner",
    )
    token, _ = mint_user_token(principal, service_token="secret")
    auth = authorize_request(_request("10.0.0.5", f"Bearer {token}"), "secret")
    assert auth.mode == "user"
    assert auth.principal is not None
    assert auth.principal.user_id == principal.user_id
