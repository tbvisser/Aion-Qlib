"""Strategy definitions and their translation into qlib workflow configs.

A strategy is stored as the small set of decisions a user actually makes; the
full qlib YAML is *derived* from it. That keeps one source of truth: the config
handed to ``qrun`` is generated here, so the UI can never drift from what the
engine executes, and the generated YAML is shown verbatim in the builder.

The shape follows examples/benchmarks/LightGBM/workflow_config_lightgbm_Alpha158.yaml,
which is the config proven to reproduce qlib's published numbers.
"""
from __future__ import annotations

import importlib
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .marketdata import store_calendar_end, store_for, store_symbols

# Only models whose dependencies are actually installed. The torch-based
# benchmarks (GRU, LSTM, Transformer, ...) need the `rl` extras, so offering
# them here would produce runs that fail minutes in with an ImportError.
MODEL_SPECS: dict[str, dict[str, Any]] = {
    "lightgbm": {
        "label": "LightGBM",
        "class": "LGBModel",
        "module_path": "qlib.contrib.model.gbdt",
        "kwargs": {
            "loss": "mse",
            "colsample_bytree": 0.8879,
            "learning_rate": 0.0421,
            "subsample": 0.8789,
            "lambda_l1": 205.6999,
            "lambda_l2": 580.9768,
            "max_depth": 8,
            "num_leaves": 210,
            "num_threads": 20,
        },
    },
    "xgboost": {
        "label": "XGBoost",
        "class": "XGBModel",
        "module_path": "qlib.contrib.model.xgboost",
        "kwargs": {"eta": 0.0421, "max_depth": 8, "colsample_bytree": 0.8879,
                   "subsample": 0.8789, "lambda": 580.9768, "alpha": 205.6999},
    },
    "catboost": {
        "label": "CatBoost",
        "class": "CatBoostModel",
        "module_path": "qlib.contrib.model.catboost_model",
        "kwargs": {"loss": "RMSE", "learning_rate": 0.0421, "depth": 8},
    },
    "linear": {
        "label": "Linear",
        "class": "LinearModel",
        "module_path": "qlib.contrib.model.linear",
        "kwargs": {"estimator": "ridge", "alpha": 0.05},
    },
    "double_ensemble": {
        "label": "DoubleEnsemble",
        "class": "DEnsembleModel",
        "module_path": "qlib.contrib.model.double_ensemble",
        "kwargs": {"base_model": "gbm", "loss": "mse", "num_models": 6,
                   "enable_sr": True, "enable_fs": True, "alpha1": 1.0, "alpha2": 1.0,
                   "bins_sr": 10, "bins_fs": 5, "decay": 0.5, "sample_ratio": 0.8,
                   "sub_weights": [1, 0.2, 0.2, 0.2, 0.2, 0.2], "epochs": 28},
    },
}

HANDLERS = {
    "Alpha158": "qlib.contrib.data.handler",
    "Alpha360": "qlib.contrib.data.handler",
}


def available_models() -> list[dict]:
    """Only the models that can actually run.

    qlib degrades quietly here: an uninstalled backend makes it log
    "XGBModel is skipped" at import and carry on, so a model offered to the user
    without its dependency would fail minutes into a run. Importing the class is
    the only honest availability check.

    This lives here rather than in the router because more than one caller needs
    the same answer -- the /models endpoint and the draft schema's `model` enum.
    A second copy of the check is exactly how a UI comes to offer something the
    engine cannot run.
    """
    out = []
    for key, spec in MODEL_SPECS.items():
        try:
            importlib.import_module(spec["module_path"])
        except Exception:
            continue
        out.append({"id": key, "label": spec["label"], "class": spec["class"]})
    return out


#: A defect either stops a run or merely makes it meaningless.
#:
#: The distinction is not cosmetic and it is not inferable from the text. A
#: blocking defect is one `POST /runs` refuses; an advisory one describes a run
#: that will reach exit 0 and mean nothing -- an unfiltered universe, a book of
#: one name, an unguarded crypto store. The UI counts only the first kind, and
#: used to guess which was which by matching message prefixes, so a reworded
#: string silently changed a strategy's status.
Severity = Literal["blocking", "advisory"]


@dataclass(frozen=True)
class SpecDefect:
    """One thing wrong with a spec, in the caller's coordinates.

    Deliberately the same shape as `factorlab.expressions.ExpressionDefect`
    plus a severity: both end up in one list on the wire, and a consumer that
    has to tell them apart by origin is a consumer that will get it wrong.
    `path` names a `StrategySpec` field, which is what lets the builder put the
    message on the stage that owns that field instead of guessing from the words
    in it. It may carry detail past the field -- `features[2].expression` -- so
    the *field* is the leading segment, up to the first `.` or `[`. Keeping the
    detail is what lets a message point at one custom column rather than at the
    Features stage in general.
    """

    code: str
    message: str
    path: str
    severity: Severity = "blocking"

    def as_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "path": self.path,
                "severity": self.severity}


class FeatureColumn(BaseModel):
    """One user-composed factor, as a column the model will see."""

    model_config = ConfigDict(extra="forbid")

    #: Becomes a pandas column name inside the handler.
    name: str = Field(..., min_length=1, max_length=40,
                      pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    expression: str = Field(..., min_length=1, max_length=2000)

    @field_validator("name")
    @classmethod
    def _not_a_label(cls, v: str) -> str:
        """`LABEL` is refused as a prefix for a fact, not a preference.

        qlib's `TanhProcess` picks out label columns with
        `columns.get_level_values(1).str.contains("LABEL")`, so a feature called
        `LABEL_MOM` would be processed as a label by any recipe using it.

        A validator rather than a negative look-ahead in the pattern: pydantic
        compiles patterns with the Rust regex crate, which has no look-around.
        """
        if v.upper().startswith("LABEL"):
            raise ValueError(
                "a feature name cannot start with LABEL -- qlib's processors "
                "select label columns by that substring")
        return v


class StrategySpec(BaseModel):
    """The decisions a user makes; everything else is derived."""

    name: str = Field(..., min_length=1, max_length=80)
    model: Literal["lightgbm", "xgboost", "catboost", "linear", "double_ensemble"] = "lightgbm"
    handler: Literal["Alpha158", "Alpha360"] = "Alpha158"
    # Which qlib store to run against. A store is defined by its trading
    # calendar, so this also decides what can be held together: 'us' is the
    # 252-day NYSE calendar (equities, ETFs, crypto, FX, indices — cross-asset
    # strategies live here), 'crypto_365' is crypto on all 365 days.
    data_store: Literal["us", "crypto_365"] = "us"
    universe: str = "top500"
    benchmark: str = "SPY"

    train_start: str = "2010-01-04"
    train_end: str = "2019-12-31"
    valid_start: str = "2020-01-01"
    valid_end: str = "2021-12-31"
    test_start: str = "2022-01-01"
    test_end: str = "2026-08-07"

    topk: int = Field(50, ge=1, le=500)
    n_drop: int = Field(5, ge=0, le=100)
    open_cost: float = Field(0.0005, ge=0, le=0.05)
    close_cost: float = Field(0.0015, ge=0, le=0.05)
    min_cost: float = Field(5.0, ge=0)
    account: float = Field(100_000_000, gt=0)
    limit_threshold: float | None = Field(
        None,
        description="Daily move beyond which a fill is impossible. Models China's "
                    "price limits, and doubles as the only guard against a bad "
                    "tick being filled at full size: normally null for US "
                    "equities, worth setting loosely (0.5) on crypto stores, "
                    "where single prints are off by orders of magnitude.",
    )

    features: list[FeatureColumn] | None = Field(
        None, max_length=32,
        description="Custom factor columns to put in front of the model. Null "
                    "means the handler's own feature set, untouched.",
    )
    feature_mode: Literal["extend", "replace"] = Field(
        "extend",
        description="Whether custom factors are added to the handler's own "
                    "features or replace them entirely.",
    )

    @field_validator("features")
    @classmethod
    def _no_empty_feature_list(cls, v: list[FeatureColumn] | None):
        """`[]` and `None` must be the same strategy.

        The canvas sends an empty list when the last card is deleted, and if that
        produced a different config from a strategy that never had features, then
        deleting a card would silently change the generated YAML.
        """
        return v or None

    @model_validator(mode="after")
    def _replace_needs_something_to_replace(self):
        if self.feature_mode == "replace" and not self.features:
            raise ValueError(
                "feature_mode 'replace' needs at least one custom feature. With "
                "none, the run would quietly use the handler's own features under "
                "a spec that says it replaced them.")
        return self

    @field_validator("train_start", "train_end", "valid_start", "valid_end",
                     "test_start", "test_end")
    @classmethod
    def _iso_date(cls, v: str) -> str:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            raise ValueError(f"'{v}' must be YYYY-MM-DD")
        return v

    def window_defects(self) -> list[SpecDefect]:
        """Ordering problems that would silently produce a meaningless run.

        The four ordering checks are fatal. The fifth -- the calendar clamp --
        is not, and saying so here is what stops it being misfiled: it announces
        that `build_workflow_config` is about to end the run a few sessions
        early to avoid qlib's final-bar `IndexError`. The run proceeds. Treating
        it as fatal once made 31 of 32 curated templates report `runnable:
        false` over a run that would have worked.
        """
        out: list[SpecDefect] = []
        if self.train_end < self.train_start:
            out.append(SpecDefect("window_order", "Train end is before train start.",
                                  "train_end"))
        if self.valid_start <= self.train_end:
            out.append(SpecDefect(
                "window_order",
                "Validation overlaps training — the model would be scored on data it saw.",
                "valid_start"))
        if self.test_start <= self.valid_end:
            out.append(SpecDefect(
                "window_order",
                "Test overlaps validation — results would be optimistic.",
                "test_start"))
        if self.test_end < self.test_start:
            out.append(SpecDefect("window_order", "Test end is before test start.",
                                  "test_end"))

        # Said out loud rather than clamped in silence. A backtest that quietly
        # stops before the date on the form is the kind of difference that gets
        # attributed to the strategy.
        safe_end = store_calendar_end(self.data_store)
        if safe_end and self.test_end > safe_end:
            out.append(SpecDefect(
                "calendar_clamp",
                f"Test end {self.test_end} is past the last date this store can safely "
                f"backtest; the run will end {safe_end} instead.",
                "test_end", "advisory"))
        return out

    def validate_windows(self) -> list[str]:
        """`window_defects` as bare messages, for callers that predate it."""
        return [d.message for d in self.window_defects()]

    def execution_defects(self) -> list[SpecDefect]:
        """Soft warnings about a spec that will run, but will not mean anything.

        The twin of `validate_windows`, and advisory in the same way: a one-name
        bet on an unfiltered universe is a legitimate thing to ask a backtest
        for. It just is not a result, and the difference is invisible on a
        finished run -- the metrics come back enormous rather than empty, so
        nothing about the output says "this measured the worst tick in the
        store" instead of "this made money".

        Every check here fires on a spec that qlib will run to exit 0.
        """
        problems: list[SpecDefect] = []

        # An unfiltered universe. `crypto` is ~1,900 Yahoo-style tickers, most of
        # them micro-caps whose history carries prints that are off by orders of
        # magnitude; a curated list next to it is almost always what was meant.
        curated = f"{self.universe}_top100"
        store = store_for(self.data_store)
        if store and curated in (store.get("universes") or []):
            names = len(store_symbols(self.data_store, self.universe))
            problems.append(SpecDefect(
                "broad_universe",
                f"Universe '{self.universe}' is {names} names, most of them thinly "
                f"traded, and a single bad print in that tail can dominate a "
                f"backtest. '{curated}' is the curated list.",
                "universe", "advisory"))

        # A book of one or two names is not a portfolio, it is a bet on whichever
        # name scores highest -- which on an unfiltered universe is reliably the
        # one with the most broken data.
        if self.topk <= 2:
            held = "one name" if self.topk == 1 else "two names"
            note = (f"Holding {held} makes the result a property of the single "
                    f"highest-scoring symbol each day rather than of the signal.")
            if self.n_drop == 0:
                note += (" With n_drop 0 the book never rotates out of a bad "
                         "fill either.")
            problems.append(SpecDefect("thin_book", note, "topk", "advisory"))

        # qlib fills at the close of whatever the data says, so on a store with
        # no fill guard a 1000x tick is executed at full size.
        if self.data_store.startswith("crypto") and self.limit_threshold is None:
            problems.append(SpecDefect(
                "no_price_limit",
                "Nothing caps a daily move on this store, so a bad tick is filled "
                "at full size. limit_threshold is the guard, as a fraction "
                "(0.5 blocks moves beyond 50% in a day).",
                "limit_threshold", "advisory"))

        return problems

    def validate_execution(self) -> list[str]:
        """`execution_defects` as bare messages, for callers that predate it."""
        return [d.message for d in self.execution_defects()]

    def feature_defects(self, provider_uri: str | None = None) -> list:
        """Custom factors that would run, but shouldn't.

        The twin of `validate_windows`, and imported lazily for the same reason
        the rest of this module is qlib-free: importing `strategies` must not
        pull in qlib, and compiling an expression does.

        With a `provider_uri`, the store's own columns are passed in too, so a
        column naming a field the store does not carry is refused here rather
        than discovered as an all-NaN column minutes into a run. Only when the
        census can actually see the store: `exists: False` means "no answer",
        and treating it as "no columns" would refuse every expression on a
        machine that has not built a store yet.
        """
        if not self.features:
            return []
        from .factorlab.expressions import inspect_features

        available: set[str] | None = None
        if provider_uri:
            from .factorlab.stores import census

            found = census(provider_uri)
            if found["exists"]:
                available = set(found["fields"])

        return inspect_features(
            self.features, handler=self.handler, mode=self.feature_mode,
            available_fields=available)

    def validate_features(self, provider_uri: str | None = None) -> list[str]:
        """`feature_defects` as bare messages, for callers that predate it."""
        return [d.message for d in self.feature_defects(provider_uri)]


class StoredStrategy(StrategySpec):
    id: str
    created_at: str
    updated_at: str
    #: Who owns this row. The UI compares it against the signed-in user to
    #: decide whether to offer edit and delete, the same way the RAG document
    #: and folder menus already do.
    user_id: str = ""
    #: 'private' or 'org'. Shared rows are readable by fellow members and still
    #: only writable by the owner (or an org admin) -- enforced by RLS, not here.
    visibility: str = "private"


#: The loader that produces each handler's own features, for `extend` mode.
_BASE_LOADERS = {
    "Alpha158": {"class": "Alpha158DL", "module_path": "qlib.contrib.data.loader"},
    "Alpha360": {"class": "Alpha360DL", "module_path": "qlib.contrib.data.loader"},
}


#: Models whose solver refuses a non-finite cell.
#:
#: `LinearModel.fit` does `df_train.dropna()`, which removes NaN and **not**
#: `inf`, so an infinity survives into `Ridge` -> `_solve_cholesky` -> scipy's
#: `check_finite` and the run dies with "array must not contain infs or NaNs" --
#: minutes in, after the data has loaded. A tree shrugs at the same cell, which
#: is why this is per-model rather than global, and qlib itself splits it the
#: same way: `benchmarks/Linear/workflow_config_linear_Alpha158.yaml` normalises,
#: `benchmarks/LightGBM/workflow_config_lightgbm_Alpha158.yaml` does not, and the
#: Alpha360 one goes out of its way to write `infer_processors: []`.
_NEEDS_FINITE_FEATURES = {"linear"}

#: Copied from `benchmarks/Linear/workflow_config_linear_Alpha158.yaml`.
#:
#: `clip_outlier` is what makes this total rather than merely likely:
#: `np.clip(inf, -3, 3)` is 3, and whatever the clip leaves as NaN -- a column
#: more than half infinite makes the fitted median itself infinite -- is filled.
#: So the feature group comes out finite whatever the expression divided by.
#:
#: Only the feature group. The label is left to `CSZScoreNorm` + `DropnaLabel`,
#: which already handle an infinite label by NaN-ing its whole date and dropping
#: it, and normalising a label twice would be worse than not at all.
_FINITE_INFER_PROCESSORS = [
    {"class": "RobustZScoreNorm",
     "kwargs": {"fields_group": "feature", "clip_outlier": True}},
    {"class": "Fillna", "kwargs": {"fields_group": "feature"}},
]


def _processor_recipe(handler: str, model: str, fit_start: str, fit_end: str) -> tuple[list, list]:
    """The processors this handler and model need.

    A custom feature set cannot use `class: Alpha158`, because Alpha158 hard-wires
    its own `get_feature_config()` into its loader. So the config names
    `DataHandlerLP` directly -- and `DataHandlerLP` has no processors by default,
    while `Alpha158.__init__` runs `check_transform_proc` over its own defaults
    before calling up. Reproduce that, or the model silently trains on
    unnormalised columns with the label never dropped for NaN.

    Read out of qlib rather than transcribed: the defaults come from the
    handler's signature and the fit-date injection is qlib's own function. That
    matters because `ZScoreNorm.__init__(self, fit_start_time, fit_end_time, ...)`
    takes them as *required positionals*, so Alpha360 without them dies at
    construction -- while `CSZScoreNorm` takes neither, so for Alpha158 the
    injection is a no-op. A hand-written table would have to get both right.

    The one place we do *not* follow the handler is the infer list for a model in
    `_NEEDS_FINITE_FEATURES`. `Alpha158`'s own default there is `[]` -- it does
    not normalise at all -- and a linear model cannot survive that on real data.
    `RobustZScoreNorm` takes the fit window as required positionals too, so it
    goes through the same injection.
    """
    import copy as _copy
    import inspect as _inspect

    from qlib.contrib.data.handler import Alpha158, Alpha360, check_transform_proc

    cls = {"Alpha158": Alpha158, "Alpha360": Alpha360}[handler]
    defaults = _inspect.signature(cls.__init__).parameters
    infer = (_FINITE_INFER_PROCESSORS if model in _NEEDS_FINITE_FEATURES
             else defaults["infer_processors"].default)

    # Deep-copied because `check_transform_proc` writes the fit window *into* the
    # kwargs dict it was given -- `get_callable_kwargs` returns `config["kwargs"]`
    # itself, not a copy -- and every list here is a module-level default shared
    # by every caller: ours above, and qlib's own `_DEFAULT_INFER_PROCESSORS` for
    # Alpha360. Without this, two specs built concurrently write each other's
    # training dates into a normaliser they both point at.
    return (
        check_transform_proc(_copy.deepcopy(infer), fit_start, fit_end),
        check_transform_proc(_copy.deepcopy(defaults["learn_processors"].default),
                             fit_start, fit_end),
    )


def _custom_handler(spec: StrategySpec) -> dict:
    """A DataHandlerLP that computes the user's own columns.

    Note what is *not* here: `fit_start_time` / `fit_end_time`.
    `DataHandler.__init__` takes no `**kwargs`, so passing the shared
    `data_handler_config` straight through raises
    ``TypeError: got an unexpected keyword argument 'fit_start_time'`` -- at run
    time, minutes in, not at preview. The fit window still reaches the
    processors, which is where it belongs.
    """
    from .factorlab.indicators import handler_label

    label_expressions, label_names = handler_label(spec.handler)
    custom = {
        "feature": [
            [f.expression for f in spec.features],
            [f.name for f in spec.features],
        ],
        # The label has to ride with the custom loader. `Alpha158DL` emits a
        # feature group only, so a nest of it alone yields a handler with no
        # LABEL0 and a dataset that trains on nothing at all.
        #
        # Two lists rather than a tuple: `DLWParser._parse_fields_info` accepts
        # either, and only lists survive `yaml.safe_dump`.
        "label": [list(label_expressions), list(label_names)],
    }
    custom_loader = {
        "class": "QlibDataLoader",
        "module_path": "qlib.data.dataset.loader",
        "kwargs": {"config": custom},
    }

    if spec.feature_mode == "replace":
        data_loader = custom_loader
    else:
        data_loader = {
            "class": "NestedDataLoader",
            "module_path": "qlib.data.dataset.loader",
            # The custom loader goes SECOND on purpose. NestedDataLoader drops
            # the accumulated frame's duplicate columns and keeps the later
            # loader's, so if the collision guard is ever bypassed the loss is a
            # redundant base column rather than the user's own factor vanishing
            # from a model they believe is trading it.
            "kwargs": {"dataloader_l": [_BASE_LOADERS[spec.handler], custom_loader]},
        }

    infer, learn = _processor_recipe(spec.handler, spec.model,
                                     spec.train_start, spec.train_end)
    return {
        "class": "DataHandlerLP",
        "module_path": "qlib.data.dataset.handler",
        "kwargs": {
            "instruments": spec.universe,
            "start_time": spec.train_start,
            "end_time": spec.test_end,
            "infer_processors": infer,
            "learn_processors": learn,
            "process_type": "append",
            "data_loader": data_loader,
        },
    }


#: Handler columns that need a store column the EODHD stores do not carry.
#:
#: `FileFeatureStorage` returns an empty series for a missing `.bin` rather than
#: raising, so `$vwap` evaluates to NaN at every row and Alpha158's `VWAP0` is
#: an all-NaN column. The GBDT models tolerate that silently. `LinearModel.fit`
#: does `df_train.dropna()` across every feature, so one all-NaN column drops
#: *every* row -- verified: 0 of 5332 survive -- and the run dies minutes in
#: with "Empty data from dataset, please check your dataset config."
#:
#: Alpha158 reads `$vwap` once, in `VWAP0`. **Alpha360 reads it sixty times.**
#: `Alpha360DL.get_feature_config` emits `Ref($vwap, i)/$close` for i in 1..59
#: plus `$vwap/$close`, so VWAP0..VWAP59 are all in the handler. This map used
#: to say `"Alpha360": {}`, which read as "Alpha360 is unaffected" when it is in
#: fact the worse case: Alpha158 + linear was quietly saved by the DropCol below
#: while Alpha360 + linear died every time.
#:
#: See `factorlab/stores.py`, which exists for the same trap.
_COLUMNS_NEEDING: dict[str, dict[str, str]] = {
    "Alpha158": {"VWAP0": "vwap"},
    "Alpha360": {f"VWAP{i}": "vwap" for i in range(60)},
}


def _dead_columns(handler: str, provider_uri: str) -> list[str]:
    """Handler columns this store cannot compute, so they are all-NaN."""
    from .factorlab.stores import census

    needs = _COLUMNS_NEEDING.get(handler)
    if not needs:
        return []
    available = set(census(provider_uri).get("fields", []))
    if not available:  # no census (missing store) -- do not guess
        return []
    return sorted(col for col, field in needs.items() if field not in available)


def build_workflow_config(spec: StrategySpec, provider_uri: str, region: str) -> dict:
    """Render a StrategySpec into a qlib workflow config dict.

    Mirrors the structure of the bundled LightGBM/Alpha158 benchmark so a
    generated config can be run by `qrun` with no special handling.
    """
    model = MODEL_SPECS[spec.model]

    # Never let a config end on the store's final bar.
    #
    # `TradeCalendarManager.get_step_time` reads `calendar[i + 1]`, so a backtest
    # ending on the last day raises `IndexError: index 4174 is out of bounds` --
    # but only when a trade decision lands on that bar, which is why it killed
    # two runs in data/runs/ and spared two others with the same end date.
    # Intermittent is worse than broken.
    #
    # Clamping the whole spec once, here, means the four places below that read
    # `test_end` -- including `_custom_handler`, which never sees the store --
    # are all covered, and no caller can route around it. The spec the user
    # saved is untouched; only what qrun is handed is bounded.
    safe_end = store_calendar_end(spec.data_store)
    if safe_end and spec.test_end > safe_end:
        spec = spec.model_copy(update={"test_end": safe_end})

    data_handler_config = {
        "start_time": spec.train_start,
        "end_time": spec.test_end,
        "fit_start_time": spec.train_start,
        "fit_end_time": spec.train_end,
        "instruments": spec.universe,
    }

    # Two reasons to spell the processors out rather than leave the handler to
    # its own defaults, and either one alone is enough:
    #
    #   dead columns    they have to be dropped before anything else touches
    #                   them, so a list has to exist to put `DropCol` at the
    #                   front of.
    #   a linear model  `Alpha158`'s default infer list is `[]`, so without this
    #                   the model trains on raw columns and dies on the first
    #                   infinity. See `_NEEDS_FINITE_FEATURES`.
    #
    # When neither holds, the keys stay absent -- which is what keeps an ordinary
    # lightgbm config byte-identical to what this function emitted before either
    # feature existed, anchor and all.
    dead = _dead_columns(spec.handler, provider_uri)
    if dead or spec.model in _NEEDS_FINITE_FEATURES:
        infer, learn = _processor_recipe(spec.handler, spec.model,
                                         spec.train_start, spec.train_end)
        if dead:
            drop = {"class": "DropCol", "module_path": "qlib.data.dataset.processor",
                    "kwargs": {"col_list": dead}}
            infer, learn = [drop, *infer], [drop, *learn]
        data_handler_config["infer_processors"] = infer
        data_handler_config["learn_processors"] = learn

    exchange_kwargs: dict[str, Any] = {
        "deal_price": "close",
        "open_cost": spec.open_cost,
        "close_cost": spec.close_cost,
        "min_cost": spec.min_cost,
    }
    # qlib treats limit_threshold=None as "no limit"; passing 0.095 on US data
    # would wrongly block perfectly ordinary moves.
    if spec.limit_threshold is not None:
        exchange_kwargs["limit_threshold"] = spec.limit_threshold

    port_analysis_config = {
        "strategy": {
            "class": "TopkDropoutStrategy",
            "module_path": "qlib.contrib.strategy",
            "kwargs": {"signal": "<PRED>", "topk": spec.topk, "n_drop": spec.n_drop},
        },
        "backtest": {
            "start_time": spec.test_start,
            "end_time": spec.test_end,
            "account": spec.account,
            "benchmark": spec.benchmark,
            "exchange_kwargs": exchange_kwargs,
        },
    }

    return {
        "qlib_init": {"provider_uri": provider_uri, "region": region},
        "market": spec.universe,
        "benchmark": spec.benchmark,
        "data_handler_config": data_handler_config,
        "port_analysis_config": port_analysis_config,
        "task": {
            "model": {
                "class": model["class"],
                "module_path": model["module_path"],
                "kwargs": model["kwargs"],
            },
            "dataset": {
                "class": "DatasetH",
                "module_path": "qlib.data.dataset",
                "kwargs": {
                    # Without custom features this is the SAME dict object as the
                    # top-level `data_handler_config`, which is what makes
                    # safe_dump emit &id001/*id001 -- and what makes the config
                    # for an ordinary strategy byte-identical to what this
                    # function produced before custom features existed.
                    "handler": (
                        _custom_handler(spec) if spec.features else {
                            "class": spec.handler,
                            "module_path": HANDLERS[spec.handler],
                            "kwargs": data_handler_config,
                        }
                    ),
                    "segments": {
                        "train": [spec.train_start, spec.train_end],
                        "valid": [spec.valid_start, spec.valid_end],
                        "test": [spec.test_start, spec.test_end],
                    },
                },
            },
            "record": [
                {"class": "SignalRecord", "module_path": "qlib.workflow.record_temp",
                 "kwargs": {"model": "<MODEL>", "dataset": "<DATASET>"}},
                {"class": "SigAnaRecord", "module_path": "qlib.workflow.record_temp",
                 "kwargs": {"ana_long_short": False, "ann_scaler": 252}},
                # The bundled benchmarks pass the port-analysis config here by
                # YAML anchor (*port_analysis_config), not by placeholder --
                # qrun substitutes <MODEL>/<DATASET>/<PRED> but nothing else, so
                # a "<PORT_ANA_CONFIG>" string reaches PortAnaRecord verbatim and
                # dies on config["strategy"]. Reusing the same dict object makes
                # safe_dump emit a real anchor/alias pair.
                {"class": "PortAnaRecord", "module_path": "qlib.workflow.record_temp",
                 "kwargs": {"config": port_analysis_config}},
            ],
        },
    }


def coverage_report(spec: StrategySpec, provider_uri: str) -> dict:
    """What this store can and cannot compute for this spec.

    Deliberately **not** part of `validate_windows()` / `validate_features()`.
    Those flow into the builder's blocker list, which disables the Run button,
    and none of this should ever do that: a store missing a handler column
    produces a run that is *correct*, because `build_workflow_config` drops the
    column before training. Blocking it would refuse a run that works.

    So this is advisory, and it is the only place the reader is told the facts
    that otherwise surface as a failed run twenty minutes later:

      `dead` + `linear`  the combination that empties the training set. Every
                         row with a gap is dropped, so one all-NaN column drops
                         all of them.
      `proxy`            a column that computes, but is not what it is called.

    **Two halves, and saying which is which is the point.** `dead_columns` is
    about the *handler* -- a static map of which built-in column needs which
    store field. The `feature_*` keys are about the user's *own* expressions.
    This used to be the handler half alone, and a reader who saw "every column
    is present" reasonably took it to cover the factors they had just written,
    which it did not.

    A field a custom expression names that this store does not carry at all is
    not reported here: `validate_features` already refuses it outright with
    `unknown_field`, and repeating a blocker as an advisory reads as a second,
    milder problem.
    """
    from .factorlab.expressions import fields_read
    from .factorlab.stores import census

    found = census(provider_uri)
    dead = _dead_columns(spec.handler, provider_uri)

    # Reuse `found` rather than calling `census` again per feature: it is cached
    # on the features directory's mtime, but the gallery lowers thirty specs at
    # a time and each miss sorts a ten-thousand-entry directory.
    #
    # Both halves come off `found` rather than off `PROXY_FIELDS` directly:
    # that table lists what a field *would* be if the store carried it, and a
    # store without `vwap` at all has no vwap proxy to warn about -- it has an
    # `unknown_field` blocker, which is somebody else's job.
    proxy = found.get("proxy", {})
    partial = set(found.get("partial", []))
    read: set[str] = set()
    for feature in spec.features or []:
        read |= fields_read(feature.expression)

    return {
        "store": spec.data_store,
        "checked": bool(found["exists"]),
        "handler": spec.handler,
        "model": spec.model,
        "dead_columns": dead,
        # The config already handles it. Saying so is what keeps the warning
        # honest -- a banner that only cries danger about a case already fixed
        # teaches people to skip banners.
        "dropped": bool(dead),
        "proxy_columns": proxy,
        "partial_columns": found.get("partial", []),
        # Fields the user's own expressions read, and what is off about them.
        "feature_proxy_fields": {f: proxy[f] for f in sorted(read & set(proxy))},
        "feature_partial_fields": sorted(read & partial),
    }


def render_yaml(spec: StrategySpec, provider_uri: str, region: str) -> str:
    """The exact text handed to qrun — shown in the builder so nothing is hidden."""
    config = build_workflow_config(spec, provider_uri, region)
    # qrun resolves these placeholders itself; they must stay unquoted strings.
    return yaml.safe_dump(config, sort_keys=False, default_flow_style=False, width=100)


class StrategyStore:
    """Strategies as YAML files on disk — inspectable and diffable."""

    def __init__(self, directory: Path):
        self.dir = directory
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, strategy_id: str) -> Path:
        # Defend the path join: ids come off the URL.
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", strategy_id):
            raise ValueError(f"Invalid strategy id: {strategy_id!r}")
        return self.dir / f"{strategy_id}.yaml"

    def list(self) -> list[StoredStrategy]:
        out: list[StoredStrategy] = []
        for path in sorted(self.dir.glob("*.yaml")):
            try:
                out.append(StoredStrategy(**yaml.safe_load(path.read_text())))
            except Exception:  # a hand-edited file should not break the list
                continue
        return sorted(out, key=lambda s: s.updated_at, reverse=True)

    def get(self, strategy_id: str) -> StoredStrategy | None:
        path = self._path(strategy_id)
        if not path.exists():
            return None
        return StoredStrategy(**yaml.safe_load(path.read_text()))

    def create(self, spec: StrategySpec) -> StoredStrategy:
        now = datetime.now(timezone.utc).isoformat()
        stored = StoredStrategy(
            **spec.model_dump(), id=uuid.uuid4().hex[:12], created_at=now, updated_at=now
        )
        self._path(stored.id).write_text(yaml.safe_dump(stored.model_dump(), sort_keys=False))
        return stored

    def update(self, strategy_id: str, spec: StrategySpec) -> StoredStrategy | None:
        existing = self.get(strategy_id)
        if existing is None:
            return None
        stored = StoredStrategy(
            **spec.model_dump(),
            id=existing.id,
            created_at=existing.created_at,
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
        self._path(strategy_id).write_text(yaml.safe_dump(stored.model_dump(), sort_keys=False))
        return stored

    def upsert(self, strategy_id: str, spec: StrategySpec) -> StoredStrategy:
        """Write ``spec`` at a caller-chosen id, creating or replacing in place.

        `create` mints a uuid, which is right for the UI and useless to the
        demo seeder: re-running it would pile up a fresh copy of every demo
        strategy each time. With a stable id the seeder is idempotent for free,
        and `created_at` survives so the second run is visibly an update rather
        than a new record.
        """
        existing = self.get(strategy_id)
        now = datetime.now(timezone.utc).isoformat()
        stored = StoredStrategy(
            **spec.model_dump(),
            id=strategy_id,
            created_at=existing.created_at if existing else now,
            updated_at=now,
        )
        self._path(strategy_id).write_text(yaml.safe_dump(stored.model_dump(), sort_keys=False))
        return stored

    def delete(self, strategy_id: str) -> bool:
        path = self._path(strategy_id)
        if not path.exists():
            return False
        path.unlink()
        return True
