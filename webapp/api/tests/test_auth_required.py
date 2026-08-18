"""Nothing but /api/health answers an anonymous caller.

This suite exists because the failure it guards against is invisible. The rest
of the tests run with conftest's autouse override signing them in, so a route
that quietly lost its dependency would keep passing everywhere else -- and the
symptom in production is not an error but silence: a stranger getting somebody's
strategies back with a 200.

It clears the override on purpose. That is the whole point.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from webapp.api.auth import get_principal, require_org_admin
from webapp.api.main import app


@pytest.fixture
def anonymous():
    """A client with no identity, whatever conftest installed."""
    saved = dict(app.dependency_overrides)
    app.dependency_overrides.pop(get_principal, None)
    app.dependency_overrides.pop(require_org_admin, None)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(saved)


def _api_paths() -> list[tuple[str, str]]:
    """Every mounted /api route, with a method it accepts.

    Read off the OpenAPI schema rather than walked out of `app.routes`: this
    FastAPI keeps included routers as lazy objects whose paths are unprefixed,
    so walking them silently found one route out of ninety. The schema is the
    same information in a shape that does not depend on that internal.

    Generated rather than hand-listed, because a hand-written list is exactly
    what stops covering the router somebody adds next month.
    """
    out: list[tuple[str, str]] = []
    for path, operations in app.openapi()["paths"].items():
        if not path.startswith("/api"):
            continue
        for method in ("get", "post", "put", "delete"):
            if method in operations:
                out.append((method.upper(), path))
                break
    return sorted(set(out))


def test_the_route_table_was_actually_discovered():
    """Guards the guard: an empty list would make every test below vacuous."""
    paths = _api_paths()
    assert len(paths) > 20, f"only found {len(paths)} routes; enumeration broke"
    assert ("GET", "/api/strategies") in paths
    assert ("GET", "/api/runs") in paths


@pytest.mark.parametrize("method,path", _api_paths())
def test_every_route_but_health_refuses_an_anonymous_caller(anonymous, method, path):
    if path == "/api/health":
        pytest.skip("public by design: the login screen reports store health")

    # Path parameters get a syntactically valid but meaningless value -- a 401
    # has to happen before the handler ever looks at it.
    concrete = path
    while "{" in concrete:
        start = concrete.index("{")
        end = concrete.index("}", start)
        concrete = concrete[:start] + "x" + concrete[end + 1:]

    response = anonymous.request(method, concrete, json={})
    assert response.status_code in (401, 403), (
        f"{method} {concrete} answered {response.status_code} without a token"
    )


def test_health_stays_public(anonymous):
    """The one exception, asserted rather than assumed.

    The UI reports a missing data store or an unreachable database from here,
    and it has to be able to do that on the login screen -- before anyone has a
    token to present.
    """
    response = anonymous.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert "qlib" in body and "database" in body
