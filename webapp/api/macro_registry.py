"""The curated macro series, and how each one becomes a comparable change.

Everything here is judgement, which is why it is typed Python and not config:
which series are worth putting in front of someone, what group they belong to,
and -- the load-bearing one -- whether a level is differenced or log-returned.

Three feed quirks are pinned here rather than discovered at 3am:

* **``TNX``/``TYX``/``FVX`` quote ten times the yield.** ``TNX`` last printed
  46.6 against ``US10Y``'s 4.651. ``IRX`` does *not* -- it printed 3.71 against
  ``US3M``'s 3.801. They are also ~1.0 correlated with the ``US*Y`` series, so
  they are aliases with a scale factor, never registry members: two near-
  identical columns in one design matrix make it singular.
* **A yield is differenced, never log-returned.** ``US3M`` traded at 0.01-0.02
  through 2020-21, where ``log(0.01 / 0.02)`` is a -69% "return" on a one basis
  point move and ``log(0)`` is ``-inf``. `_check_registry` refuses that pairing
  in both directions at import time.
* **Credit and inflation proxies are ETFs in the qlib store**, not parquet in
  the market store, so ``source`` has to say which reader to use.

The default basket is deliberately small and deliberately not collinear -- see
``default_basket``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Group = Literal[
    "rates", "inflation", "growth", "volatility", "dollar", "commodities", "credit"
]
Unit = Literal["percent", "index", "log_ratio"]
Transform = Literal["diff", "log_return"]
Source = Literal["market", "qlib", "derived", "eodhd_indicator"]

GROUP_ORDER: tuple[Group, ...] = (
    "rates", "inflation", "growth", "volatility", "dollar", "commodities", "credit",
)

GROUP_LABELS: dict[Group, str] = {
    "rates": "Rates",
    "inflation": "Inflation",
    "growth": "Growth",
    "volatility": "Volatility",
    "dollar": "Dollar",
    "commodities": "Commodities",
    "credit": "Credit",
}


@dataclass(frozen=True)
class Derivation:
    """How a derived series is built from two others.

    ``spread`` is ``left - right`` and requires both sides to share a unit --
    subtracting an index level from a yield is meaningless, and the registry
    check refuses it. ``log_ratio`` is ``ln(left / right)``, whose difference is
    the relative performance of the two legs, which is what makes a pair of
    ETFs into a credit or breakeven proxy.
    """

    kind: Literal["spread", "log_ratio"]
    left: str
    right: str


@dataclass(frozen=True)
class MacroSeries:
    key: str
    label: str
    group: Group
    unit: Unit
    #: The returns-vs-differences rule, declared once and read only in
    #: ``macro.change``. `percent` implies `diff`; see the module docstring.
    transform: Transform
    source: Source = "market"
    #: On-disk symbol. Defaults to ``key`` when they agree, which is usual.
    symbol: str | None = None
    #: Which ``market_dir`` subdirectory holds it. Ignored for other sources.
    asset_class: str = "index"
    #: Raw close * scale -> the canonical unit. Only aliases need this.
    scale: float = 1.0
    derivation: Derivation | None = None
    #: Member of the default OLS regressor set.
    in_basket: bool = False
    #: False for annual/stepwise data, which is banned from daily analytics.
    daily_ok: bool = True
    note: str = ""

    @property
    def resolved_symbol(self) -> str:
        return self.symbol or self.key

    @property
    def change_unit(self) -> Literal["bps", "log"]:
        """What one unit of ``change`` means.

        Only a *percent* series differenced gives basis points. A log_ratio
        differenced is the difference of two log returns -- a relative
        performance move, which reads on the same scale as a log return and
        must not be labelled "bps" or the axis is off by 10,000x.
        """
        return "bps" if (self.transform == "diff" and self.unit == "percent") else "log"


def _s(*args, **kwargs) -> MacroSeries:
    return MacroSeries(*args, **kwargs)


_ENTRIES: tuple[MacroSeries, ...] = (
    # --- rates ------------------------------------------------------------
    # Yields in percent, differenced, reported in basis points.
    _s("US3M", "3-month T-bill", "rates", "percent", "diff",
       note="The front end — effectively the policy rate."),
    _s("US2Y", "2-year Treasury", "rates", "percent", "diff", in_basket=True,
       note="The policy-expectations tenor. In the basket instead of the 10Y "
            "because it is far less collinear with the curve slope."),
    _s("US5Y", "5-year Treasury", "rates", "percent", "diff"),
    _s("US10Y", "10-year Treasury", "rates", "percent", "diff",
       note="The benchmark long rate. Not in the basket — d(10Y) and "
            "d(10Y−2Y) share a term by construction."),
    _s("US30Y", "30-year Treasury", "rates", "percent", "diff"),
    _s("SLOPE_2S10S", "Curve 10Y−2Y", "rates", "percent", "diff",
       source="derived", in_basket=True,
       derivation=Derivation("spread", "US10Y", "US2Y"),
       note="Term premium. Negative is an inverted curve."),
    _s("SLOPE_3M10Y", "Curve 10Y−3M", "rates", "percent", "diff",
       source="derived",
       derivation=Derivation("spread", "US10Y", "US3M")),

    # --- inflation --------------------------------------------------------
    _s("BREAKEVEN_PROXY", "Breakeven proxy (TIP/IEF)", "inflation", "log_ratio", "diff",
       source="derived",
       derivation=Derivation("log_ratio", "TIP_ETF", "IEF_ETF"),
       note="TIPS against nominal Treasuries of similar duration — a relative-"
            "performance proxy for inflation compensation, not a breakeven in "
            "percent. Read the direction, not the level."),
    _s("CPI_YOY_US", "US CPI (annual %)", "inflation", "percent", "diff",
       source="eodhd_indicator", daily_ok=False,
       note="Annual World Bank series from EODHD. One print a year, so it is "
            "a context tile — never a daily regressor."),

    # --- growth -----------------------------------------------------------
    _s("GSPC", "S&P 500", "growth", "index", "log_return", in_basket=True,
       note="The market factor. Most strategies here are long equities, so "
            "this usually dominates — which is the point of including it."),
    _s("NDX", "Nasdaq 100", "growth", "index", "log_return"),
    _s("DJI", "Dow Jones Industrial", "growth", "index", "log_return"),
    _s("STOXX", "Stoxx Europe 600", "growth", "index", "log_return"),
    _s("N225", "Nikkei 225", "growth", "index", "log_return"),
    _s("HSI", "Hang Seng", "growth", "index", "log_return"),
    _s("COPPER_GOLD", "Copper/gold", "growth", "log_ratio", "diff",
       source="derived",
       derivation=Derivation("log_ratio", "BCOMHG", "BCOMGC"),
       note="The classic cyclical-growth read: industrial demand against the "
            "safe haven."),

    # --- volatility -------------------------------------------------------
    _s("VIX", "VIX", "volatility", "index", "log_return", in_basket=True,
       note="Equity implied vol. Also the regime attribution's vol axis."),
    _s("VXN", "VXN (Nasdaq vol)", "volatility", "index", "log_return"),
    _s("MOVE", "MOVE (rates vol)", "volatility", "index", "log_return"),
    _s("GVZ", "GVZ (gold vol)", "volatility", "index", "log_return"),
    _s("OVX", "OVX (oil vol)", "volatility", "index", "log_return"),

    # --- dollar -----------------------------------------------------------
    _s("DXY", "Dollar index", "dollar", "index", "log_return", in_basket=True),
    _s("AXY", "Asia dollar index", "dollar", "index", "log_return"),
    _s("CXY", "Commodity currency index", "dollar", "index", "log_return"),

    # --- commodities ------------------------------------------------------
    _s("BCOM", "Bloomberg Commodity", "commodities", "index", "log_return", in_basket=True,
       note="Broad basket. The single commodity regressor, so the subindices "
            "below stay out of the design matrix."),
    _s("BCOMCL", "WTI crude", "commodities", "index", "log_return"),
    _s("BCOMGC", "Gold", "commodities", "index", "log_return"),
    _s("BCOMHG", "Copper", "commodities", "index", "log_return"),
    _s("BCOMNG", "Natural gas", "commodities", "index", "log_return"),

    # --- credit -----------------------------------------------------------
    # ETFs, so they come from the qlib store rather than the market parquet.
    _s("CREDIT_HY_IG", "HY vs IG (HYG/LQD)", "credit", "log_ratio", "diff",
       source="derived", in_basket=True,
       derivation=Derivation("log_ratio", "HYG_ETF", "LQD_ETF"),
       note="High yield against investment grade — the cleanest daily credit "
            "read available from price data alone. Falling means spreads "
            "widening."),
    _s("CREDIT_HY_UST", "HY vs Treasuries (HYG/IEF)", "credit", "log_ratio", "diff",
       source="derived",
       derivation=Derivation("log_ratio", "HYG_ETF", "IEF_ETF")),

    # --- ETF legs ---------------------------------------------------------
    # Not offered on their own — they exist so the derived series above have
    # inputs. `offered()` filters them out of the catalog; `get()` still
    # resolves them so `macro.level` can recurse.
    _s("HYG_ETF", "HYG", "credit", "index", "log_return",
       source="qlib", symbol="HYG", asset_class="etf"),
    _s("LQD_ETF", "LQD", "credit", "index", "log_return",
       source="qlib", symbol="LQD", asset_class="etf"),
    _s("IEF_ETF", "IEF", "rates", "index", "log_return",
       source="qlib", symbol="IEF", asset_class="etf"),
    _s("TIP_ETF", "TIP", "inflation", "index", "log_return",
       source="qlib", symbol="TIP", asset_class="etf"),
)

SERIES: dict[str, MacroSeries] = {e.key: e for e in _ENTRIES}

#: Series that exist only as inputs to a derivation. Kept out of the catalog so
#: the desk does not offer "HYG" as a macro indicator, which it is not.
INTERNAL: frozenset[str] = frozenset(
    k for k in SERIES if k.endswith("_ETF")
)

#: Feed symbols that mean the same thing as a registry key. `TNX` and friends
#: quote ten times the yield (verified: TNX 46.6 vs US10Y 4.651); `IRX` does
#: not (3.71 vs US3M 3.801). Getting this wrong is a silent 10x error in every
#: basis-point figure on the page, so `test_macro_registry` pins all four.
FALLBACK_SYMBOLS: dict[str, tuple[str, float]] = {
    "US10Y": ("TNX", 0.1),
    "US30Y": ("TYX", 0.1),
    "US5Y": ("FVX", 0.1),
    "US3M": ("IRX", 1.0),
}

#: Feed symbol -> registry key, for callers that arrive with a raw ticker.
ALIASES: dict[str, str] = {
    "TNX": "US10Y",
    "TYX": "US30Y",
    "FVX": "US5Y",
    "IRX": "US3M",
    "^VIX": "VIX",
    "^GSPC": "GSPC",
    "SPX": "GSPC",
}


def get(key: str) -> MacroSeries | None:
    """The series for ``key``, resolving aliases. None when unknown."""
    if not key:
        return None
    upper = key.upper()
    if upper in SERIES:
        return SERIES[upper]
    aliased = ALIASES.get(upper)
    return SERIES.get(aliased) if aliased else None


def offered() -> list[MacroSeries]:
    """Every series worth showing, in group order then declaration order."""
    order = {g: i for i, g in enumerate(GROUP_ORDER)}
    return sorted(
        (e for e in _ENTRIES if e.key not in INTERNAL),
        key=lambda e: (order.get(e.group, 99), _ENTRIES.index(e)),
    )


def by_group() -> dict[Group, list[MacroSeries]]:
    out: dict[Group, list[MacroSeries]] = {g: [] for g in GROUP_ORDER}
    for entry in offered():
        out[entry.group].append(entry)
    return {g: v for g, v in out.items() if v}


def default_basket() -> list[MacroSeries]:
    """The OLS regressor set: seven series, one per economic dimension.

    Small on purpose. Every added regressor costs degrees of freedom and, worse,
    invites collinearity — which is why this holds ``US2Y`` and the 2s10s slope
    rather than ``US10Y`` and the slope (those two share a term by construction),
    one broad commodity index rather than five subindices, and one equity index
    rather than six.
    """
    return [e for e in _ENTRIES if e.in_basket and e.daily_ok]


def inputs_of(series: MacroSeries) -> tuple[str, ...]:
    """The keys ``series`` is built from. Empty for a leaf."""
    if series.derivation is None:
        return ()
    return (series.derivation.left, series.derivation.right)


def leaves_of(key: str) -> tuple[str, ...]:
    """Every non-derived key reachable from ``key``, depth-first."""
    series = get(key)
    if series is None:
        return ()
    if series.derivation is None:
        return (series.key,)
    out: list[str] = []
    for child in inputs_of(series):
        for leaf in leaves_of(child):
            if leaf not in out:
                out.append(leaf)
    return tuple(out)


def _check_registry() -> None:
    """Structural invariants, asserted at import so a bad edit fails loudly.

    These are cheap and they guard the two mistakes that would otherwise ship
    silently and wrong: a log return taken on a near-zero yield, and a spread
    between two things measured in different units.
    """
    for key, entry in SERIES.items():
        if entry.key != key:
            raise ValueError(f"registry key {key!r} does not match entry key {entry.key!r}")
        if entry.unit == "percent" and entry.transform == "log_return":
            raise ValueError(
                f"{key}: a percent series must be differenced, not log-returned "
                "(US3M traded at 0.01 in 2021, where a log return is nonsense)"
            )
        if entry.unit == "index" and entry.transform != "log_return":
            raise ValueError(f"{key}: an index level should be log-returned")
        if entry.derivation is not None:
            if entry.source != "derived":
                raise ValueError(f"{key}: has a derivation but source is {entry.source!r}")
            for side in inputs_of(entry):
                child = SERIES.get(side)
                if child is None:
                    raise ValueError(f"{key}: derivation input {side!r} is not in the registry")
                if entry.derivation.kind == "spread" and child.unit != entry.unit:
                    raise ValueError(
                        f"{key}: spread legs must share a unit — {side} is "
                        f"{child.unit!r}, the spread is {entry.unit!r}"
                    )
        elif entry.source == "derived":
            raise ValueError(f"{key}: source is 'derived' but no derivation is set")

    for alias, target in ALIASES.items():
        if target not in SERIES:
            raise ValueError(f"alias {alias!r} points at unknown key {target!r}")
        if alias in SERIES:
            raise ValueError(f"alias {alias!r} shadows a real registry key")

    for key in FALLBACK_SYMBOLS:
        if key not in SERIES:
            raise ValueError(f"fallback for unknown key {key!r}")


_check_registry()
