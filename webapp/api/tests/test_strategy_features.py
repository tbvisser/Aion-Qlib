"""A composed factor, all the way to a config qlib will actually run.

Two things are defended here.

**Nothing changes for a strategy without custom features.** The generated YAML
must be byte-identical to what this app produced before the feature existed --
including the `&id001`/`*id001` anchor, which only survives because the handler
section holds the *same dict object* as the top-level `data_handler_config`. The
golden file was captured from the old code before the branch was written.

**A custom feature set is a trap in three ways, and each has a test.** qlib's
`NestedDataLoader` silently drops a colliding column and keeps the later one;
`DataHandler.__init__` takes no `**kwargs` so the fit dates cannot be passed
through; and `DataHandlerLP` has no processors of its own, so a hand-rolled
handler trains on unnormalised columns with the label never dropped for NaN
unless we reproduce what `Alpha158.__init__` does.

The load-bearing test is `test_the_generated_handler_actually_constructs`. It
costs a third of a second and catches every one of those, none of which a
YAML-shape assertion can see.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from webapp.api.factorlab.expressions import inspect_features
from webapp.api.strategies import (
    FeatureColumn, StrategySpec, build_workflow_config, render_yaml,
)
from webapp.api.tests.helpers import REPO_ROOT

pytestmark = pytest.mark.usefixtures("fake_stores")

GOLDEN = Path(__file__).parent / "fixtures" / "workflow_baseline.yaml"
STORE = Path("~/.qlib/qlib_data/us_eodhd").expanduser()

MOM = {"name": "MOM_RATIO", "expression": "Mean($close,5)/Mean($close,20) - 1"}
VOL = {"name": "VOL_RATIO", "expression": "$volume/(Mean($volume,20)+1e-12)"}


def custom(**kw) -> StrategySpec:
    return StrategySpec(name="Custom", features=[MOM, VOL], **kw)


def handler_of(spec: StrategySpec) -> dict:
    config = build_workflow_config(spec, "/tmp/store-us", "us")
    return config["task"]["dataset"]["kwargs"]["handler"]


# --------------------------------------------------------------------------
# Nothing changes when there are no custom features
# --------------------------------------------------------------------------

def test_config_is_byte_identical_without_features():
    """Asserted on the rendered string, not the dict.

    The dict comparison would pass while the YAML anchor silently disappeared,
    and the anchor is the reason the file reads the way it always has.
    """
    rendered = render_yaml(StrategySpec(name="Golden Baseline"), "/tmp/store-us", "us")
    assert rendered == GOLDEN.read_text()
    assert "&id001" in rendered and "*id001" in rendered


def test_a_deleted_last_card_is_the_same_strategy():
    """The canvas sends `[]` when the last feature is removed.

    If that produced a different config from a strategy that never had features,
    deleting a card would silently rewrite the YAML.
    """
    spec = StrategySpec(name="Golden Baseline", features=[])
    assert spec.features is None
    assert render_yaml(spec, "/tmp/store-us", "us") == GOLDEN.read_text()


def test_the_stock_handler_is_untouched_without_features():
    handler = handler_of(StrategySpec(name="x"))
    assert handler["class"] == "Alpha158"
    assert "data_loader" not in handler["kwargs"]


# --------------------------------------------------------------------------
# The custom handler
# --------------------------------------------------------------------------

def test_extend_nests_the_base_loader_with_the_custom_one():
    loader = handler_of(custom())["kwargs"]["data_loader"]
    assert loader["class"] == "NestedDataLoader"
    nested = loader["kwargs"]["dataloader_l"]
    assert [n["class"] for n in nested] == ["Alpha158DL", "QlibDataLoader"]


def test_the_custom_loader_goes_second():
    """Defence in depth, not decoration.

    `NestedDataLoader.load` drops the accumulated frame's duplicate columns and
    keeps the later loader's. Ordering the custom loader last means that if the
    collision guard is ever bypassed, the loss is a redundant base column rather
    than the user's own factor vanishing from a model they believe trades it.
    """
    nested = handler_of(custom())["kwargs"]["data_loader"]["kwargs"]["dataloader_l"]
    assert nested[-1]["class"] == "QlibDataLoader"
    assert nested[-1]["kwargs"]["config"]["feature"][1] == ["MOM_RATIO", "VOL_RATIO"]


def test_replace_uses_one_loader_and_no_nest():
    loader = handler_of(custom(feature_mode="replace"))["kwargs"]["data_loader"]
    assert loader["class"] == "QlibDataLoader"
    assert loader["kwargs"]["config"]["feature"][0] == [MOM["expression"], VOL["expression"]]


def test_the_label_rides_with_the_custom_loader():
    """`Alpha158DL` emits a feature group only.

    Nesting it alone yields a handler with no LABEL0 at all and a dataset that
    trains on nothing -- a failure that surfaces as an empty result, not an error.
    """
    for mode in ("extend", "replace"):
        loader = handler_of(custom(feature_mode=mode))["kwargs"]["data_loader"]
        if mode == "extend":
            loader = loader["kwargs"]["dataloader_l"][-1]
        label = loader["kwargs"]["config"]["label"]
        assert label[1] == ["LABEL0"]
        assert "Ref($close, -2)" in label[0][0]


def test_the_field_config_is_lists_not_tuples():
    """`safe_dump` refuses a tuple, and the config only ever reaches qrun as YAML."""
    config = handler_of(custom())["kwargs"]["data_loader"]["kwargs"]["dataloader_l"][-1]
    fields = config["kwargs"]["config"]
    for group in ("feature", "label"):
        assert isinstance(fields[group], list)
        assert all(isinstance(half, list) for half in fields[group])
    # And the whole thing survives a YAML round trip.
    render_yaml(custom(), "/tmp/store-us", "us")


def test_fit_dates_are_not_in_the_custom_handler_kwargs():
    """`DataHandler.__init__` has no `**kwargs`.

    Reusing the shared `data_handler_config` here raises
    `TypeError: DataHandler.__init__() got an unexpected keyword argument
    'fit_start_time'` -- at run time, minutes in, never at preview. The
    temptation to reuse that dict is strong enough to deserve a test.
    """
    kwargs = handler_of(custom())["kwargs"]
    assert "fit_start_time" not in kwargs
    assert "fit_end_time" not in kwargs
    assert kwargs["instruments"] == "top500"


def test_the_processor_recipe_matches_the_handler_it_names():
    """Read from qlib, not transcribed -- so assert it still equals qlib's."""
    import inspect

    from qlib.contrib.data.handler import (
        Alpha158, _DEFAULT_INFER_PROCESSORS, _DEFAULT_LEARN_PROCESSORS,
    )

    kwargs = handler_of(custom())["kwargs"]
    # Alpha158's own default is an empty infer list -- it does not normalise
    # features at all. A tree model still gets exactly that, so this assertion
    # is what catches a qlib bump quietly changing it underneath us.
    assert inspect.signature(Alpha158.__init__).parameters["infer_processors"].default == []
    assert kwargs["infer_processors"] == []
    assert [p["class"] for p in kwargs["learn_processors"]] == \
        [p["class"] for p in _DEFAULT_LEARN_PROCESSORS]
    assert kwargs["process_type"] == "append"

    # Alpha360 does normalise, and ZScoreNorm takes the fit window as required
    # positional arguments -- `check_transform_proc` injects them, and without
    # that the handler cannot even be constructed.
    alpha360 = handler_of(custom(handler="Alpha360"))["kwargs"]
    assert [p["class"] for p in alpha360["infer_processors"]] == \
        [p["class"] for p in _DEFAULT_INFER_PROCESSORS]
    zscore = next(p for p in alpha360["infer_processors"] if p["class"] == "ZScoreNorm")
    assert zscore["kwargs"]["fit_start_time"] == "2010-01-04"
    # The fit window is the TRAINING window. Fitting normalisation on validation
    # or test would leak their statistics into the model.
    assert zscore["kwargs"]["fit_end_time"] == "2019-12-31"


def test_alpha360_extends_its_own_loader_not_alpha158s():
    nested = handler_of(custom(handler="Alpha360"))["kwargs"]["data_loader"]["kwargs"]
    assert nested["dataloader_l"][0]["class"] == "Alpha360DL"


# --------------------------------------------------------------------------
# A linear model needs finite features, and Alpha158 does not supply them
# --------------------------------------------------------------------------
#
# Two runs died at `ValueError: array must not contain infs or NaNs`, minutes
# in. `LinearModel.fit` calls `dropna()`, which removes NaN and *not* inf, so an
# infinity from a factor dividing by a price that can be zero reaches scipy's
# `check_finite` and the run ends. Alpha158's own infer default is `[]`, so
# nothing between the loader and the solver had a chance to catch it.

def test_a_linear_model_gets_the_normaliser_alpha158_does_not_supply():
    for spec in (StrategySpec(name="x", model="linear"), custom(model="linear")):
        infer = handler_of(spec)["kwargs"]["infer_processors"]
        assert [p["class"] for p in infer] == ["RobustZScoreNorm", "Fillna"]
        # `clip_outlier` is the half that makes it total rather than likely:
        # np.clip(inf, -3, 3) is 3. Without it the infinity survives normalised.
        assert infer[0]["kwargs"]["clip_outlier"] is True
        assert infer[0]["kwargs"]["fields_group"] == "feature"


def test_the_normaliser_fits_on_the_training_window_only():
    """Fitting on validation or test would leak their statistics into the model."""
    spec = StrategySpec(name="x", model="linear",
                        train_start="2011-01-03", train_end="2018-12-31")
    zscore = handler_of(spec)["kwargs"]["infer_processors"][0]
    assert zscore["kwargs"]["fit_start_time"] == "2011-01-03"
    assert zscore["kwargs"]["fit_end_time"] == "2018-12-31"
    assert spec.valid_end not in zscore["kwargs"].values()


def test_two_specs_do_not_share_one_normaliser():
    """`check_transform_proc` writes the fit window *into* the kwargs it is given.

    `get_callable_kwargs` returns `config["kwargs"]` itself rather than a copy,
    and every recipe here is a module-level list -- ours, and qlib's own
    `_DEFAULT_INFER_PROCESSORS`. Without a deep copy the second spec's training
    dates land in the first spec's config, and the API builds these on threads.
    """
    first = handler_of(StrategySpec(name="a", model="linear",
                                    train_start="2011-01-03", train_end="2018-12-31"))
    second = handler_of(StrategySpec(name="b", model="linear",
                                     train_start="2015-01-02", train_end="2020-12-31"))
    assert first["kwargs"]["infer_processors"][0]["kwargs"]["fit_end_time"] == "2018-12-31"
    assert second["kwargs"]["infer_processors"][0]["kwargs"]["fit_end_time"] == "2020-12-31"

    from webapp.api.strategies import _FINITE_INFER_PROCESSORS
    assert "fit_start_time" not in _FINITE_INFER_PROCESSORS[0]["kwargs"], \
        "the module-level recipe was mutated"


def test_a_tree_model_is_left_exactly_as_it_was():
    """The split is qlib's own: Linear/Alpha158 normalises, LightGBM/Alpha158 does not.

    Widening it to every model would move the numbers of every tree run already
    in the ledger -- `Fillna(0)` replaces the NaN LightGBM routes down a learned
    default branch -- so the twenty-odd existing runs would stop being comparable.
    """
    for model in ("lightgbm", "xgboost", "catboost", "double_ensemble"):
        kwargs = handler_of(StrategySpec(name="x", model=model))["kwargs"]
        assert "infer_processors" not in kwargs
        assert "learn_processors" not in kwargs


def test_dead_columns_are_dropped_before_the_normaliser_fits(monkeypatch):
    """Order is load-bearing: `RobustZScoreNorm.fit` takes a median over the fit
    window, so an all-NaN column has to be gone before it looks."""
    monkeypatch.setattr("webapp.api.strategies._dead_columns",
                        lambda handler, uri: ["VWAP0"])
    kwargs = handler_of(StrategySpec(name="x", model="linear"))["kwargs"]

    assert [p["class"] for p in kwargs["infer_processors"]] == \
        ["DropCol", "RobustZScoreNorm", "Fillna"]
    assert kwargs["infer_processors"][0]["kwargs"]["col_list"] == ["VWAP0"]
    assert kwargs["learn_processors"][0]["class"] == "DropCol"


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

def test_a_colliding_name_is_refused():
    problems = StrategySpec(
        name="x", features=[{"name": "MA5", "expression": "$close"}]).validate_features()
    assert problems and "MA5" in problems[0]
    assert "replace" in problems[0], "the message must name the way out"


def test_the_same_name_is_fine_in_replace_mode():
    """Nothing to collide with -- the handler's own features are not there."""
    spec = StrategySpec(name="x", feature_mode="replace",
                        features=[{"name": "MA5", "expression": "Mean($close,5)/$close"}])
    assert spec.validate_features() == []


def test_a_name_that_collides_under_one_handler_may_not_under_another():
    """Alpha360 contributes no rolling column, so `MA5` is free there."""
    feature = [{"name": "MA5", "expression": "Mean($close,5)/$close"}]
    assert StrategySpec(name="x", features=feature).validate_features()
    assert StrategySpec(name="x", handler="Alpha360", features=feature).validate_features() == []


def test_a_lookahead_feature_is_refused_before_anything_runs():
    problems = StrategySpec(name="x", features=[
        {"name": "CHEAT", "expression": "Ref($close,-5)/$close - 1"}]).validate_features()
    assert problems and "future" in problems[0]


def test_duplicate_custom_names_are_refused():
    defects = inspect_features(
        [FeatureColumn(name="A", expression="$close"),
         FeatureColumn(name="A", expression="$open")])
    assert [d.code for d in defects] == ["duplicate_name"]


def test_replace_with_no_features_is_refused_at_construction():
    with pytest.raises(ValidationError):
        StrategySpec(name="x", feature_mode="replace")


def test_a_label_prefixed_name_is_refused():
    """qlib's processors select label columns by the substring `LABEL`.

    A feature called `LABEL_MOM` would be processed as a label by any recipe
    using `TanhProcess`, which is the kind of thing nobody discovers.
    """
    with pytest.raises(ValidationError):
        FeatureColumn(name="LABEL_MOM", expression="$close")
    with pytest.raises(ValidationError):
        FeatureColumn(name="5MA", expression="$close")
    with pytest.raises(ValidationError):
        FeatureColumn(name="my ma", expression="$close")


def test_thirty_two_columns_is_the_cap():
    many = [{"name": f"F{i}", "expression": "$close"} for i in range(33)]
    with pytest.raises(ValidationError):
        StrategySpec(name="x", features=many)


def test_strategies_still_imports_without_qlib():
    """The lazy imports are a contract, not an accident.

    `validate_features` and the custom-handler branch both import qlib inside
    the function so that `import webapp.api.strategies` stays cheap and
    store-free -- which is what lets the draft schema be built on a machine that
    has never run an ingest.
    """
    script = (
        "import sys; sys.path.insert(0, %r);\n"
        "import api.strategies;\n"
        "assert 'qlib' not in sys.modules, 'importing strategies pulled in qlib';\n"
        "print('clean')" % str(REPO_ROOT / "webapp")
    )
    result = subprocess.run([sys.executable, "-c", script], capture_output=True,
                            text=True, cwd=str(REPO_ROOT))
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "clean"


# --------------------------------------------------------------------------
# The one that proves the config runs
# --------------------------------------------------------------------------

def _run_against_store(body: str) -> dict:
    """Run a probe in its own interpreter, with a real qlib and a real store.

    A separate process because `qlib.init()` mutates process-global config, and
    a *file* rather than `-c` because qlib's loader spawns workers that need a
    real `__main__` to re-import.
    """
    import tempfile

    script = (
        "import sys\n"
        f"sys.path.insert(0, {str(REPO_ROOT / 'webapp')!r})\n"
        "def main():\n"
        "    import json, qlib\n"
        f"    qlib.init(provider_uri={str(STORE)!r}, region='us',\n"
        "              expression_cache=None, dataset_cache=None,\n"
        "              joblib_backend='threading')\n"
        "    from qlib.utils import init_instance_by_config\n"
        "    from api.strategies import StrategySpec, build_workflow_config\n"
        + body +
        "\nif __name__ == '__main__':\n    main()\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as fh:
        fh.write(script)
        path = fh.name
    result = subprocess.run([sys.executable, path], capture_output=True, text=True,
                            cwd=str(REPO_ROOT))
    assert result.returncode == 0, result.stderr[-3000:]
    return json.loads(result.stdout.strip().splitlines()[-1])


PROBE = """
    def build(mode, features):
        spec = StrategySpec(name='X', feature_mode=mode,
            train_start='2026-05-01', train_end='2026-06-15',
            valid_start='2026-06-16', valid_end='2026-06-30',
            test_start='2026-07-01', test_end='2026-07-31',
            features=features)
        cfg = build_workflow_config(spec, %(store)r, 'us')
        h = dict(cfg['task']['dataset']['kwargs']['handler'])
        h['kwargs'] = {**h['kwargs'], 'instruments': ['AAPL', 'MSFT', 'SPY']}
        return init_instance_by_config(h)

    mom = [{'name': 'MOM_RATIO', 'expression': 'Mean($close,5)/Mean($close,20) - 1'}]
    extend = build('extend', mom)
    replace = build('replace', mom)
    # A column named MA5, which Alpha158 already has. The guard refuses this;
    # the point here is to show what would happen if it did not.
    collide = build('extend', [{'name': 'MA5', 'expression': '$close * 0 + 42'}])
    ef, rf, cf = (h.fetch(col_set='feature') for h in (extend, replace, collide))
    print(json.dumps({
        'extend_columns': int(ef.shape[1]),
        'replace_columns': int(rf.shape[1]),
        'extend_has_custom': 'MOM_RATIO' in ef.columns,
        'extend_label': list(extend.fetch(col_set='label', data_key='learn').columns),
        'replace_label': list(replace.fetch(col_set='label', data_key='learn').columns),
        'collide_columns': int(cf.shape[1]),
        'collide_ma5_values': sorted(set(cf['MA5'].dropna().tolist()))[:2],
    }))
"""


@pytest.mark.skipif(not (STORE / "features").is_dir(),
                    reason="no qlib store built on this machine")
def test_the_generated_handler_actually_constructs():
    """The load-bearing test, and it costs about a third of a second.

    Everything a YAML-shape assertion cannot see fails here: the
    `fit_start_time` TypeError, a tuple that would not dump, a missing label, a
    processor whose kwargs are wrong. Asserting the column *count* is what makes
    it meaningful -- 158 + 1 for extend, exactly 1 for replace.
    """
    measured = _run_against_store(PROBE % {"store": str(STORE)})

    assert measured["extend_columns"] == 159, "Alpha158's 158 plus the custom one"
    assert measured["extend_has_custom"] is True
    assert measured["replace_columns"] == 1
    assert measured["extend_label"] == ["LABEL0"]
    assert measured["replace_label"] == ["LABEL0"]


#: The failure, reproduced and then defused, against a real store.
#:
#: `$close * 0` is a denominator that is exactly zero everywhere, so `1/($close*0)`
#: is `inf` in every cell -- the same shape as `Ref($close,5)/$close - 1` on a
#: universe holding an instrument whose close can be zero, which is what actually
#: killed the two runs, but deterministic rather than dependent on which symbols
#: the store happens to hold.
#:
#: Asserting on the **learn** frame is the point: that is what `LinearModel.fit`
#: prepares, and the whole failure was a value surviving as far as the solver.
INF_PROBE = """
    import numpy as np
    blowup = [{'name': 'BLOWUP', 'expression': '1 / ($close * 0)'}]

    def learn_features(model):
        spec = StrategySpec(name='X', model=model, features=blowup,
            train_start='2026-05-01', train_end='2026-06-15',
            valid_start='2026-06-16', valid_end='2026-06-30',
            test_start='2026-07-01', test_end='2026-07-31')
        cfg = build_workflow_config(spec, %(store)r, 'us')
        h = dict(cfg['task']['dataset']['kwargs']['handler'])
        h['kwargs'] = {**h['kwargs'], 'instruments': ['AAPL', 'MSFT', 'SPY']}
        frame = init_instance_by_config(h).fetch(col_set='feature', data_key='learn')
        return frame.to_numpy(dtype='float64')

    tree, linear = learn_features('lightgbm'), learn_features('linear')
    print(json.dumps({
        'tree_has_inf': bool(np.isinf(tree).any()),
        'linear_all_finite': bool(np.isfinite(linear).all()),
        'linear_rows': int(linear.shape[0]),
    }))
"""


@pytest.mark.skipif(not (STORE / "features").is_dir(),
                    reason="no qlib store built on this machine")
def test_a_linear_model_never_sees_an_infinity():
    """The one that would have caught the two failed runs.

    A shape assertion cannot see this: the config was well-formed, the handler
    constructed, the data loaded, and the value only became fatal inside
    `Ridge` -> `_solve_cholesky` -> scipy's `check_finite`, minutes in.

    The tree half is asserted too, and it asserts the *opposite*. That the
    infinity is still there for lightgbm is what makes this a per-model fix
    rather than a global one -- if that flips, every tree run in the ledger has
    silently stopped being comparable with the ones before it.
    """
    measured = _run_against_store(INF_PROBE % {"store": str(STORE)})

    assert measured["linear_rows"] > 0, "an empty frame would pass the finite check vacuously"
    assert measured["linear_all_finite"] is True
    assert measured["tree_has_inf"] is True, \
        "the probe no longer reproduces the failure it was written for"


@pytest.mark.skipif(not (STORE / "features").is_dir(),
                    reason="no qlib store built on this machine")
def test_a_collision_is_silent_in_qlib():
    """Why the collision guard is not paranoia.

    Naming a custom column `MA5` does not add a column and does not raise. The
    handler comes back at 158 -- the same size as plain Alpha158 -- and `MA5`
    holds the custom value. qlib's own MA5 is gone, and a model trained on this
    would be trading a feature set nobody chose.
    """
    measured = _run_against_store(PROBE % {"store": str(STORE)})

    assert measured["collide_columns"] == 158, "the column count did not grow"
    assert measured["collide_ma5_values"] == [42.0], "MA5 is the custom value"
