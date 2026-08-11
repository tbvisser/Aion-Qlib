"""The Alpha158 expression vocabulary, generated from qlib's own feature config.

``Alpha158DL.get_feature_config`` can build 184 named expressions -- 9 candle
features, five price families and one volume family at five lags each, and 29
rolling operators across five windows. Until now none of it was reachable from
the app: the canvas offered ten curated factors and the /indicators route was a
placeholder.

**184 is the vocabulary; the handler trains on 158 of it.** ``Alpha158`` the
*handler* calls the same generator with a narrower config -- price lag 0 only,
four price fields, no volume family -- so 26 of these expressions are things the
generator can emit that no strategy actually sees. They are kept, because they
are valid expressions worth measuring and building from, and flagged with
``in_handler`` so the distinction is visible rather than implied. Getting this
wrong is not academic: ``VWAP0`` *is* one of the 158, and no store here has a
``$vwap`` column.

Three decisions shape this module.

**The family is known by construction, not parsed from the name.** Every family
and every rolling key gets its own call, because ``get_feature_config`` honours
``include``. The alternative -- generate all 184 and infer the family from a name
prefix -- gets ``LOW`` wrong: that key emits ``MIN5``..``MIN60``, so a prefix
match files five rolling indicators under the price family and then fails to find
a ``LOW`` group at all.

**qlib stays the authority for what an expression is.** We never retype an
expression; we ask for it. The only thing we own is the prose, transcribed from
qlib's inline comments, and a drift test walks the ``use("...")`` literals out of
qlib's source to prove the key set still matches.

**Handler membership is matched on the expression, not the name.** ``in_handler``
means "this exact expression is a column the handler computes", which is a
stronger and more useful claim than "a column with this name exists" -- and it is
the claim a custom feature set needs, because a user column that repeats a
handler name silently replaces it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

from qlib.contrib.data.loader import Alpha158DL

PRICE_FEATURES = ["OPEN", "HIGH", "LOW", "CLOSE", "VWAP"]
PRICE_WINDOWS = [0, 1, 2, 3, 4]
ROLLING_WINDOWS = [5, 10, 20, 30, 60]

# The 29 rolling keys, in qlib's own order. Pinned by a drift test that reads
# them back out of qlib's source, so a version that adds one fails loudly here
# rather than quietly serving 145 of 150 indicators.
ROLLING_KEYS = [
    "ROC", "MA", "STD", "BETA", "RSQR", "RESI", "MAX", "LOW", "QTLU", "QTLD",
    "RANK", "RSV", "IMAX", "IMIN", "IMXD", "CORR", "CORD", "CNTP", "CNTN",
    "CNTD", "SUMP", "SUMN", "SUMD", "VMA", "VSTD", "WVMA", "VSUMP", "VSUMN",
    "VSUMD",
]

# Transcribed from the comments in qlib/contrib/data/loader.py, tightened into
# one sentence each. qlib's own wording is kept where it is clearer than a
# paraphrase would be; the typos in the original ("diviation", "redisdual") are
# not.
_KBAR = {
    "KMID": "The body of the candle: close minus open, over open.",
    "KLEN": "The whole range of the candle, over open.",
    "KMID2": "The body as a share of the range -- how decisive the day was.",
    "KUP": "The upper shadow, over open.",
    "KUP2": "The upper shadow as a share of the range.",
    "KLOW": "The lower shadow, over open.",
    "KLOW2": "The lower shadow as a share of the range.",
    "KSFT": "Where the close sits in the range, over open.",
    "KSFT2": "Where the close sits in the range, as a share of it.",
}

_PRICE = {
    "OPEN": "The open price d days ago, over today's close.",
    "HIGH": "The high price d days ago, over today's close.",
    "LOW": "The low price d days ago, over today's close.",
    "CLOSE": "The close price d days ago, over today's close.",
    "VWAP": "The volume-weighted average price d days ago, over today's close.",
}

_VOLUME = "Volume d days ago, over today's volume."

_ROLLING = {
    "ROC": "Rate of change: the close d days ago over today's close.",
    "MA": "Simple moving average of close over d days, divided by today's close.",
    "STD": "Standard deviation of close over d days, divided by today's close.",
    "BETA": "Slope of close over d days, divided by today's close -- the trend's "
            "daily rate of change.",
    "RSQR": "R-squared of a line fitted to close over d days: how linear the trend is.",
    "RESI": "Residual from that fitted line, divided by today's close.",
    "MAX": "The highest close in the past d days, over today's close.",
    "LOW": "The lowest close in the past d days, over today's close. Emitted as MIN.",
    "QTLU": "The 80th percentile of close over d days, over today's close.",
    "QTLD": "The 20th percentile of close over d days, over today's close.",
    "RANK": "Where today's close sits within the past d days, 0 to 1.",
    "RSV": "Where the close sits between the d-day high and low -- the stochastic %K.",
    "IMAX": "Days since the highest price in the window. Part of the Aroon indicator.",
    "IMIN": "Days since the lowest price in the window. Part of the Aroon indicator.",
    "IMXD": "Days from the lowest-price day to the highest. Large values suggest "
            "downward momentum.",
    "CORR": "Correlation of close with log volume over d days.",
    "CORD": "Correlation of the price change ratio with the volume change ratio.",
    "CNTP": "Share of the past d days on which price rose.",
    "CNTN": "Share of the past d days on which price fell.",
    "CNTD": "Up days minus down days, as a share of the window.",
    "SUMP": "Total gain over total absolute change -- an RSI-like ratio.",
    "SUMN": "Total loss over total absolute change. Equals 1 - SUMP.",
    "SUMD": "Gains minus losses over total absolute change.",
    "VMA": "Simple moving average of volume over d days, divided by today's volume.",
    "VSTD": "Standard deviation of volume over d days, divided by today's volume.",
    "WVMA": "Volume-weighted volatility of the price change.",
    "VSUMP": "Total volume increase over total absolute volume change.",
    "VSUMN": "Total volume decrease over total absolute volume change. Equals 1 - VSUMP.",
    "VSUMD": "Volume increases minus decreases, over total absolute volume change.",
}

# Two indicators are constant by construction: CLOSE0 is `$close/$close` and
# VOLUME0 is `$volume/($volume+1e-12)`. qlib emits them because the price and
# volume families are generated uniformly over their window list, and window 0
# divides a field by itself. Neither is in the handler's own 158 -- the config
# Alpha158 uses omits the CLOSE family and the whole volume family, which is
# presumably why. They are kept and labelled rather than dropped, because a
# factor with zero variance has no information and an IC of NaN, and that is
# worth being told before you spend a minute measuring it.
CONSTANT = {"CLOSE0", "VOLUME0"}

#: The handlers whose feature sets we can report membership of.
HANDLERS = ("Alpha158", "Alpha360")


@lru_cache(maxsize=None)
def handler_columns(handler: str = "Alpha158") -> dict[str, str]:
    """Name -> expression for the columns a handler actually trains on.

    Read from qlib rather than transcribed, because the number and the config
    behind it are exactly the sort of thing that goes stale: ``Alpha158`` the
    handler calls ``Alpha158DL.get_feature_config`` with a *narrower* config than
    the generator's own default, and nothing announces that.

    ``get_feature_config`` is an instance method on the handler that never
    touches ``self``, and constructing a real handler would need a mounted store.
    ``object.__new__`` supplies a receiver without running ``__init__`` -- and if
    a future qlib does start reading ``self``, this raises here rather than
    quietly returning a different column set.

    Imported inside the function: ``contrib.data.handler`` drags in the whole
    ``DataHandlerLP`` processor stack, which the module-level ``loader`` import
    does not, and this package must stay importable on a machine with no store.
    """
    if handler == "Alpha158":
        from qlib.contrib.data.handler import Alpha158

        expressions, names = Alpha158.get_feature_config(object.__new__(Alpha158))
    elif handler == "Alpha360":
        # Alpha360 has no get_feature_config of its own -- it builds its loader
        # from Alpha360DL directly, so that is where its columns are decided.
        from qlib.contrib.data.loader import Alpha360DL

        expressions, names = Alpha360DL.get_feature_config()
    else:
        raise ValueError(f"No such handler {handler!r}. Known: {', '.join(HANDLERS)}")
    return dict(zip(names, expressions))


@lru_cache(maxsize=None)
def handler_label(handler: str = "Alpha158") -> tuple[list[str], list[str]]:
    """The (expressions, names) a handler uses as its label.

    Read rather than retyped for the usual reason, and needed because a custom
    feature set has to carry the label itself: ``Alpha158DL`` emits a *feature*
    group only, so nesting it alone produces a handler with no label at all and a
    dataset that trains on nothing.
    """
    from qlib.contrib.data.handler import Alpha158, Alpha360

    if handler not in HANDLERS:
        raise ValueError(f"No such handler {handler!r}. Known: {', '.join(HANDLERS)}")
    cls = Alpha158 if handler == "Alpha158" else Alpha360
    expressions, names = cls.get_label_config(object.__new__(cls))
    return list(expressions), list(names)

_FIELD = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)")


@dataclass(frozen=True)
class Indicator:
    name: str
    expression: str
    family: str
    group: str
    description: str
    window: int | None
    fields: list[str]
    constant: bool = False
    #: This exact expression is one of the columns Alpha158 trains on.
    in_handler: bool = False


def _emit(config: dict) -> list[tuple[str, str]]:
    """One `get_feature_config` call, as (name, expression) pairs."""
    fields, names = Alpha158DL.get_feature_config(config)
    return list(zip(names, fields))


def _make(name: str, expression: str, family: str, group: str,
          description: str, window: int | None) -> Indicator:
    return Indicator(
        name=name,
        expression=expression,
        family=family,
        group=group,
        description=description,
        window=window,
        fields=sorted(set(_FIELD.findall(expression))),
        constant=name in CONSTANT,
        # Matched on the expression, so the flag means "the handler computes
        # exactly this" rather than "the handler has a column with this name".
        in_handler=handler_columns().get(name) == expression,
    )


def build_library() -> list[Indicator]:
    """All 184, in qlib's own order within each family."""
    out: list[Indicator] = []

    for name, expression in _emit({"kbar": {}}):
        out.append(_make(name, expression, "kbar", name, _KBAR[name], None))

    for feature in PRICE_FEATURES:
        pairs = _emit({"price": {"windows": PRICE_WINDOWS, "feature": [feature]}})
        for (name, expression), window in zip(pairs, PRICE_WINDOWS):
            out.append(_make(name, expression, "price", feature,
                             _PRICE[feature], window))

    pairs = _emit({"volume": {"windows": PRICE_WINDOWS}})
    for (name, expression), window in zip(pairs, PRICE_WINDOWS):
        out.append(_make(name, expression, "volume", "VOLUME", _VOLUME, window))

    for key in ROLLING_KEYS:
        pairs = _emit({"rolling": {"windows": ROLLING_WINDOWS, "include": [key]}})
        for (name, expression), window in zip(pairs, ROLLING_WINDOWS):
            out.append(_make(name, expression, "rolling", key, _ROLLING[key], window))

    return out


def _note(missing: list[str], indicator: Indicator) -> str:
    columns = ", ".join(f"${m}" for m in missing)
    note = (
        f"This store has no {columns} column. qlib returns an empty series for a "
        f"missing column rather than failing, so {indicator.name} would evaluate "
        f"to NaN on every row without an error anywhere."
    )
    if indicator.in_handler:
        # The sentence this whole flag exists to make sayable. Today it applies
        # to exactly one indicator, VWAP0, and nothing else in the app would ever
        # tell you: every Alpha158 strategy run on this store trains on a column
        # that is dead at every row, and the run completes without complaint.
        note += (
            f" And {indicator.name} is one of the 158 columns the Alpha158 handler "
            f"trains on, so a strategy using that handler on this store is fitting "
            f"against a dead column -- silently, and to the end of the backtest."
        )
    return note


def library_payload(provider_uri: str | None = None) -> dict:
    """``GET /api/indicators``: the library, judged against one store.

    Without a store the shape is identical and every indicator is reported as
    runnable-unknown rather than runnable -- the honest answer when there is
    nothing to check against.
    """
    from .stores import census

    available: set[str] | None = None
    partial: list[str] = []
    proxy: dict[str, str] = {}
    if provider_uri:
        found = census(provider_uri)
        if found["exists"]:
            available = set(found["fields"])
            partial = found["partial"]
            proxy = found.get("proxy", {})

    rows = []
    missing_columns: set[str] = set()
    for indicator in build_library():
        missing = (
            sorted(f for f in indicator.fields if f not in available)
            if available is not None else []
        )
        missing_columns |= set(missing)
        row = {
            "name": indicator.name,
            "expression": indicator.expression,
            "family": indicator.family,
            "group": indicator.group,
            "description": indicator.description,
            "window": indicator.window,
            "fields": indicator.fields,
            "in_handler": indicator.in_handler,
            "runnable": None if available is None else not missing,
        }
        if missing:
            row["note"] = _note(missing, indicator)
        elif indicator.constant:
            row["note"] = (
                "Constant by construction -- this expression divides a field by "
                "itself, so it has zero variance and no information."
            )
        else:
            # A column that computes, but is not what its name promises. This
            # replaces the dead-column note rather than sitting beside it: once
            # $vwap exists the indicator *runs*, and the remaining question is
            # what it measures.
            reads_proxy = sorted(f for f in indicator.fields if f in proxy)
            if reads_proxy:
                row["note"] = " ".join(proxy[f] for f in reads_proxy)
                row["proxy_fields"] = reads_proxy
        rows.append(row)

    # Counted from the library rather than written down. The four literals that
    # used to live here were correct, which is exactly what makes a hardcoded
    # count dangerous -- it stays correct until the day it does not.
    library = build_library()
    families = [
        {
            "key": key,
            "label": label,
            "count": sum(1 for i in library if i.family == key),
            "in_handler": sum(1 for i in library if i.family == key and i.in_handler),
        }
        for key, label in (("kbar", "Candle"), ("price", "Price lags"),
                           ("volume", "Volume lags"), ("rolling", "Rolling"))
    ]

    return {
        "indicators": rows,
        "families": families,
        "windows": {"price": PRICE_WINDOWS, "rolling": ROLLING_WINDOWS},
        "handler": {
            "name": "Alpha158",
            "columns": sum(f["in_handler"] for f in families),
            "note": (
                "A strategy's handler decides what the model sees. Alpha158 "
                "computes 158 of the expressions below; the rest are part of the "
                "same generated vocabulary and can be measured or built on, but "
                "no strategy trains on them unless you add them yourself."
            ),
        },
        "store": {
            "provider_uri": provider_uri,
            "checked": available is not None,
            "missing_columns": sorted(missing_columns),
            "partial_columns": partial,
            # Columns that exist but are not what their name promises. Distinct
            # from `missing_columns`: those break an indicator, these change
            # what it means.
            "proxy_columns": proxy,
        },
    }
