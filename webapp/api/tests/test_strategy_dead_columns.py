"""The one mitigation standing between a vwap-less store and a dead backtest.

`FileFeatureStorage` returns an *empty series* for a missing `.bin` rather than
raising. So a handler column reading `$vwap` on a store that has no `vwap.day.bin`
is all-NaN on every row, and nothing anywhere says so. The GBDT learners shrug;
`LinearModel.fit` calls `df_train.dropna()` across every feature, so one all-NaN
column drops *every* row and the run dies minutes in with "Empty data from
dataset, please check your dataset config."

`_dead_columns` + the `DropCol` injection in `build_workflow_config` is the whole
defence, and until this file it was the only load-bearing behaviour in
`strategies.py` with no test at all.

Two properties matter more than the shape of the emitted dict:

  **The recipe is preserved.** `DropCol` is *prepended* to the handler's own
  processors, not substituted for them. Dropping the column while also dropping
  `ZScoreNorm` would trade a dead run for a silently unnormalised one.

  **A store we cannot see is not guessed at.** `census` reporting `exists: False`
  means "no answer", not "no columns". Injecting DropCol there would strip a
  column the store may well have.
"""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from webapp.api.strategies import (
    StrategySpec, _dead_columns, _processor_recipe, build_workflow_config,
    coverage_report, render_yaml,
)

pytestmark = pytest.mark.usefixtures("fake_stores")

GOLDEN = Path(__file__).parent / "fixtures" / "workflow_baseline.yaml"

FULL = ["open", "high", "low", "close", "volume", "factor", "change", "vwap"]
NO_VWAP = [f for f in FULL if f != "vwap"]

DROPCOL = "qlib.data.dataset.processor"


def fake_census(monkeypatch, *, fields, exists=True, partial=()):
    """Patch the census `_dead_columns` reaches.

    `_dead_columns` imports `census` *inside the function body*, so the name it
    resolves is the one on `factorlab.stores` -- patching that module is enough,
    and patching `strategies` would do nothing. Asserted rather than assumed:
    see `test_the_patch_target_is_the_one_dead_columns_reads`.
    """
    import webapp.api.factorlab.stores as stores_mod

    # `proxy` is derived exactly the way `census` derives it -- only the proxies
    # this store actually has -- because a fixture that hands back a key the real
    # function computes would let a caller read it wrong and still pass.
    monkeypatch.setattr(
        stores_mod, "census",
        lambda uri: {"exists": exists, "fields": list(fields),
                     "partial": list(partial), "instruments_sampled": 40,
                     "proxy": {f: stores_mod.PROXY_FIELDS[f] for f in sorted(fields)
                               if f in stores_mod.PROXY_FIELDS}})


def config_for(handler="Alpha158", **kw):
    spec = StrategySpec(name="Dead Columns", handler=handler, **kw)
    return build_workflow_config(spec, "/tmp/store-us", "us")


# --------------------------------------------------------------------------
# What counts as dead
# --------------------------------------------------------------------------

def test_the_patch_target_is_the_one_dead_columns_reads(monkeypatch):
    """Guards the fixture above, not the product.

    If `_dead_columns` ever hoists its import to module scope, every test in
    this file would silently pass against the real store instead of the fake
    one. This is the assertion that would fail first.
    """
    fake_census(monkeypatch, fields=NO_VWAP)
    assert _dead_columns("Alpha158", "/tmp/store-us") == ["VWAP0"]


def test_a_store_with_vwap_has_no_dead_columns(monkeypatch):
    fake_census(monkeypatch, fields=FULL)
    assert _dead_columns("Alpha158", "/tmp/store-us") == []
    assert _dead_columns("Alpha360", "/tmp/store-us") == []


def test_an_unreadable_store_is_not_guessed_at(monkeypatch):
    """`exists: False` is "no answer", not "no columns"."""
    fake_census(monkeypatch, fields=[], exists=False)
    assert _dead_columns("Alpha158", "/tmp/store-us") == []


def test_a_partially_written_column_still_counts_as_dead(monkeypatch):
    """`partial` is not `fields`, and that is what keeps this conservative.

    A column present for some instruments and not others is exactly the state a
    half-finished ingest leaves behind. It must not be mistaken for a column the
    whole store carries.
    """
    fake_census(monkeypatch, fields=NO_VWAP, partial=["vwap"])
    assert _dead_columns("Alpha158", "/tmp/store-us") == ["VWAP0"]


# --------------------------------------------------------------------------
# What lands in the config
# --------------------------------------------------------------------------

def test_dropcol_is_prepended_to_the_handlers_own_processors(monkeypatch):
    """Prepended, not substituted.

    Replacing the recipe would trade a dead run for a silently unnormalised one,
    which is worse: the first fails loudly, the second reports numbers.
    """
    fake_census(monkeypatch, fields=NO_VWAP)
    handler_config = config_for()["data_handler_config"]

    infer, learn = _processor_recipe("Alpha158", "lightgbm", "2010-01-04", "2019-12-31")
    drop = {"class": "DropCol", "module_path": DROPCOL, "kwargs": {"col_list": ["VWAP0"]}}

    assert handler_config["infer_processors"] == [drop, *infer]
    assert handler_config["learn_processors"] == [drop, *learn]


def test_a_healthy_store_adds_no_processor_keys_at_all(monkeypatch):
    """Not "empty lists" -- absent.

    An empty `infer_processors: []` would override the handler's own defaults
    with nothing, which is the unnormalised-training failure again by another
    route.
    """
    fake_census(monkeypatch, fields=FULL)
    handler_config = config_for()["data_handler_config"]

    assert "infer_processors" not in handler_config
    assert "learn_processors" not in handler_config


def test_a_healthy_store_renders_the_golden_config(monkeypatch):
    """The proof that adding `vwap` to a store cannot move the baseline YAML.

    `test_strategy_features.py` pins the same golden against the fake store,
    which has no `features/` directory and so reports `exists: False`. This
    asserts the other branch reaches the identical text: a store that *has* the
    column produces the file, exactly as a store nobody could read does.
    """
    fake_census(monkeypatch, fields=FULL)
    rendered = render_yaml(
        StrategySpec(name="Golden Baseline"), "/tmp/store-us", "us")
    assert rendered == GOLDEN.read_text()


def test_the_dropcol_config_survives_safe_dump(monkeypatch):
    """`col_list` has to be plain `str`.

    A numpy string or a tuple sneaking out of the census would raise
    `RepresenterError` at render time -- in the debounced preview, on every
    keystroke, for a spec that is otherwise fine.
    """
    fake_census(monkeypatch, fields=NO_VWAP)
    rendered = render_yaml(
        StrategySpec(name="Dead Columns"), "/tmp/store-us", "us")

    assert "DropCol" in rendered
    reloaded = yaml.safe_load(rendered)
    col_list = reloaded["data_handler_config"]["infer_processors"][0]["kwargs"]["col_list"]
    assert col_list == ["VWAP0"]
    assert all(type(c) is str for c in col_list)


def test_the_drop_reaches_the_dataset_handler_too(monkeypatch):
    """The handler block is the *same dict object*, so it must carry the drop.

    This is the anchor that makes the config byte-identical to the pre-feature
    one, and it means there is exactly one place the processors can be set.
    """
    fake_census(monkeypatch, fields=NO_VWAP)
    config = config_for()
    handler = config["task"]["dataset"]["kwargs"]["handler"]
    assert handler["kwargs"] is config["data_handler_config"]
    assert handler["kwargs"]["infer_processors"][0]["class"] == "DropCol"


# --------------------------------------------------------------------------
# Alpha360
# --------------------------------------------------------------------------

def test_alpha360_drops_its_sixty_vwap_columns(monkeypatch):
    """Alpha360 reads `$vwap` sixty times, not once.

    `Alpha360DL.get_feature_config` emits `Ref($vwap, i)/$close` for i in 1..59
    plus `$vwap/$close` -- VWAP0 through VWAP59, every one of them in the handler.
    So Alpha360 on a vwap-less store is the *worse* case, not the exempt one,
    and `_COLUMNS_NEEDING["Alpha360"]` being empty left it entirely unprotected:
    Alpha158 + Linear was saved by the DropCol while Alpha360 + Linear died.
    """
    fake_census(monkeypatch, fields=NO_VWAP)
    dead = _dead_columns("Alpha360", "/tmp/store-us")

    assert len(dead) == 60
    assert set(dead) == {f"VWAP{i}" for i in range(60)}

    handler_config = config_for(handler="Alpha360")["data_handler_config"]
    assert handler_config["infer_processors"][0]["kwargs"]["col_list"] == dead


# --------------------------------------------------------------------------
# What the coverage advisory says it checked
# --------------------------------------------------------------------------
#
# It used to check the handler and nothing else, and then say "every column is
# present" -- which a reader who had just written three custom factors
# reasonably took to include them. It did not look at them at all. These pin the
# two halves apart.

def coverage_for(monkeypatch, *, features=None, fields=FULL, partial=(), **kw):
    fake_census(monkeypatch, fields=fields, partial=partial)
    spec = StrategySpec(name="Coverage", features=features, **kw)
    return coverage_report(spec, "/tmp/store-us")


def test_a_spec_with_no_custom_factors_reports_none(monkeypatch):
    found = coverage_for(monkeypatch)
    assert found["feature_proxy_fields"] == {}
    assert found["feature_partial_fields"] == []


def test_a_custom_factor_reading_a_proxy_field_is_named(monkeypatch):
    """`$vwap` on these stores is typical price, written at ingest as a stand-in.

    It computes, so nothing warns and nothing fails -- the factor simply measures
    something other than what its author believes. The handler-level
    `proxy_columns` already said this about Alpha158, but said nothing about a
    factor the user wrote themselves.
    """
    found = coverage_for(monkeypatch, features=[
        {"name": "VWAP_GAP", "expression": "$vwap/$close - 1"}])
    assert list(found["feature_proxy_fields"]) == ["vwap"]
    assert "typical price" in found["feature_proxy_fields"]["vwap"]


def test_a_custom_factor_reading_a_partial_field_is_named(monkeypatch):
    """Present for some instruments and not others, so those names silently drop
    out of the cross-section rather than raising."""
    found = coverage_for(
        monkeypatch, fields=NO_VWAP, partial=["vwap"],
        features=[{"name": "VWAP_GAP", "expression": "$vwap/$close - 1"}])
    assert found["feature_partial_fields"] == ["vwap"]


def test_a_field_the_store_lacks_outright_is_left_to_the_blocker(monkeypatch):
    """`validate_features` already refuses it with `unknown_field`.

    Repeating a blocker as an advisory reads as a second, milder problem, and
    the reader would go looking for two.
    """
    found = coverage_for(monkeypatch, fields=NO_VWAP, features=[
        {"name": "VWAP_GAP", "expression": "$vwap/$close - 1"}])
    assert found["feature_partial_fields"] == []
    assert found["feature_proxy_fields"] == {}


def test_the_handler_half_and_the_factor_half_stay_apart(monkeypatch):
    """Alpha158 reads `$vwap` in VWAP0 whether or not the user does.

    Folding the two together would report a proxy on every strategy against
    these stores, which is the warning people learn to skip."""
    found = coverage_for(monkeypatch, features=[
        {"name": "MOM5", "expression": "Ref($close,5)/$close - 1"}])
    assert found["feature_proxy_fields"] == {}, "the factor does not read $vwap"
    assert found["dead_columns"] == [], "and this store has vwap, so nothing is dead"


def test_every_field_a_factor_reads_is_seen(monkeypatch):
    """Two factors, several fields each, and the `$$` form qlib also accepts."""
    found = coverage_for(monkeypatch, fields=NO_VWAP, partial=["vwap", "change"],
                         features=[
                             {"name": "A", "expression": "$vwap/$close - 1"},
                             {"name": "B", "expression": "Corr($$change, $volume, 20)"}])
    assert found["feature_partial_fields"] == ["change", "vwap"]
