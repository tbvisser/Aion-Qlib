"""The Alpha158 library: is it complete, correctly grouped, and honest?

The test that carries the most weight is the last one. It evaluates all 184
expressions against a real store and asserts `runnable` in **both** directions --
every runnable column has data, and every non-runnable one is entirely NaN. That
is what turns `runnable` from a decoration into a claim: qlib returns an empty
series for a missing column instead of raising, so nothing else in the stack
would ever notice that five of these indicators are silently dead.
"""
from __future__ import annotations

import ast
import inspect
import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from ..factorlab import export, indicators as I
from ..factorlab.stores import census
from .helpers import REPO_ROOT

LIBRARY = I.build_library()
BY_NAME = {i.name: i for i in LIBRARY}

STORES = [
    Path("~/.qlib/qlib_data/us_eodhd").expanduser(),
    Path("~/.qlib/qlib_data/cn_data").expanduser(),
]
STORE = next((s for s in STORES if (s / "features").is_dir()), None)


# --------------------------------------------------------------------------
# Shape and completeness
# --------------------------------------------------------------------------

def test_the_library_is_the_whole_alpha158_feature_set():
    assert len(LIBRARY) == 184
    assert len(BY_NAME) == 184, "duplicate indicator names"

    counts: dict[str, int] = {}
    for indicator in LIBRARY:
        counts[indicator.family] = counts.get(indicator.family, 0) + 1
    assert counts == {"kbar": 9, "price": 25, "volume": 5, "rolling": 145}


def test_it_matches_what_qlib_generates_in_one_call():
    """Generated per family, but it must equal the single default call.

    The per-family split exists to know the family by construction. If it ever
    disagreed with the config a handler actually uses, the library would be
    describing a feature set no strategy trains on.
    """
    from qlib.contrib.data.loader import Alpha158DL

    expressions, names = Alpha158DL.get_feature_config({
        "kbar": {},
        "price": {"windows": I.PRICE_WINDOWS, "feature": I.PRICE_FEATURES},
        "volume": {"windows": I.PRICE_WINDOWS},
        "rolling": {"windows": I.ROLLING_WINDOWS},
    })
    assert dict(zip(names, expressions)) == {
        i.name: i.expression for i in LIBRARY
    }


def test_the_family_is_known_by_construction_not_guessed_from_the_name():
    """The `LOW` rolling key emits MIN5..MIN60.

    A prefix match would file those five under the price family (which has a
    real LOW group) and then find no rolling LOW group at all. This is the
    single reason `get_feature_config` is called once per key.
    """
    for window in I.ROLLING_WINDOWS:
        indicator = BY_NAME[f"MIN{window}"]
        assert indicator.family == "rolling"
        assert indicator.group == "LOW"

    assert BY_NAME["LOW0"].family == "price"
    assert BY_NAME["LOW0"].group == "LOW"
    # Both exist, under the same group key, in different families -- which is
    # exactly the collision a name-prefix rule cannot survive.
    assert {i.name for i in LIBRARY if i.group == "LOW"} == (
        {f"LOW{w}" for w in I.PRICE_WINDOWS} | {f"MIN{w}" for w in I.ROLLING_WINDOWS}
    )


def test_every_indicator_is_fully_described():
    for indicator in LIBRARY:
        assert indicator.expression.strip()
        assert indicator.description.strip().endswith("."), indicator.name
        assert len(indicator.description) > 25, indicator.name
        assert indicator.fields, indicator.name
        assert all(not f.startswith("$") for f in indicator.fields)


def test_windows_are_carried_from_the_call_not_scraped_from_the_name():
    for indicator in LIBRARY:
        if indicator.family == "kbar":
            assert indicator.window is None
            continue
        assert indicator.window is not None
        # The name happens to end in the window for this feature set; asserting
        # it proves the zip did not slip a row.
        assert indicator.name.endswith(str(indicator.window)), indicator.name


def test_the_rolling_keys_still_match_the_ones_in_qlibs_source():
    """Drift pin, read out of qlib rather than out of our own constant.

    AST-walks the `use("...")` calls in get_feature_config, so a qlib version
    that adds a rolling family fails here instead of silently serving 145 of 150.
    """
    from qlib.contrib.data.loader import Alpha158DL

    # getsource keeps the method's class-level indentation, which ast refuses.
    source = textwrap.dedent(inspect.getsource(Alpha158DL.get_feature_config))
    tree = ast.parse(source)
    keys = [
        node.args[0].value
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name) and node.func.id == "use"
        and node.args and isinstance(node.args[0], ast.Constant)
    ]
    assert keys == I.ROLLING_KEYS
    assert set(keys) == set(I._ROLLING), "a rolling key has no description"


def test_the_constant_indicators_are_the_ones_that_divide_a_field_by_itself():
    assert I.CONSTANT == {"CLOSE0", "VOLUME0"}
    assert BY_NAME["CLOSE0"].expression == "$close/$close"
    assert BY_NAME["VOLUME0"].expression == "$volume/($volume+1e-12)"
    for name in I.CONSTANT:
        assert BY_NAME[name].constant is True


# --------------------------------------------------------------------------
# What the handler actually trains on
# --------------------------------------------------------------------------

def test_the_handler_column_set_is_read_from_qlib_not_hardcoded():
    """Recomputed a different way, and compared.

    `Alpha158.get_feature_config` is an instance method that ignores `self`, so
    `handler_columns` calls it on an uninitialised receiver. Calling it on the
    class here is a genuinely different route to the same answer.
    """
    from qlib.contrib.data.handler import Alpha158

    expressions, names = Alpha158.get_feature_config(Alpha158)
    assert I.handler_columns() == dict(zip(names, expressions))
    assert len(I.handler_columns()) == 158


def test_every_handler_column_is_in_the_library_with_the_same_expression():
    """The library must cover the handler, or the page describes a different app.

    If qlib ever adds a column the generator's expanded config does not emit,
    this fails rather than the library quietly going one short.
    """
    library = {i.name: i.expression for i in LIBRARY}
    for name, expression in I.handler_columns().items():
        assert name in library, f"{name} is a handler column the library does not have"
        assert library[name] == expression, name


def test_in_handler_is_exactly_the_158_and_the_26_extras_are_named():
    """The claim the page used to get wrong, pinned with its own contents.

    The extras are listed rather than counted so a reader can see what a
    strategy is *not* trained on without running anything.
    """
    flagged = {i.name for i in LIBRARY if i.in_handler}
    assert len(flagged) == 158

    extras = {i.name for i in LIBRARY} - flagged
    assert extras == {
        "CLOSE0", "CLOSE1", "CLOSE2", "CLOSE3", "CLOSE4",
        "OPEN1", "OPEN2", "OPEN3", "OPEN4",
        "HIGH1", "HIGH2", "HIGH3", "HIGH4",
        "LOW1", "LOW2", "LOW3", "LOW4",
        "VWAP1", "VWAP2", "VWAP3", "VWAP4",
        "VOLUME0", "VOLUME1", "VOLUME2", "VOLUME3", "VOLUME4",
    }


def test_the_families_report_how_many_of_each_the_handler_uses():
    payload = I.library_payload(None)
    counts = {f["key"]: f["in_handler"] for f in payload["families"]}
    assert counts == {"kbar": 9, "price": 4, "volume": 0, "rolling": 145}
    assert payload["handler"]["columns"] == 158
    # The whole volume family is outside the handler, which is the least
    # guessable part of the split.
    assert all(not i.in_handler for i in LIBRARY if i.family == "volume")


def test_the_constant_indicators_are_not_what_the_handler_trains_on():
    """Pins the comment that used to claim the opposite.

    `indicators.py` said dropping CLOSE0/VOLUME0 "would make the library
    disagree with the handler a strategy actually trains on". Neither is in it.
    """
    for name in I.CONSTANT:
        assert BY_NAME[name].in_handler is False


def test_membership_is_matched_on_the_expression_not_the_name():
    """A name match would be a weaker and more dangerous claim.

    It is also the claim a custom feature set needs: a user column repeating a
    handler *name* silently replaces that handler column, so the flag has to mean
    "the handler computes exactly this".
    """
    columns = I.handler_columns()
    for indicator in LIBRARY:
        if indicator.in_handler:
            assert columns[indicator.name] == indicator.expression


def test_alpha360_shares_thirty_names_with_the_library_and_no_rolling_ones():
    """`strategies.py` offers Alpha360 too, so someone has to have checked.

    All thirty overlapping names carry byte-identical expressions -- Alpha360
    generates lags 0..59 in the same form Alpha158DL's price family uses for
    0..4. And Alpha360 contributes no rolling name at all, which is why a custom
    column called `MA5` collides under one handler and not the other.
    """
    alpha360 = I.handler_columns("Alpha360")
    assert len(alpha360) == 360

    shared = {i.name for i in LIBRARY} & set(alpha360)
    assert len(shared) == 30
    for name in shared:
        assert alpha360[name] == BY_NAME[name].expression, name

    rolling = {i.name for i in LIBRARY if i.family == "rolling"}
    assert rolling & set(alpha360) == set()


def test_an_unknown_handler_is_refused_rather_than_answered_emptily():
    with pytest.raises(ValueError):
        I.handler_columns("Alpha42")


def test_the_dead_column_the_handler_trains_on_says_so(monkeypatch):
    """The sentence the `in_handler` flag exists to make sayable.

    Driven from a fabricated census rather than from whatever store this machine
    happens to have. It used to assert against the real store, which was true
    only for as long as no store carried `$vwap` -- and the day the ingest
    started writing one, the test failed for the *good* reason, which is exactly
    the failure a reader cannot distinguish from a regression.

    The claim is about the code path, and it stays true forever: given a store
    without the column, an indicator the handler trains on says so.
    """
    import webapp.api.factorlab.stores as stores_mod
    monkeypatch.setattr(
        stores_mod, "census",
        lambda uri: {"exists": True, "partial": [], "proxy": {},
                     "fields": ["open", "high", "low", "close", "volume", "factor", "change"]})

    payload = I.library_payload("/tmp/store-without-vwap")
    dead_and_trained_on = [
        row for row in payload["indicators"]
        if row["runnable"] is False and row["in_handler"]
    ]
    assert [row["name"] for row in dead_and_trained_on] == ["VWAP0"]
    assert "Alpha158 handler trains on" in dead_and_trained_on[0]["note"]


@pytest.mark.skipif(STORE is None, reason="no qlib store built on this machine")
def test_this_machines_store_has_no_dead_handler_columns():
    """The other half, and the proof the proxy pass landed.

    `webapp.ingest.vwap` writes `$vwap` into every instrument, so nothing
    Alpha158 trains on should be dead here. If this fails, either the pass has
    not been run against this store or something has removed the column --
    `python -m webapp.ingest.vwap --store us --verify` says which.
    """
    payload = I.library_payload(str(STORE))
    dead = [row["name"] for row in payload["indicators"] if row["runnable"] is False]
    assert dead == [], f"dead columns on this store: {dead}"


@pytest.mark.skipif(STORE is None, reason="no qlib store built on this machine")
def test_the_vwap_indicators_say_they_are_reading_a_proxy():
    """Runnable is not the same as meaningful.

    The column exists now, so VWAP0..VWAP4 evaluate. What they evaluate to is
    typical price, and this is the surface that says so -- otherwise closing the
    dead-column gap would have quietly replaced a loud failure with a silent
    misreading, which is the worse of the two.
    """
    payload = I.library_payload(str(STORE))
    assert "vwap" in payload["store"]["proxy_columns"]

    vwap_rows = [r for r in payload["indicators"] if "vwap" in r["fields"]]
    assert {r["name"] for r in vwap_rows} == {f"VWAP{w}" for w in I.PRICE_WINDOWS}
    for row in vwap_rows:
        assert row["runnable"] is True
        assert row["proxy_fields"] == ["vwap"]
        assert "typical price" in row["note"]
        assert "not an intraday volume-weighted price" in row["note"]


# --------------------------------------------------------------------------
# The payload
# --------------------------------------------------------------------------

def test_without_a_store_runnable_is_unknown_rather_than_true():
    """The honest answer when there is nothing to check against.

    Defaulting to `true` would claim the VWAP indicators work on a machine that
    has not built a store, which is precisely the machine most likely to be
    fooled by it.
    """
    payload = I.library_payload(None)
    assert payload["store"]["checked"] is False
    assert {row["runnable"] for row in payload["indicators"]} == {None}
    assert payload["store"]["missing_columns"] == []


def test_the_vwap_indicators_are_refused_against_a_store_without_the_column(monkeypatch):
    """Fabricated census, for the same reason as the dead-column test above.

    A store without `$vwap` is still an entirely reachable state -- a fresh
    install, or a store the proxy pass has not been run against -- so the
    refusal path has to keep working. It just is not this machine any more.
    """
    import webapp.api.factorlab.stores as stores_mod
    monkeypatch.setattr(
        stores_mod, "census",
        lambda uri: {"exists": True, "partial": [], "proxy": {},
                     "fields": ["open", "high", "low", "close", "volume", "factor", "change"]})

    payload = I.library_payload("/tmp/store-without-vwap")
    assert payload["store"]["checked"] is True
    assert payload["store"]["missing_columns"] == ["vwap"]

    refused = {row["name"] for row in payload["indicators"] if row["runnable"] is False}
    assert refused == {f"VWAP{w}" for w in I.PRICE_WINDOWS}
    for row in payload["indicators"]:
        if row["runnable"] is False:
            assert "$vwap" in row["note"]
            assert "NaN" in row["note"]


def test_the_payload_counts_match_the_library():
    payload = I.library_payload(None)
    assert sum(f["count"] for f in payload["families"]) == 184
    for family in payload["families"]:
        actual = sum(1 for i in LIBRARY if i.family == family["key"])
        assert actual == family["count"], family["key"]


def test_the_payload_survives_a_json_round_trip():
    payload = I.library_payload(str(STORE) if STORE else None)
    assert json.loads(json.dumps(payload)) == payload


# --------------------------------------------------------------------------
# The committed UI fixtures
# --------------------------------------------------------------------------

def test_the_committed_ui_fixtures_are_current():
    """vitest cannot import qlib, so it reads committed JSON.

    Regenerated in memory and compared, so a fixture that rots fails here with
    the command to fix it rather than in a UI test with no explanation.
    """
    for path, payload in ((export.LIBRARY_JSON, export.library_fixture()),
                          (export.REGISTRY_JSON, export.registry_fixture())):
        assert path.is_file(), f"{path} is missing"
        assert path.read_text() == export.render(payload), (
            f"{path.name} is out of date. Re-run:\n"
            f"    python -m webapp.api.factorlab.export"
        )


# --------------------------------------------------------------------------
# The claim
# --------------------------------------------------------------------------

@pytest.mark.skipif(STORE is None, reason="no qlib store built on this machine")
def test_every_indicator_evaluates_against_the_store():
    """All 184 in one D.features call, asserted in both directions.

    Runs in a subprocess because `qlib.init()` mutates process-global config and
    must not leak into the rest of the suite -- the same reason every backtest
    runs out of process.

    Both directions matter. That the runnable ones produce data is the weaker
    half; that the non-runnable ones produce *nothing* is what proves `runnable`
    is measuring the thing it claims to measure, rather than happening to be
    false for five rows.
    """
    script = f'''
import sys, json
sys.path.insert(0, {str(REPO_ROOT / "webapp")!r})
import qlib
qlib.init(provider_uri={str(STORE)!r}, region="us",
          expression_cache=None, dataset_cache=None)
from qlib.data import D
from api.factorlab.indicators import build_library, library_payload

library = build_library()
calendar = D.calendar(freq="day")
window = (str(calendar[-60].date()), str(calendar[-1].date()))
instruments = D.list_instruments(D.instruments("all"), as_list=True)[:1]

frame = D.features(instruments, [i.expression for i in library],
                   start_time=window[0], end_time=window[1])
frame.columns = [i.name for i in library]

payload = library_payload({str(STORE)!r})
runnable = {{row["name"]: row["runnable"] for row in payload["indicators"]}}

print(json.dumps({{
    "rows": int(len(frame)),
    "empty": sorted(c for c in frame.columns if frame[c].isna().all()),
    "constant": sorted(c for c in frame.columns
                       if not frame[c].isna().all() and frame[c].std() == 0),
    "claimed_dead": sorted(n for n, ok in runnable.items() if ok is False),
    "claimed_live": sorted(n for n, ok in runnable.items() if ok is True),
}}))
'''
    result = subprocess.run([sys.executable, "-c", script], capture_output=True,
                            text=True, cwd=str(REPO_ROOT))
    assert result.returncode == 0, result.stderr[-3000:]
    measured = json.loads(result.stdout.strip().splitlines()[-1])

    assert measured["rows"] > 30, "not enough sessions to judge"

    # Direction 1: nothing we called runnable came back empty.
    assert set(measured["empty"]) & set(measured["claimed_live"]) == set(), (
        "these are offered as runnable but evaluate to NaN on every row: "
        f"{sorted(set(measured['empty']) & set(measured['claimed_live']))}"
    )
    # Direction 2: everything we refused really is empty. Without this the flag
    # could be false for the wrong five indicators and still pass.
    assert set(measured["claimed_dead"]) == set(measured["empty"]), (
        f"claimed dead {measured['claimed_dead']} but measured empty "
        f"{measured['empty']}"
    )
    # And the two we label constant are the two with zero variance.
    assert set(measured["constant"]) == I.CONSTANT
