"""Hermes gateway health proxy and roster provider gating."""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from webapp.api.hermes_gateway_probe import probe_hermes_gateway
from webapp.api.main import app
from webapp.api.registry.providers import providers


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def hermes_settings(monkeypatch):
    from webapp.api.config import get_settings

    def _apply(**env):
        for key, val in env.items():
            monkeypatch.setenv(key, val)
        get_settings.cache_clear()

    yield _apply
    get_settings.cache_clear()


def test_hermes_health_disabled(hermes_settings, client):
    hermes_settings(HERMES_GATEWAY_ENABLED="false")
    response = client.get("/api/hermes/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "disabled"
    assert body["enabled"] is False


def test_hermes_health_unreachable(hermes_settings, client, monkeypatch):
    hermes_settings(
        HERMES_GATEWAY_ENABLED="true",
        HERMES_GATEWAY_URL="http://127.0.0.1:59999",
    )

    class _Client:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get(self, url):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr("webapp.api.hermes_gateway_probe.httpx.Client", _Client)
    monkeypatch.setattr("webapp.api.hermes_gateway_probe._tcp_open", lambda _u: False)

    response = client.get("/api/hermes/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "unreachable"
    assert body["enabled"] is True


def test_probe_ok_via_http(hermes_settings, monkeypatch):
    hermes_settings(
        HERMES_GATEWAY_ENABLED="true",
        HERMES_GATEWAY_URL="http://hermes-gateway:8642",
    )
    from webapp.api.config import get_settings

    class _Response:
        status_code = 200

        def json(self):
            return {"ok": True}

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get(self, url):
            assert url.endswith("/health")
            return _Response()

    monkeypatch.setattr("webapp.api.hermes_gateway_probe.httpx.Client", lambda **k: _Client())
    result = probe_hermes_gateway(get_settings())
    assert result["status"] == "ok"
    assert result["mcp_servers"] == ["aion", "vibe"]


def test_hermes_not_in_providers_when_disabled(hermes_settings):
    hermes_settings(HERMES_GATEWAY_ENABLED="false")
    assert "hermes_gateway" not in {p.name for p in providers()}


def test_hermes_in_providers_when_enabled(hermes_settings):
    hermes_settings(HERMES_GATEWAY_ENABLED="true")
    assert "hermes_gateway" in {p.name for p in providers()}


def test_hermes_gateway_row_reports_health(hermes_settings, monkeypatch):
    from webapp.api.registry.providers import hermes_gateway

    hermes_settings(HERMES_GATEWAY_ENABLED="true")

    monkeypatch.setattr(
        "webapp.api.registry.providers.hermes_gateway.probe_hermes_gateway",
        lambda _s: {"status": "ok", "enabled": True, "mcp_servers": ["aion", "vibe"]},
    )
    from webapp.api.config import get_settings

    rows = list(hermes_gateway.fetch(get_settings()))
    assert len(rows) == 1
    row = rows[0]
    row.validate_shape()
    assert row.uid == "agent:hermes:hermes-gateway"
    assert row.source == "hermes"
