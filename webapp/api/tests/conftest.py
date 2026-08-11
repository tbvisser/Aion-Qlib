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
