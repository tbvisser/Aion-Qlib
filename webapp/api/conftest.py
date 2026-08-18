"""Two stores with known contents, so no test depends on this machine.

Every suite that touches a spec, a draft or a template needs an answer to "which
universes exist and what is in them", and the real answer is a directory listing
of whatever qlib data happens to be built locally. Pinning it here is what lets
the suite give the same answer on a laptop that has never run an ingest.

Deliberately not `autouse`: a module opts in with
``pytestmark = pytest.mark.usefixtures("fake_stores")``, so the ingest suites —
which have their own view of the filesystem — are untouched.
"""
from __future__ import annotations

import copy

import pytest

from webapp.api import marketdata

# Every universe file that exists on a fully ingested machine. Kept complete
# rather than minimal: a template naming a real universe would otherwise fail
# here for a reason that exists only in this fixture, and the failure reads as
# "the template is wrong" when the template is correct.
STORES = [
    {"key": "us", "label": "US market (252-day)", "provider_uri": "/tmp/store-us",
     "region": "us", "note": "", "exists": True, "calendar_days": 4174,
     "universes": ["all", "crypto", "crypto_top100", "etf", "etf_top100", "fx",
                   "fx_top50", "index", "index_top50", "macro50", "top500"],
     "calendar_start": "2010-01-04",
     "calendar_end": "2026-07-31", "benchmarks": ["SPY", "QQQ"],
     "mounted": True},
    {"key": "crypto_365", "label": "Crypto (365-day)", "provider_uri": "/tmp/store-crypto",
     "region": "us", "note": "", "exists": True, "calendar_days": 6003,
     "universes": ["all", "crypto", "crypto_top100"],
     # No benchmarks file, exactly as on disk — the empty list is the case the
     # builder has to render as "this store has no benchmark list".
     "calendar_start": "2010-01-04",
     "calendar_end": "2026-08-04", "benchmarks": [],
     "mounted": False},
]

SYMBOLS = {
    # Benchmarks the shipped templates name, plus a couple of ordinary tickers.
    # `benchmarks` is the curated pair the store actually ships; `all` is what a
    # benchmark is resolved against, and templates legitimately use an index or
    # an FX pair as one.
    ("us", "all"): ["SPY", "QQQ", "AAPL", "MSFT", "GSPC", "EURUSD",
                    "IWM", "TLT", "GLD", "BTC-USD"],
    ("us", "benchmarks"): ["SPY", "QQQ"],
    ("crypto_365", "all"): ["BTC-USD", "ETH-USD"],
    ("crypto_365", "benchmarks"): [],
    # The curated list `_benchmark_candidates` falls back to when a store ships
    # no benchmarks file. Present on disk; without it here the fallback would
    # test as "offers nothing", which is the bug it exists to prevent.
    ("crypto_365", "crypto_top100"): ["BTC-USD", "ETH-USD"],
}


@pytest.fixture
def fake_stores(monkeypatch):
    """Returns the mutable store list, so a test can break one on purpose.

    Deep-copied: a shallow `dict(s)` shares the `universes` *list* with the
    constant above, so one test appending a universe would leak it into every
    test that ran afterwards.
    """
    stores = copy.deepcopy(STORES)
    monkeypatch.setattr(marketdata, "data_stores",
                        lambda: copy.deepcopy(stores))
    monkeypatch.setattr(
        marketdata, "store_symbols",
        lambda key, instrument_set="all": list(SYMBOLS.get((key, instrument_set), [])))
    return stores


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------
# Every route except /api/health now requires a verified Supabase token, and
# what a request can see is decided by row level security keyed on the caller.
# A TestClient has no token, so without this the whole suite would test the 401
# handler.
#
# The override is autouse and unconditional: authentication is not the thing
# most of these tests are about, and having to remember a fixture is how a new
# router test ends up asserting against a 401 body by accident. The one suite
# that *does* care -- test_auth_required.py -- clears the override itself.

import os
import uuid as _uuid

from webapp.api import db as _db
from webapp.api.auth import Principal, get_principal, require_org_admin
from webapp.api.main import app as _app


def _database_available() -> bool:
    return bool(os.environ.get("DATABASE_URL")) and _db.health()["ok"]


@pytest.fixture(scope="session")
def test_principal():
    """A real account in a throwaway organisation.

    Real, not a stub, because the repositories talk to Postgres and RLS is
    keyed on the ids -- a made-up uuid would fail the foreign keys and prove
    nothing. The organisation is created for the session and dropped after it,
    and everything the tests write cascades away with it, so a test run leaves
    no trace in the developer's own workspace.

    Falls back to a stub when there is no database, so the many tests that never
    touch storage still run on a machine with nothing else up.
    """
    if not _database_available():
        yield Principal(user_id=str(_uuid.uuid4()), email="tests@example.invalid",
                        org_id=str(_uuid.uuid4()), org_role="owner")
        return

    slug = f"pytest-{_uuid.uuid4().hex[:8]}"
    with _db.service_tx() as cur:
        # Any real account will do -- the tests only need ids that satisfy the
        # foreign keys, and creating an auth.users row from here would mean
        # reproducing gotrue's schema.
        cur.execute("SELECT user_id FROM public.user_profiles ORDER BY created_at LIMIT 1")
        row = cur.fetchone()
        if row is None:
            pytest.skip("no accounts exist yet; sign in once to create one")
        user_id = str(row["user_id"])
        cur.execute(
            "INSERT INTO public.organizations (name, slug, created_by) "
            "VALUES (%s, %s, %s) RETURNING id",
            (slug, slug, user_id))
        org_id = str(cur.fetchone()["id"])
        cur.execute(
            "INSERT INTO public.org_members (org_id, user_id, role) VALUES (%s, %s, 'owner')",
            (org_id, user_id))

    yield Principal(user_id=user_id, email="tests@example.invalid",
                    org_id=org_id, org_role="owner")

    with _db.service_tx() as cur:
        cur.execute("DELETE FROM public.organizations WHERE id = %s", (org_id,))


@pytest.fixture(autouse=True)
def _authenticated(test_principal):
    """Sign every TestClient request in as `test_principal`, then clean up.

    The per-test wipe matters as much as the sign-in: the organisation is shared
    across the session, so without it one test's saved strategy would show up in
    the next test's list and the failure would look like a bug in the router.
    """
    _app.dependency_overrides[get_principal] = lambda: test_principal
    _app.dependency_overrides[require_org_admin] = lambda: test_principal
    try:
        yield test_principal
    finally:
        _app.dependency_overrides.pop(get_principal, None)
        _app.dependency_overrides.pop(require_org_admin, None)
        if _database_available():
            with _db.service_tx() as cur:
                # Enumerated from the catalogue rather than listed by hand. A
                # table added to the aion schema later would otherwise leak rows
                # between tests until somebody remembered to extend this list,
                # and that failure surfaces as a bug in whichever router ran
                # next -- nowhere near the cause.
                cur.execute(
                    "SELECT c.relname FROM pg_class c "
                    "JOIN pg_namespace n ON n.oid = c.relnamespace "
                    "JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' "
                    "WHERE n.nspname = 'aion' AND c.relkind = 'r'")
                for table in [r["relname"] for r in cur.fetchall()]:
                    # Identifier comes from the catalogue, never from a request.
                    cur.execute(f'DELETE FROM aion."{table}" WHERE org_id = %s',
                                (test_principal.org_id,))


@pytest.fixture
def needs_db():
    """Skip a test that cannot mean anything without storage."""
    if not _database_available():
        pytest.skip("DATABASE_URL is not set or the database is unreachable")
