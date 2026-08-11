"""What regime are we in — growth/inflation, policy, risk appetite, and price.

Four lenses, each a deterministic rule set over real data:

* **Growth / inflation quadrant** — the direction of CPI year-on-year and of
  unemployment (inverted) over six months, from the economic calendar.
* **Rate cycle** — where policy is in its cycle, from the front end of the
  Treasury curve, with the FOMC's own decisions carried alongside.
* **Risk appetite** — four averaged votes from daily cross-asset prices.
* **Market regime** — the price-based rates x volatility lens that already
  powers the per-strategy attribution, surfaced desk-wide.

The thresholds mirror the Aion Platform's macro service, which is this app's
design source. Two things differ, both deliberate and both argued at the point
of implementation below: the rate cycle rides the daily front end rather than
62 discrete decisions, and a residually flat axis reports ``Transitional``
rather than collapsing to "falling".

**Point-in-time is the load-bearing rule.** Every economic series is indexed on
its *release* date, never on the reference period it describes. The August CPI
reference period prints in September; keying on the period would make August's
figure visible on 1 August and turn every historical read into a lookahead
artefact that still looks entirely plausible.

**Structure.** Each lens builds one *daily state frame*, vectorised, which is
then read three ways: the current state, month-end history, and the conditioning
mask for the playbook. Aion replays a scalar classifier at each month-end; that
is a second code path from the daily state the playbook needs, and the two would
drift.

Every classifier returns ``"unknown"`` plus a human-readable ``reason`` when its
inputs are missing, keeping whatever partial data it did compute — so the UI can
show an honest empty state instead of a guess.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Literal, Sequence

import numpy as np
import pandas as pd

from . import macro, macro_cache
from . import macro_registry as registry
from .macro_analytics import (
    TRADING_DAYS,
    MacroAnalyticsError,
    _compress,
    _REGIME_LABELS,
    conditional_stats,
    market_regime_axes,
)

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Constants — Aion's thresholds, kept verbatim where they apply
# --------------------------------------------------------------------------
#: Percentage points a six-month change must exceed to count as a direction.
DELTA_PP = 0.1
#: Half a standard 25bp move — the rate-cycle threshold.
RATE_STEP = 0.125
#: Trading days for the risk composite's return legs.
RISK_WINDOW = 20
#: Trading days for the VIX median.
VIX_WINDOW = 60
#: A monthly print goes unknown rather than stale-forward past this many days.
#: Deliberately not ``macro_ffill_limit`` (5 sessions), which is right for a
#: daily series and would make every monthly print vanish a week after release.
MONTHLY_STALE_DAYS = 45
#: Fewer votes than this and the risk composite refuses. Aion will print a
#: confident label off a single leg.
MIN_VOTES = 2
#: Fed decisions publish the target range's UPPER bound (verified: 3.75, 4.00,
#: ... 5.50 in quarter-point steps), so the midpoint is half a step below.
FED_RANGE_WIDTH = 0.25

QUADRANT_LABELS: dict[tuple[str, str], str] = {
    ("rising", "rising"): "Reflation",
    ("rising", "falling"): "Goldilocks",
    ("falling", "rising"): "Stagflation",
    ("falling", "falling"): "Disinflationary Slowdown",
}
QUADRANT_SLUGS: dict[str, str] = {
    "Reflation": "reflation",
    "Goldilocks": "goldilocks",
    "Stagflation": "stagflation",
    "Disinflationary Slowdown": "disinflationary_slowdown",
    "Transitional": "transitional",
}
TRANSITIONAL = "Transitional"

RATE_SLUGS: dict[str, str] = {
    "Hiking": "hiking",
    "Cutting": "cutting",
    "Hold (post-hike plateau)": "hold_post_hike",
    "Hold (post-cut trough)": "hold_post_cut",
    "Neutral / on hold": "neutral",
}
RISK_SLUGS: dict[str, str] = {
    "Risk-On": "risk_on", "Risk-Off": "risk_off", "Neutral": "neutral",
}

#: Growth-typed releases, and whether a *beat* means stronger growth.
#:
#: Membership and sign are separate on purpose. Aion derives membership from
#: ``polarity > 0``, which silently excludes unemployment and jobless claims --
#: real growth information whose polarity is negative.
GROWTH_SURPRISE_POLARITY: dict[str, int] = {
    "gdp_growth_rate__qoq": 1,
    "ism_manufacturing_pmi": 1,
    "ism_services_pmi": 1,
    "non_farm_payrolls": 1,
    "adp_employment_change": 1,
    "retail_sales__mom": 1,
    "retail_sales__yoy": 1,
    "industrial_production__mom": 1,
    "unemployment_rate": -1,
    "initial_jobless_claims": -1,
    "continuing_jobless_claims": -1,
}
#: Trailing window the growth tie-break averages surprises over.
SURPRISE_WINDOW_DAYS = 90

INFLATION_KEYS = {"headline": "inflation_rate__yoy", "core": "core_inflation_rate__yoy"}
UNEMPLOYMENT_KEY = "unemployment_rate"
FED_DECISION_KEY = "fed_interest_rate_decision"

_lock = threading.Lock()
_states: dict[tuple, pd.DataFrame] = {}


def reset_cache() -> None:
    """Drop the derived state frames. Called after a macro refresh."""
    with _lock:
        _states.clear()


# --------------------------------------------------------------------------
# Dataclasses
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class AxisRead:
    direction: Literal["rising", "falling", "flat", "unknown"]
    delta_6m: float | None
    delta_3m: float | None
    latest: float | None
    latest_date: str | None
    source_key: str | None


@dataclass(frozen=True)
class QuadrantRead:
    label: str | None
    state: str
    growth: AxisRead
    inflation: AxisRead
    growth_tilt: float | None
    tie_break_used: bool
    as_of: str | None
    reason: str | None


@dataclass(frozen=True)
class RateCycleRead:
    stage: str
    state: str
    source: Literal["US3M", "fomc_decisions"]
    front_end: float | None
    delta_3m: float | None
    delta_12m: float | None
    policy_rate: float | None
    policy_rate_date: str | None
    front_end_vs_policy: float | None
    curve_spread: float | None
    inverted: bool | None
    as_of: str | None
    reason: str | None


@dataclass(frozen=True)
class RiskVote:
    name: str
    value: float | None
    vote: int


@dataclass(frozen=True)
class RiskRead:
    label: str
    state: str
    score: float | None
    components: list[RiskVote]
    missing: list[str]
    as_of: str | None
    reason: str | None


@dataclass(frozen=True)
class MarketRead:
    state: str
    label: str | None
    rates: str | None
    vol: str | None
    rates_momentum: float | None
    vol_z: float | None
    as_of: str | None
    reason: str | None


@dataclass(frozen=True)
class RegimeRead:
    as_of: str | None
    quadrant: QuadrantRead
    rate_cycle: RateCycleRead
    risk: RiskRead
    market: MarketRead
    headline_readings: list[dict]
    vintage: Literal["latest"]
    available: bool
    reason: str | None
    warnings: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------
# Primitives
# --------------------------------------------------------------------------
def _iso(stamp) -> str | None:
    if stamp is None or pd.isna(stamp):
        return None
    return pd.Timestamp(stamp).strftime("%Y-%m-%d")


def _clean(value) -> float | None:
    if value is None or pd.isna(value):
        return None
    number = float(value)
    return number if np.isfinite(number) else None


def _asof(series: pd.Series, index: pd.DatetimeIndex, days: int = 0) -> pd.Series:
    """Vectorised value-at-or-before. Aion's ``_value_at_or_before``, for a whole index."""
    if series.empty:
        return pd.Series(np.nan, index=index)
    target = index - pd.Timedelta(days=days) if days else index
    return pd.Series(np.asarray(series.asof(target), dtype="float64"), index=index)


def _staleness_mask(series: pd.Series, index: pd.DatetimeIndex) -> pd.Series:
    """True where the most recent print is older than ``MONTHLY_STALE_DAYS``."""
    if series.empty:
        return pd.Series(True, index=index)
    stamps = pd.Series(series.index, index=series.index).asof(index)
    age = pd.Series(index, index=index) - pd.to_datetime(pd.Series(stamps.to_numpy(), index=index))
    return age > pd.Timedelta(days=MONTHLY_STALE_DAYS)


def _monthly_daily(series: pd.Series, index: pd.DatetimeIndex) -> pd.Series:
    """A monthly release carried across ``index``, blanked once it goes stale."""
    out = _asof(series, index)
    out[_staleness_mask(series, index)] = np.nan
    return out


def _direction_frame(series: pd.Series, index: pd.DatetimeIndex) -> pd.DataFrame:
    """Vectorised ``_series_direction``: direction plus the two deltas.

    Precedence is Aion's exactly — the six-month change decides first, and the
    three-month change is consulted only when the six-month one sits inside the
    band. A six-month move of +0.2 with a three-month move of -0.5 is *rising*;
    inverting that loop is the easy mistake.
    """
    latest = _monthly_daily(series, index)
    back6 = _asof(series, index, 180)
    back3 = _asof(series, index, 90)
    delta6 = latest - back6
    delta3 = latest - back3

    direction = pd.Series("flat", index=index, dtype="object")
    direction[delta3 > DELTA_PP] = "rising"
    direction[delta3 < -DELTA_PP] = "falling"
    direction[delta6 > DELTA_PP] = "rising"
    direction[delta6 < -DELTA_PP] = "falling"
    # No six-month baseline and nothing decisive at three months: not enough
    # history to read a direction at all.
    direction[delta6.isna() & (delta3.isna() | (delta3.abs() <= DELTA_PP))] = None
    direction[latest.isna()] = None

    return pd.DataFrame(
        {"direction": direction, "delta_6m": delta6, "delta_3m": delta3, "latest": latest},
        index=index,
    )


def _growth_tilt(index: pd.DatetimeIndex, country: str) -> pd.Series:
    """Mean growth-typed surprise direction over a trailing window.

    ``dir = sign(actual - estimate) * polarity``, so a smaller-than-expected
    unemployment print counts as +1 rather than being dropped.
    """
    frame = macro_cache.calendar_frame()
    if frame is None or frame.empty:
        return pd.Series(np.nan, index=index)

    rows = frame[
        (frame["country"].str.upper() == country.upper())
        & frame["event_key"].isin(GROWTH_SURPRISE_POLARITY)
        & frame["surprise"].notna()
    ]
    if rows.empty:
        return pd.Series(np.nan, index=index)

    polarity = rows["event_key"].map(GROWTH_SURPRISE_POLARITY).astype(float)
    direction = np.sign(pd.to_numeric(rows["surprise"], errors="coerce")) * polarity
    daily = pd.Series(direction.to_numpy(), index=pd.DatetimeIndex(rows["date"])).sort_index()
    daily = daily.groupby(level=0).mean()

    # Trailing mean over SURPRISE_WINDOW_DAYS, evaluated on every index date.
    cumulative = daily.cumsum()
    counts = pd.Series(1.0, index=daily.index).cumsum()
    total = _asof(cumulative, index) - _asof(cumulative, index, SURPRISE_WINDOW_DAYS).fillna(0.0)
    n = _asof(counts, index) - _asof(counts, index, SURPRISE_WINDOW_DAYS).fillna(0.0)
    return (total / n.where(n > 0)).astype("float64")


# --------------------------------------------------------------------------
# Lens 1 — growth / inflation quadrant
# --------------------------------------------------------------------------
def quadrant_states(
    index: pd.DatetimeIndex | None = None,
    inflation: str = "headline",
    country: str = "US",
) -> pd.DataFrame:
    """Daily growth/inflation state, with the evidence that produced it."""
    if index is None:
        index = macro.reference_index()
    if len(index) == 0:
        return pd.DataFrame(index=pd.DatetimeIndex([]))

    key = (
        macro_cache.calendar_mtime(), _iso(index[-1]), len(index),
        "quadrant", inflation, country,
    )
    with _lock:
        hit = _states.get(key)
    if hit is not None:
        return hit

    inflation_key = INFLATION_KEYS.get(inflation, INFLATION_KEYS["headline"])
    cpi = macro_cache.release_series(inflation_key, country)
    unrate = macro_cache.release_series(UNEMPLOYMENT_KEY, country)

    infl = _direction_frame(cpi, index)
    unemp = _direction_frame(unrate, index)

    # Growth is unemployment inverted: falling unemployment is rising growth.
    growth_dir = unemp["direction"].map(
        {"rising": "falling", "falling": "rising"}
    ).where(unemp["direction"].isin(["rising", "falling"]), unemp["direction"])
    growth_delta6 = -unemp["delta_6m"]
    growth_delta3 = -unemp["delta_3m"]

    # Tie-break a flat growth axis on recent growth surprises.
    tilt = _growth_tilt(index, country)
    flat_growth = growth_dir == "flat"
    tie_used = flat_growth & tilt.notna() & (tilt != 0)
    growth_dir = growth_dir.mask(tie_used & (tilt > 0), "rising")
    growth_dir = growth_dir.mask(tie_used & (tilt < 0), "falling")

    label = pd.Series(None, index=index, dtype="object")
    for (g, i), name in QUADRANT_LABELS.items():
        label[(growth_dir == g) & (infl["direction"] == i)] = name
    # A residually flat axis is Transitional, NOT "falling".
    #
    # Aion collapses flat to falling, which is the one place it breaks its own
    # honesty contract: insufficient signal becomes a confident "Disinflationary
    # Slowdown". It is also a systematic bearish bias -- flat always collapses
    # downward -- and it poisons the playbook by funnelling every quiet month
    # into one cell whose statistics then converge on the unconditional average.
    known = growth_dir.isin(["rising", "falling", "flat"]) & infl["direction"].isin(
        ["rising", "falling", "flat"]
    )
    label[known & label.isna()] = TRANSITIONAL

    frame = pd.DataFrame({
        "label": label,
        "state": label.map(QUADRANT_SLUGS),
        "growth": growth_dir,
        "inflation": infl["direction"],
        "growth_delta_6m": growth_delta6,
        "growth_delta_3m": growth_delta3,
        "inflation_delta_6m": infl["delta_6m"],
        "inflation_delta_3m": infl["delta_3m"],
        "growth_latest": unemp["latest"],
        "inflation_latest": infl["latest"],
        "growth_tilt": tilt,
        "tie_break_used": tie_used,
    }, index=index)
    frame["inflation_key"] = inflation_key

    with _lock:
        _states[key] = frame
    return frame


def classify_quadrant(
    as_of: pd.Timestamp | None = None,
    inflation: str = "headline",
    country: str = "US",
) -> QuadrantRead:
    frame = quadrant_states(inflation=inflation, country=country)
    unknown = QuadrantRead(
        label=None, state="unknown",
        growth=AxisRead("unknown", None, None, None, None, UNEMPLOYMENT_KEY),
        inflation=AxisRead("unknown", None, None, None, None,
                           INFLATION_KEYS.get(inflation)),
        growth_tilt=None, tie_break_used=False, as_of=None,
        reason="No CPI or unemployment releases are cached yet.",
    )
    if frame.empty:
        return unknown

    row, stamp = _last_row(frame, as_of, "state")
    if row is None:
        row, stamp = frame.iloc[-1], frame.index[-1]

    cpi_dates = macro_cache.release_series(
        INFLATION_KEYS.get(inflation, INFLATION_KEYS["headline"]), country).index
    unrate_dates = macro_cache.release_series(UNEMPLOYMENT_KEY, country).index

    growth = AxisRead(
        direction=row["growth"] or "unknown",
        delta_6m=_clean(row["growth_delta_6m"]),
        delta_3m=_clean(row["growth_delta_3m"]),
        latest=_clean(row["growth_latest"]),
        latest_date=_iso(unrate_dates.max()) if len(unrate_dates) else None,
        source_key=UNEMPLOYMENT_KEY,
    )
    infl = AxisRead(
        direction=row["inflation"] or "unknown",
        delta_6m=_clean(row["inflation_delta_6m"]),
        delta_3m=_clean(row["inflation_delta_3m"]),
        latest=_clean(row["inflation_latest"]),
        latest_date=_iso(cpi_dates.max()) if len(cpi_dates) else None,
        source_key=str(row["inflation_key"]),
    )

    if not row["state"] or pd.isna(row["state"]):
        missing = "CPI" if growth.direction != "unknown" else "growth (unemployment)"
        return QuadrantRead(
            label=None, state="unknown", growth=growth, inflation=infl,
            growth_tilt=_clean(row["growth_tilt"]), tie_break_used=False,
            as_of=_iso(stamp),
            reason=f"Not enough {missing} history to read a direction.",
        )

    return QuadrantRead(
        label=str(row["label"]), state=str(row["state"]),
        growth=growth, inflation=infl,
        growth_tilt=_clean(row["growth_tilt"]),
        tie_break_used=bool(row["tie_break_used"]),
        as_of=_iso(stamp), reason=None,
    )


# --------------------------------------------------------------------------
# Lens 2 — rate cycle
# --------------------------------------------------------------------------
def rate_cycle_states(index: pd.DatetimeIndex | None = None) -> pd.DataFrame:
    """Daily policy-cycle stage from the front end of the curve.

    **Why ``US3M`` and not the 62 FOMC decisions.** Three reasons. The decisions
    only start in 2019, and both "Hold" stages are *defined* by a twelve-month
    lookback, so a decisions-only classifier leaves the whole 2015-18 hiking
    cycle and all of ZIRP unclassified and gives each Hold stage a single
    episode. The front end also *leads*: a three-month bill prices the policy
    path a quarter ahead, whereas classifying off decisions calls "Cutting"
    only once the first cut has printed, which is a report rather than a read.
    And ``RATE_STEP`` survives the translation — half a hike in 90 days filters
    bill noise perfectly well on a continuous series.

    The decisions are still carried, as ``policy_rate`` and
    ``front_end_vs_policy``, because the front end sitting well under the target
    *is* the market pricing a cut. Bill-supply and debt-ceiling distortions are
    the honest cost of this choice and are why the overlay exists.
    """
    if index is None:
        index = macro.reference_index()
    if len(index) == 0:
        return pd.DataFrame(index=pd.DatetimeIndex([]))

    key = (macro_cache.calendar_mtime(), _iso(index[-1]), len(index), "rate_cycle")
    with _lock:
        hit = _states.get(key)
    if hit is not None:
        return hit

    front = macro.level("US3M", index)
    source = "US3M"
    decisions = macro_cache.release_series(FED_DECISION_KEY, "US")

    if front.notna().sum() == 0:
        # Degrade to the decision series, and say so rather than going silent.
        front = _monthly_daily(decisions, index)
        source = "fomc_decisions"

    clean_front = front.dropna()
    back3 = _asof(clean_front, index, 90)
    back12 = _asof(clean_front, index, 365)
    delta3 = front - back3
    delta12 = front - back12

    stage = pd.Series("Neutral / on hold", index=index, dtype="object")
    stage[(delta3.abs() <= RATE_STEP) & (delta12 > RATE_STEP)] = "Hold (post-hike plateau)"
    stage[(delta3.abs() <= RATE_STEP) & (delta12 < -RATE_STEP)] = "Hold (post-cut trough)"
    stage[delta3 > RATE_STEP] = "Hiking"
    stage[delta3 < -RATE_STEP] = "Cutting"
    stage[front.isna() | back3.isna()] = None

    policy = _asof(decisions, index)
    # Fed decisions publish the target range's upper bound; the midpoint is the
    # comparable number. Without this the front end reads ~12bp "below policy"
    # even at perfect neutrality.
    policy_mid = policy - FED_RANGE_WIDTH / 2.0
    spread = macro.level("SLOPE_3M10Y", index)

    # object dtype, because "no curve on this date" is a third value that a
    # bool column cannot hold without pandas casting it to False.
    inverted = pd.Series(None, index=index, dtype="object")
    inverted[spread.notna()] = spread[spread.notna()] < 0

    frame = pd.DataFrame({
        "stage": stage,
        "state": stage.map(RATE_SLUGS),
        "front_end": front,
        "delta_3m": delta3,
        "delta_12m": delta12,
        "policy_rate": policy,
        "front_end_vs_policy": front - policy_mid,
        "curve_spread": spread,
        "inverted": inverted,
    }, index=index)
    frame["source"] = source

    with _lock:
        _states[key] = frame
    return frame


def classify_rate_cycle(as_of: pd.Timestamp | None = None) -> RateCycleRead:
    frame = rate_cycle_states()
    if frame.empty:
        return RateCycleRead(
            stage="unknown", state="unknown", source="US3M", front_end=None,
            delta_3m=None, delta_12m=None, policy_rate=None, policy_rate_date=None,
            front_end_vs_policy=None, curve_spread=None, inverted=None, as_of=None,
            reason="No policy-rate history is available.",
        )

    row, stamp = _last_row(frame, as_of, "state")
    if row is None:
        row, stamp = frame.iloc[-1], frame.index[-1]

    decisions = macro_cache.release_series(FED_DECISION_KEY, "US")
    inverted = row["inverted"]
    common = dict(
        source=str(row["source"]),
        front_end=_clean(row["front_end"]),
        delta_3m=_clean(row["delta_3m"]),
        delta_12m=_clean(row["delta_12m"]),
        policy_rate=_clean(row["policy_rate"]),
        policy_rate_date=_iso(decisions.index.max()) if len(decisions) else None,
        front_end_vs_policy=_clean(row["front_end_vs_policy"]),
        curve_spread=_clean(row["curve_spread"]),
        inverted=None if inverted is None or pd.isna(inverted) else bool(inverted),
        as_of=_iso(stamp),
    )

    if not row["state"] or pd.isna(row["state"]):
        # The level is still surfaced — partial data is reported, not withheld.
        return RateCycleRead(
            stage="unknown", state="unknown", **common,
            reason="Less than 3 months of front-end history.",
        )
    return RateCycleRead(
        stage=str(row["stage"]), state=str(row["state"]), **common, reason=None,
    )


# --------------------------------------------------------------------------
# Lens 3 — risk appetite
# --------------------------------------------------------------------------
#: (name, threshold low, threshold high, invert). A vote is +1 below ``lo`` and
#: -1 above ``hi``, or the reverse when inverted.
_RISK_LEGS = (
    ("SPX 20d return", -1.0, 1.0, True),
    ("VIX vs 60d median", -10.0, 15.0, False),
    ("DXY 20d return", -0.5, 0.5, False),
    ("GOLD/SPX 20d ratio", -1.0, 1.0, False),
)


def risk_states(index: pd.DatetimeIndex | None = None) -> pd.DataFrame:
    """Daily risk appetite from four averaged cross-asset votes."""
    if index is None:
        index = macro.reference_index()
    if len(index) == 0:
        return pd.DataFrame(index=pd.DatetimeIndex([]))

    key = (_iso(index[-1]), len(index), "risk")
    with _lock:
        hit = _states.get(key)
    if hit is not None:
        return hit

    spx = macro.level("GSPC", index)
    vix = macro.level("VIX", index)
    dxy = macro.level("DXY", index)
    gold = macro.level("BCOMGC", index)

    spx_ret = (spx / spx.shift(RISK_WINDOW) - 1.0) * 100.0
    gold_ret = (gold / gold.shift(RISK_WINDOW) - 1.0) * 100.0
    vix_median = vix.rolling(VIX_WINDOW, min_periods=VIX_WINDOW).median()

    values = {
        "SPX 20d return": spx_ret,
        "VIX vs 60d median": (vix / vix_median - 1.0) * 100.0,
        "DXY 20d return": (dxy / dxy.shift(RISK_WINDOW) - 1.0) * 100.0,
        "GOLD/SPX 20d ratio": ((1 + gold_ret / 100.0) / (1 + spx_ret / 100.0) - 1.0) * 100.0,
    }

    votes: dict[str, pd.Series] = {}
    for name, lo, hi, invert in _RISK_LEGS:
        value = values[name]
        vote = pd.Series(0.0, index=index)
        vote[value > hi] = 1.0 if invert else -1.0
        vote[value < lo] = -1.0 if invert else 1.0
        vote[value.isna()] = np.nan
        votes[name] = vote

    vote_frame = pd.DataFrame(votes, index=index)
    cast = vote_frame.notna().sum(axis=1)
    score = vote_frame.mean(axis=1)

    label = pd.Series("Neutral", index=index, dtype="object")
    label[score > 0.25] = "Risk-On"
    label[score < -0.25] = "Risk-Off"
    # Aion will print a confident label off a single leg; two is the floor.
    label[cast < MIN_VOTES] = None

    frame = pd.DataFrame({
        "label": label, "state": label.map(RISK_SLUGS),
        "score": score.where(cast >= MIN_VOTES), "votes_cast": cast,
    }, index=index)
    for name in values:
        frame[f"value::{name}"] = values[name]
        frame[f"vote::{name}"] = vote_frame[name]

    with _lock:
        _states[key] = frame
    return frame


def classify_risk(as_of: pd.Timestamp | None = None) -> RiskRead:
    frame = risk_states()
    if frame.empty:
        return RiskRead(
            label="unknown", state="unknown", score=None, components=[],
            missing=[name for name, *_ in _RISK_LEGS], as_of=None,
            reason="No market price series are available.",
        )

    row, stamp = _last_row(frame, as_of, "state")
    if row is None:
        row, stamp = frame.iloc[-1], frame.index[-1]

    components, missing = [], []
    for name, *_ in _RISK_LEGS:
        value = _clean(row[f"value::{name}"])
        vote = row[f"vote::{name}"]
        if value is None or pd.isna(vote):
            missing.append(name)
            continue
        components.append(RiskVote(name=name, value=value, vote=int(vote)))

    if not row["state"] or pd.isna(row["state"]):
        return RiskRead(
            label="unknown", state="unknown", score=None, components=components,
            missing=missing, as_of=_iso(stamp),
            reason=(
                f"Only {len(components)} of {len(_RISK_LEGS)} risk components had "
                f"data; {MIN_VOTES} are needed."
            ),
        )
    return RiskRead(
        label=str(row["label"]), state=str(row["state"]),
        score=_clean(row["score"]), components=components, missing=missing,
        as_of=_iso(stamp), reason=None,
    )


# --------------------------------------------------------------------------
# Lens 4 — market regime (price-based)
# --------------------------------------------------------------------------
def market_states(
    index: pd.DatetimeIndex | None = None,
    rates_key: str = "US2Y",
    vol_key: str = "VIX",
    momentum: int = 60,
    lookback: int = 756,
) -> pd.DataFrame:
    """Daily rates x volatility state.

    A thin wrapper over ``macro_analytics.market_regime_axes`` — the same
    computation the per-strategy attribution uses, so the desk tile and the
    shading on an equity curve cannot disagree.
    """
    try:
        axes = market_regime_axes(rates_key, vol_key, momentum, lookback, index=index)
    except MacroAnalyticsError:
        return pd.DataFrame(index=pd.DatetimeIndex([]))

    rates, vol = axes.rates_axis, axes.vol_axis
    known = rates.notna() & vol.notna()
    state = pd.Series(None, index=rates.index, dtype="object")
    label = pd.Series(None, index=rates.index, dtype="object")
    state[known] = rates[known].astype(str) + "_" + vol[known].astype(str)
    label[known] = [
        _REGIME_LABELS[(r, v)] for r, v in zip(rates[known], vol[known])
    ]
    return pd.DataFrame({
        "state": state, "label": label, "rates": rates, "vol": vol,
        "rates_momentum": axes.rates_momentum, "vol_z": axes.vol_z,
    }, index=rates.index)


def classify_market(as_of: pd.Timestamp | None = None) -> MarketRead:
    frame = market_states()
    if frame.empty:
        return MarketRead(
            state="unknown", label=None, rates=None, vol=None,
            rates_momentum=None, vol_z=None, as_of=None,
            reason="No macro history is available to classify a market regime.",
        )

    row, stamp = _last_row(frame, as_of, "state")
    if row is None:
        return MarketRead(
            state="unknown", label=None, rates=None, vol=None,
            rates_momentum=None, vol_z=None, as_of=None,
            reason=(
                "Not enough price history to classify — the volatility z-score "
                "needs a 252-session warm-up."
            ),
        )
    return MarketRead(
        state=str(row["state"]), label=str(row["label"]),
        rates=row["rates"], vol=row["vol"],
        rates_momentum=_clean(row["rates_momentum"]),
        vol_z=_clean(row["vol_z"]), as_of=_iso(stamp), reason=None,
    )


def _last_row(frame: pd.DataFrame, as_of, column: str):
    """The most recent row at or before ``as_of`` whose ``column`` is set."""
    usable = frame[frame[column].notna()]
    if as_of is not None:
        usable = usable[usable.index <= pd.Timestamp(as_of)]
    if usable.empty:
        return None, None
    return usable.iloc[-1], usable.index[-1]


# --------------------------------------------------------------------------
# The whole read
# --------------------------------------------------------------------------
def _headline_readings(inflation: str, country: str) -> list[dict]:
    """The prints the read was taken from, each with its own unit."""
    out = []
    for key, label, unit in (
        (INFLATION_KEYS.get(inflation, INFLATION_KEYS["headline"]),
         "US CPI (YoY)", "percent"),
        (UNEMPLOYMENT_KEY, "Unemployment rate", "percent"),
        (FED_DECISION_KEY, "Fed target (upper)", "percent"),
    ):
        series = macro_cache.release_series(key, country)
        if series.empty:
            continue
        out.append({
            "code": key, "label": label, "unit": unit,
            "value": _clean(series.iloc[-1]),
            "prior": _clean(series.iloc[-2]) if len(series) > 1 else None,
            "date": _iso(series.index[-1]),
        })
    return out


def current_regime(inflation: str = "headline", country: str = "US") -> RegimeRead:
    """All four lenses, plus the prints behind them."""
    quadrant = classify_quadrant(inflation=inflation, country=country)
    rate_cycle = classify_rate_cycle()
    risk = classify_risk()
    market = classify_market()
    readings = _headline_readings(inflation, country)

    # The last date any lens could speak to — never `utcnow()`. On a Sunday,
    # "as of today" over Friday's numbers is a lie.
    stamps = [r for r in (quadrant.as_of, rate_cycle.as_of, risk.as_of, market.as_of) if r]
    as_of = max(stamps) if stamps else None

    resolved = sum(
        1 for state in (quadrant.state, rate_cycle.state, risk.state, market.state)
        if state != "unknown"
    )
    warnings: list[str] = []
    calendar = macro_cache.calendar_status()
    if not calendar.get("available"):
        warnings.append(
            "No economic calendar is cached, so the growth/inflation and policy "
            "lenses cannot be read. Run POST /api/macro/refresh."
        )
    elif calendar.get("stale"):
        warnings.append("The economic calendar cache is stale.")

    return RegimeRead(
        as_of=as_of, quadrant=quadrant, rate_cycle=rate_cycle, risk=risk,
        market=market, headline_readings=readings, vintage="latest",
        available=resolved > 0,
        reason=None if resolved else (
            "No lens could be resolved — neither the economic calendar nor the "
            "macro market store has usable data yet."
        ),
        warnings=warnings,
    )


# --------------------------------------------------------------------------
# History
# --------------------------------------------------------------------------
def regime_history(
    months: int = 24, inflation: str = "headline", country: str = "US"
) -> list[dict]:
    """Month-end state of every lens, oldest first.

    A resample of the daily frames, not a replay loop — the history and the
    current read therefore come from the same computation by construction.

    ``month`` is formatted ``YYYY-MM``: the UI's year label keys on a January
    suffix, and a ``YYYY-MM-01`` serialisation would make that test true for
    every month.
    """
    months = max(1, min(int(months), 120))
    index = macro.reference_index()
    if len(index) == 0:
        return []

    frames = {
        "quadrant": quadrant_states(inflation=inflation, country=country),
        "rate": rate_cycle_states(),
        "risk": risk_states(),
        "market": market_states(),
    }

    def month_end(frame: pd.DataFrame, column: str) -> pd.Series:
        if frame.empty or column not in frame:
            return pd.Series(dtype="object")
        return frame[column].resample("ME").last()

    quadrant_label = month_end(frames["quadrant"], "label")
    quadrant_state = month_end(frames["quadrant"], "state")
    rate_stage = month_end(frames["rate"], "stage")
    risk_label = month_end(frames["risk"], "label")
    market_state = month_end(frames["market"], "state")

    stamps = pd.DatetimeIndex(
        sorted(set().union(*(s.index for s in (
            quadrant_state, rate_stage, risk_label, market_state) if len(s))))
    )[-months:]

    def at(series: pd.Series, stamp) -> str | None:
        if len(series) == 0 or stamp not in series.index:
            return None
        value = series.loc[stamp]
        return None if value is None or pd.isna(value) else str(value)

    return [
        {
            "month": stamp.strftime("%Y-%m"),
            "quadrant": at(quadrant_label, stamp),
            "quadrant_state": at(quadrant_state, stamp),
            "rate_stage": at(rate_stage, stamp),
            "risk": at(risk_label, stamp),
            "market": at(market_state, stamp),
        }
        for stamp in stamps
    ]


# --------------------------------------------------------------------------
# Regime -> asset playbook
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class PlaybookAsset:
    key: str
    label: str


#: What each regime is measured against. Every one is already in the registry,
#: so ``macro.change`` prices it through the same five alignment rules as
#: everything else -- no second reader is written here.
#:
#: The four ``_ETF`` keys are ``INTERNAL`` (kept out of the macro catalog
#: because HYG is not a macro indicator), but they resolve through
#: ``registry.get`` and are exactly the right instruments for credit and
#: duration.
PLAYBOOK_ASSETS: tuple[PlaybookAsset, ...] = (
    PlaybookAsset("GSPC", "US equities"),
    PlaybookAsset("IEF_ETF", "Treasuries 7-10y"),
    PlaybookAsset("HYG_ETF", "High yield"),
    PlaybookAsset("LQD_ETF", "Investment grade"),
    PlaybookAsset("TIP_ETF", "TIPS"),
    PlaybookAsset("BCOMGC", "Gold"),
    PlaybookAsset("BCOM", "Commodities"),
    PlaybookAsset("DXY", "US dollar"),
)


def _check_playbook_assets() -> None:
    """Every playbook asset must price as a log return.

    ``macro.change`` returns **basis points** for a percent-unit series, so a
    yield slipping into this list would be compounded by ``expm1(mean * 252)``
    into an annualised return in the thousands of percent -- and it would look
    plausible enough to ship. Asserted at import, like the registry's own
    invariants.
    """
    for asset in PLAYBOOK_ASSETS:
        entry = registry.get(asset.key)
        if entry is None:
            raise ValueError(f"playbook asset {asset.key!r} is not in the registry")
        if entry.change_unit != "log":
            raise ValueError(
                f"{asset.key}: a playbook asset must price as a log return; "
                f"{entry.change_unit!r} is not a return"
            )


_check_playbook_assets()


@dataclass(frozen=True)
class LensSpec:
    key: str
    label: str
    caveat: str
    #: State slugs in display order. Order is fixed so switching lens does not
    #: reshuffle the table, and so nobody reads it as a ranking.
    order: tuple[str, ...]
    labels: dict[str, str]


LENSES: dict[str, LensSpec] = {
    "quadrant": LensSpec(
        key="quadrant", label="Growth / inflation quadrant",
        caveat=(
            "Built from monthly CPI and unemployment releases, which begin in "
            "2019 — roughly one inflation cycle. 'Reflation' is largely 2021-22 "
            "and 'Stagflation' largely 2022, so these states are not independent "
            "samples. Read the episode count, not the day count."
        ),
        order=("reflation", "goldilocks", "stagflation",
               "disinflationary_slowdown", "transitional"),
        labels={v: k for k, v in QUADRANT_SLUGS.items()},
    ),
    "rate_cycle": LensSpec(
        key="rate_cycle", label="Rate cycle",
        caveat=(
            "Stage is read from the 3-month bill, which leads policy and spans "
            "the full history — but is also pushed around by bill supply and "
            "debt-ceiling episodes that are not policy."
        ),
        order=("hiking", "hold_post_hike", "neutral", "hold_post_cut", "cutting"),
        labels={v: k for k, v in RATE_SLUGS.items()},
    ),
    "risk": LensSpec(
        key="risk", label="Risk appetite",
        caveat=(
            "A composite of four price-based votes. Conditioning asset returns "
            "on a signal partly built from those same assets is circular by "
            "construction — the equity column in particular."
        ),
        order=("risk_on", "neutral", "risk_off"),
        labels={v: k for k, v in RISK_SLUGS.items()},
    ),
    "market": LensSpec(
        key="market", label="Market regime (rates x vol)",
        caveat=(
            "Price-based, and the same two axes the per-strategy attribution "
            "uses. The volatility z-score needs a 252-session warm-up, so the "
            "classified window starts later than the price history does."
        ),
        order=("rising_high", "rising_low", "falling_high", "falling_low"),
        labels={f"{r}_{v}": label for (r, v), label in _REGIME_LABELS.items()},
    ),
}


def lens_state_series(lens: str, index: pd.DatetimeIndex | None = None) -> pd.Series:
    """The daily state slug for one lens."""
    if lens not in LENSES:
        raise MacroAnalyticsError(f"unknown regime lens {lens!r}")
    frame = {
        "quadrant": lambda: quadrant_states(index),
        "rate_cycle": lambda: rate_cycle_states(index),
        "risk": lambda: risk_states(index),
        "market": lambda: market_states(index),
    }[lens]()
    if frame.empty or "state" not in frame:
        return pd.Series(dtype="object")
    return frame["state"]


def regime_asset_performance(
    lens: str = "quadrant",
    assets: Sequence[PlaybookAsset] | None = None,
    min_days: int = 60,
    min_episodes: int = 3,
) -> dict:
    """What each asset has actually paid in each state of ``lens``.

    Statistics are computed in log space, because ``macro.change`` returns log
    returns for every price series here.

    **Episodes are the honest denominator.** 400 days across two episodes is two
    observations, not four hundred, so both numbers are always reported and a
    state with enough days but too few episodes is flagged ``thin`` rather than
    presented as a result.

    No t-statistics or p-values: five states times eight assets times four
    lenses is 160 comparisons, and the same argument the driver ranking makes
    about unflagged lag scans applies here. Significance would need a block
    bootstrap over episodes, not an iid test.
    """
    spec = LENSES.get(lens)
    if spec is None:
        raise MacroAnalyticsError(f"unknown regime lens {lens!r}")

    index = macro.reference_index()
    if len(index) == 0:
        return {
            "lens": lens, "label": spec.label, "caveat": spec.caveat,
            "available": False, "states": [], "assets": [],
            "reason": "No macro history is available.",
            "window": None, "unclassified": 0, "warnings": [],
        }

    states = lens_state_series(lens, index)
    if states.empty or states.notna().sum() == 0:
        raise MacroAnalyticsError(
            f"no day could be classified under the {spec.label.lower()} lens"
        )

    chosen = list(assets or PLAYBOOK_ASSETS)
    returns = {a.key: macro.change(a.key, index) for a in chosen}
    classified = states.notna()
    total = int(classified.sum())
    runs_by_state = _compress(states)
    current = states[classified].iloc[-1] if total else None

    warnings: list[str] = []
    missing = [a.label for a in chosen if returns[a.key].notna().sum() == 0]
    if missing:
        warnings.append(f"No price history for: {', '.join(missing)}.")

    rows = []
    for slug in spec.order:
        mask = classified & (states == slug)
        days = int(mask.sum())
        if days == 0:
            continue
        episodes = [r for r in runs_by_state if r["label"] == slug]

        cells = []
        for asset in chosen:
            usable = mask & returns[asset.key].notna()
            stats = conditional_stats(
                returns[asset.key].fillna(0.0), usable, min_days, compounding="log"
            )
            thin = stats["ann_return"] is not None and len(episodes) < min_episodes
            cells.append({
                "key": asset.key, "label": asset.label,
                "ann_return": stats["ann_return"], "ann_vol": stats["ann_vol"],
                "sharpe": stats["sharpe"], "hit_rate": stats["hit_rate"],
                "n": stats["days"], "thin": thin,
                "reason": stats["reason"] or (
                    f"{stats['days']} days but only {len(episodes)} episodes — "
                    f"treat this as {len(episodes)} observations" if thin else None
                ),
            })

        lengths = sorted(
            (pd.Timestamp(r["end"]) - pd.Timestamp(r["start"])).days + 1 for r in episodes
        )
        rows.append({
            "state": slug,
            "label": spec.labels.get(slug, slug),
            "days": days,
            "episodes": len(episodes),
            "share": days / total if total else 0.0,
            "current": slug == current,
            "first": episodes[0]["start"] if episodes else None,
            "last": episodes[-1]["end"] if episodes else None,
            "median_episode_days": lengths[len(lengths) // 2] if lengths else None,
            "runs": episodes,
            "assets": cells,
        })

    classified_index = states[classified].index
    return {
        "lens": lens, "label": spec.label, "caveat": spec.caveat,
        "available": True, "reason": None,
        "window": {
            "start": _iso(classified_index.min()),
            "end": _iso(classified_index.max()),
            "days": total,
        },
        "unclassified": int((~classified).sum()),
        "assets": [{"key": a.key, "label": a.label} for a in chosen],
        "states": rows,
        "warnings": warnings,
    }
