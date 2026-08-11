"""Security regression: the global exception handler must not leak internals.

Finding **F-002** (Workstream F — Secrets/Config). `app.main.global_exception_handler`
currently returns ``{"detail": f"Internal server error: {str(exc)}"}`` to the client,
echoing the raw exception message on any unhandled 500. Exception text frequently
embeds internal detail an attacker can mine: SQL fragments and column names, file
paths, service-role / connection-string fragments from DB driver errors, library
internals, and snippets of user/PII data that happened to be in scope when the
error was raised. The fix is to return a generic message plus a correlation id and
log the real exception server-side only.

These tests are deliberately **self-contained**: they build a throwaway FastAPI app
that mounts the *real* handler from ``app.main`` and exercise it with a synchronous
``TestClient``. They do **not** use the ``api``/``api1``/``api2`` fixtures and so do
**not** trigger the session-scoped autouse cleanup in ``conftest.py`` that wipes both
test users' threads/folders — safe to run alongside other workstreams.

``test_handler_does_not_echo_exception_text`` is marked ``xfail(strict=True)``: it
documents the present leak (so it *fails-as-expected* today) and will start
**passing** — flipping the xfail to an XPASS/failure that forces this file's
attention — the moment the handler is fixed to stop echoing ``str(exc)``. At that
point drop the ``xfail`` marker so it guards against regression.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# Import the actual production handler under test so the assertion tracks the real
# implementation, not a copy.
from app.main import global_exception_handler

pytestmark = pytest.mark.api

# A sentinel that would never appear in a *generic* 500 body but is guaranteed to be
# present in the current str(exc)-echoing implementation. Mimics the shape of a real
# leak: a connection-string-like fragment plus a column name.
_SECRET_MARKER = "leaky-internal-detail postgres://svc:SUPER_SECRET@db/col=user_id"


def _make_app() -> FastAPI:
    app = FastAPI()
    # Register the *production* handler.
    app.add_exception_handler(Exception, global_exception_handler)

    @app.get("/__boom")
    async def boom():  # pragma: no cover - body is the point of the test
        raise RuntimeError(_SECRET_MARKER)

    return app


def test_handler_returns_500_json():
    """Baseline: an unhandled error still yields a clean 500 JSON envelope."""
    client = TestClient(_make_app(), raise_server_exceptions=False)
    resp = client.get("/__boom")
    assert resp.status_code == 500
    body = resp.json()
    assert "detail" in body, f"expected a 'detail' field, got {body!r}"


@pytest.mark.xfail(
    strict=True,
    reason="F-002: global_exception_handler echoes str(exc) (main.py ~130). "
    "Remediate to a generic message + correlation id, then remove this xfail.",
)
def test_handler_does_not_echo_exception_text():
    """The 500 body must NOT contain the raw exception message.

    Today the handler returns ``Internal server error: <str(exc)>`` so the secret
    marker leaks → this assertion fails → xfail(strict) records it as the finding's
    living repro. After the fix the body is generic, the marker is absent, this
    passes, and the strict xfail turns the run RED until the marker is removed.
    """
    client = TestClient(_make_app(), raise_server_exceptions=False)
    resp = client.get("/__boom")
    body_text = resp.text
    assert _SECRET_MARKER not in body_text, (
        "Exception text leaked to the client in the 500 response body. "
        "The handler must return a generic message (e.g. "
        '{"detail": "Internal server error", "error_id": "<uuid>"}) and log the '
        "real exception server-side only."
    )
    # Also assert the generic-message contract the fix should satisfy.
    assert "Internal server error:" not in body_text, (
        "Body still uses the 'Internal server error: <detail>' format that "
        "concatenates exception text; switch to a static message."
    )
