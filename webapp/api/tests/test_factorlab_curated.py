"""The curated factor library: it loads, it is safe, and it is not dead.

A hundred-odd hand-written expression strings is a lot of surface. Three
different things can be wrong with one and only one of them is a syntax error:
it can fail to parse, it can parse and do something dishonest (read the future,
need unbounded history), or it can parse, run, and return a column that is
constant, all-NaN or infinite. The last kind is invisible everywhere else in the
stack, so it gets its own test against the real store.
"""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from webapp.api.factorlab import curated
from webapp.api.factorlab.indicators import handler_columns
from webapp.api.strategies import FeatureColumn

FAMILIES = curated.load_families()
ALL = curated.all_factors()

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


def ids(pairs):
    return [f.name for _, f in pairs]


# --------------------------------------------------------------------------
# The library loads, and what it loaded is what is on disk
# --------------------------------------------------------------------------
def test_the_library_is_not_empty():
    assert len(ALL) > 90


def test_every_yaml_file_is_loaded():
    """A family that vanishes after a rename is one nobody would notice."""
    on_disk = {p.stem for p in curated.LIBRARY_DIR.glob("*.yaml")}
    loaded = {f.family for f in FAMILIES}
    assert on_disk == loaded


def test_the_declared_order_matches_the_files():
    assert tuple(f.family for f in FAMILIES) == curated.FAMILY_ORDER


def test_every_family_has_prose():
    for family in FAMILIES:
        assert family.label.strip()
        assert len(family.description.strip()) > 40, family.family


# --------------------------------------------------------------------------
# Every factor is safe to offer
# --------------------------------------------------------------------------
@pytest.mark.parametrize("pair", ALL, ids=ids(ALL))
def test_every_expression_compiles(pair):
    _, factor = pair
    curated.compile_expression(factor.expression)


@pytest.mark.parametrize("pair", ALL, ids=ids(ALL))
def test_no_factor_reads_ahead_or_needs_unbounded_history(pair):
    """The whole safety story in one assertion.

    `inspect_expression` bans lookahead, negative windows and expanding windows
    together. A factor that reads the future would make every backtest using it
    a measurement of hindsight, and an expanding window means something
    different in a preview than in a run.
    """
    _, factor = pair
    assert curated.inspect_expression(factor.expression, role="feature") == []


@pytest.mark.parametrize("pair", ALL, ids=ids(ALL))
def test_every_factor_is_a_valid_feature_column(pair):
    """It has to be droppable on the canvas, because that is what a click does."""
    _, factor = pair
    FeatureColumn(name=factor.name, expression=factor.expression)


def test_names_are_unique():
    names = [f.name for _, f in ALL]
    assert len(names) == len(set(names))


@pytest.mark.parametrize("handler", ["Alpha158", "Alpha360"])
def test_no_name_collides_with_a_handler_column(handler):
    """The check that would otherwise be discovered by a wrong result.

    qlib's NestedDataLoader keeps the later duplicate and drops the earlier, so
    a curated factor named MA20 silently deletes Alpha158's own MA20 and the
    handler comes back the same size. Nothing logs.
    """
    columns = set(handler_columns(handler))
    clashes = sorted({f.name for _, f in ALL} & columns)
    assert clashes == []


@pytest.mark.parametrize("pair", ALL, ids=ids(ALL))
def test_every_factor_has_a_summary_and_known_fields(pair):
    _, factor = pair
    assert len(factor.summary.strip()) > 15, factor.name
    unknown = set(curated.fields_of(factor.expression)) - {
        "open", "high", "low", "close", "volume", "factor", "change"}
    assert unknown == set(), f"{factor.name} names {unknown}"


def test_long_warm_up_factors_say_so():
    """A factor needing a trading year must not look like one needing a month.

    qlib's rolling uses `min_periods=1`, so a short window returns a confident
    number from a handful of rows. Nothing else in the stack distinguishes that
    from a real value.
    """
    for _, factor in ALL:
        if (curated.back_days(factor.expression) or 0) >= 200:
            assert factor.caveat, f"{factor.name} needs a warm-up caveat"


# --------------------------------------------------------------------------
# The guards actually fire
# --------------------------------------------------------------------------
def _write(tmp_path, monkeypatch, body: dict) -> None:
    (tmp_path / "trend.yaml").write_text(yaml.safe_dump(body))
    monkeypatch.setattr(curated, "LIBRARY_DIR", tmp_path)
    monkeypatch.setattr(curated, "FAMILY_ORDER", ("trend",))
    curated.load_families.cache_clear()


def _family(expression: str = "$close", name: str = "OK") -> dict:
    return {
        "family": "trend", "label": "Trend", "description": "x" * 50,
        "factors": [{"name": name, "expression": expression, "summary": "A summary here."}],
    }


@pytest.fixture(autouse=True)
def _restore_cache():
    yield
    curated.load_families.cache_clear()


def test_a_broken_expression_is_a_load_error(tmp_path, monkeypatch):
    _write(tmp_path, monkeypatch, _family("Mean($close"))
    with pytest.raises(curated.FactorLibraryError):
        curated.load_families()


def test_a_lookahead_expression_is_a_load_error(tmp_path, monkeypatch):
    _write(tmp_path, monkeypatch, _family("Ref($close,-5)"))
    with pytest.raises(curated.FactorLibraryError, match="future"):
        curated.load_families()


def test_an_expanding_window_is_a_load_error(tmp_path, monkeypatch):
    """The reason the textbook cumulative OBV is not in the library."""
    _write(tmp_path, monkeypatch, _family("Sum($volume,0)"))
    with pytest.raises(curated.FactorLibraryError, match="unbounded"):
        curated.load_families()


def test_an_extra_key_is_a_load_error(tmp_path, monkeypatch):
    body = _family()
    body["factors"][0]["expected_ic"] = 0.05
    _write(tmp_path, monkeypatch, body)
    with pytest.raises(curated.FactorLibraryError):
        curated.load_families()


def test_a_handler_collision_is_a_load_error(tmp_path, monkeypatch):
    _write(tmp_path, monkeypatch, _family(name="MA20"))
    with pytest.raises(curated.FactorLibraryError, match="collides"):
        curated.load_families()


def test_a_label_prefixed_name_is_a_load_error(tmp_path, monkeypatch):
    _write(tmp_path, monkeypatch, _family(name="LABEL_MOM"))
    with pytest.raises(curated.FactorLibraryError):
        curated.load_families()


# --------------------------------------------------------------------------
# The payload
# --------------------------------------------------------------------------
def test_the_payload_reports_unknown_when_there_is_no_store():
    payload = curated.curated_payload(None)
    assert payload["store"]["checked"] is False
    assert all(row["runnable"] is None for row in payload["factors"])
    assert [f["key"] for f in payload["families"]] == list(curated.FAMILY_ORDER)


def test_the_payload_flags_a_factor_the_store_cannot_evaluate(monkeypatch):
    """A missing column is silent in qlib, so it must be loud here."""
    monkeypatch.setattr(
        curated, "census",
        lambda uri: {"exists": True, "fields": ["open", "high", "low", "close"],
                     "partial": []},
        raising=False)
    import webapp.api.factorlab.stores as stores_mod
    monkeypatch.setattr(
        stores_mod, "census",
        lambda uri: {"exists": True, "fields": ["open", "high", "low", "close"],
                     "partial": []})

    payload = curated.curated_payload("/tmp/whatever")
    dead = [r for r in payload["factors"] if r["runnable"] is False]
    assert dead, "dropping $volume should kill the whole volume family"
    assert all("note" in r for r in dead)
    assert "volume" in payload["store"]["missing_columns"]


def test_back_days_is_reported_and_finite():
    for _, factor in ALL:
        days = curated.back_days(factor.expression)
        assert days is not None and days >= 0, factor.name


# --------------------------------------------------------------------------
# The endpoint
# --------------------------------------------------------------------------
def test_factors_endpoint_serves_the_library():
    from fastapi.testclient import TestClient

    from webapp.api.main import app

    body = TestClient(app).get("/api/factors").json()
    assert len(body["factors"]) == len(ALL)
    assert [f["key"] for f in body["families"]] == list(curated.FAMILY_ORDER)
    assert "operators" in body and "fields" in body and "store" in body
    first = body["factors"][0]
    assert {"name", "expression", "family", "summary", "back_days"} <= set(first)


# --------------------------------------------------------------------------
# Against the real store: compiles is not the same as works
# --------------------------------------------------------------------------
def _mounted_uri() -> str | None:
    from webapp.api import marketdata

    store = next((s for s in marketdata.data_stores() if s["exists"]), None)
    return store["provider_uri"] if store else None


@pytest.mark.skipif(_mounted_uri() is None, reason="no qlib store built on this machine")
def test_no_curated_factor_is_dead_on_the_real_store():
    """The only test that catches "compiles but is useless".

    A constant column, an all-NaN column from a lag longer than the sample, or an
    infinity from a zero denominator all pass every other check in this file and
    then train a model on nothing.
    """
    import numpy as np
    import qlib
    from qlib.data import D

    uri = _mounted_uri()
    assert Path(uri).exists()
    qlib.init(provider_uri=uri, region="us", expression_cache=None, dataset_cache=None)

    symbols = [s for s in ["AAPL", "MSFT", "SPY"]
               if s in set(D.instruments("all") and D.list_instruments(
                   D.instruments("all"), as_list=True))]
    assert symbols, "expected at least one of AAPL/MSFT/SPY in the store"

    # Long enough that even the 756-day factor has real values at the end.
    frame = D.features(symbols,
                       [f.expression for _, f in ALL],
                       start_time="2018-01-01", end_time="2026-01-01")
    frame.columns = [f.name for _, f in ALL]

    constant, empty, infinite = [], [], []
    for name in frame.columns:
        column = frame[name]
        tail = column.groupby(level=0).tail(250)
        if not np.isfinite(tail.to_numpy(dtype="float64")).any():
            empty.append(name)
            continue
        if np.isinf(tail.to_numpy(dtype="float64")).any():
            infinite.append(name)
        if tail.groupby(level=0).std().fillna(0).max() == 0:
            constant.append(name)

    assert empty == [], f"all-NaN on real data: {empty}"
    assert infinite == [], f"produced an infinity: {infinite}"
    # ADJ_FACTOR_EVENT is zero on almost every row by design, but it does move.
    assert constant == [], f"zero variance on real data: {constant}"
