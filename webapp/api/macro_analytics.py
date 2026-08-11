"""What macro actually drives a strategy: correlations, betas, regimes, events.

Pure numpy/pandas in, dataclasses out. No FastAPI, no qlib, and -- deliberately
-- no statsmodels: ``pyproject.toml`` declares it only under the ``dev`` and
``analysis`` extras, so it is not a runtime dependency and cannot be imported
on a path the API depends on. The OLS and Newey-West estimators below are ~40
lines of numpy, and ``test_macro_analytics`` pins them against statsmodels to
1e-8 wherever it happens to be installed. scipy is used for p-values only, and
behind a try/except: without it the coefficient and its t-statistic still ship.

Four analytics, and the guards matter as much as the maths:

* **Drivers** rank macro series by correlation with the daily return series.
* **Betas** regress the returns on a small, deliberately non-collinear basket.
* **Regimes** split the window into rates x volatility quadrants.
* **Event study** measures what happens around economic releases.

Every one of them refuses rather than guesses when there is not enough data,
and every refusal names the number that was too small.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Literal, Sequence

import numpy as np
import pandas as pd

from . import macro
from . import macro_registry as registry

logger = logging.getLogger(__name__)

#: Below this many overlapping observations a statistic is not reported. Roughly
#: a quarter of trading days -- enough for a daily correlation to mean anything.
MIN_OBS = 60


class MacroAnalyticsError(ValueError):
    """Not enough data to answer. The message is user-facing prose."""


def _p_value(t_stat: float, dof: int) -> float | None:
    """Two-sided p, or None when scipy is unavailable (it is an extra)."""
    if not np.isfinite(t_stat) or dof <= 0:
        return None
    try:
        from scipy import stats
    except ImportError:  # pragma: no cover - depends on the environment
        return None
    return float(2 * stats.t.sf(abs(t_stat), dof))


# --------------------------------------------------------------------------
# Turning a report curve back into returns
# --------------------------------------------------------------------------
def strategy_returns(report: dict, curve: str = "strategy") -> pd.Series:
    """Daily returns from a ``results.build_report`` curve.

    The curves are ``(1 + r).cumprod() - 1``, so the inversion is exact:
    ``wealth = 1 + value``, ``r_t = wealth_t / wealth_{t-1} - 1``, and the first
    point's return is ``wealth_0 - 1``. ``portfolio_nav.build_nav`` emits
    ``curves.nav`` in the identical unit, which is what lets one analytics path
    serve both a backtest and a portfolio.
    """
    curves = (report or {}).get("curves") or {}
    points = curves.get(curve)
    if not points:
        available = ", ".join(sorted(k for k, v in curves.items() if v)) or "none"
        raise MacroAnalyticsError(
            f"this run recorded no '{curve}' curve (available: {available})"
        )

    frame = pd.DataFrame(points)
    index = pd.DatetimeIndex(pd.to_datetime(frame["date"])).normalize()
    wealth = 1.0 + pd.to_numeric(frame["value"], errors="coerce").to_numpy()
    series = pd.Series(wealth, index=index).sort_index()
    series = series[~series.index.duplicated(keep="last")]

    returns = series / series.shift(1) - 1.0
    if len(series):
        returns.iloc[0] = series.iloc[0] - 1.0
    return returns.replace([np.inf, -np.inf], np.nan).dropna()


def _require(returns: pd.Series, min_obs: int, what: str) -> None:
    if len(returns) < min_obs:
        raise MacroAnalyticsError(
            f"{what} needs at least {min_obs} daily observations; this window has "
            f"{len(returns)}"
        )


# --------------------------------------------------------------------------
# 1. Correlation-ranked drivers
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class DriverRow:
    key: str
    label: str
    group: str
    change_unit: str
    pearson: float | None
    spearman: float | None
    p_value: float | None
    p_value_adj: float | None
    beta_per_sd: float | None
    n: int
    lag: int
    available: bool
    reason: str | None


def _pearson(x: np.ndarray, y: np.ndarray) -> float | None:
    if len(x) < 2 or np.std(x) == 0 or np.std(y) == 0:
        return None
    value = float(np.corrcoef(x, y)[0, 1])
    return value if np.isfinite(value) else None


def drivers(
    returns: pd.Series,
    keys: Sequence[str] | None = None,
    max_lag: int = 0,
    min_obs: int = MIN_OBS,
) -> list[DriverRow]:
    """Rank macro series by |correlation| with ``returns``.

    Pairing is **complete-case per series**, not one shared listwise mask: a
    single thin series under a shared mask would truncate every other
    correlation in the table to its own short overlap.

    ``max_lag`` defaults to 0. A lag scan across two dozen series is a
    p-hacking machine, so when it is used the reported p-value is
    Bonferroni-adjusted for the number of lags tried and the caller is expected
    to say so.
    """
    _require(returns, min_obs, "a driver ranking")
    index = pd.DatetimeIndex(returns.index)
    entries = (
        [registry.get(k) for k in keys]
        if keys
        else [e for e in registry.offered() if e.daily_ok]
    )

    rows: list[DriverRow] = []
    for entry in entries:
        if entry is None:
            continue
        change = macro.change(entry.key, index)
        base = dict(
            key=entry.key, label=entry.label, group=entry.group,
            change_unit=entry.change_unit,
        )
        if change.empty or change.notna().sum() < 2:
            rows.append(DriverRow(
                **base, pearson=None, spearman=None, p_value=None, p_value_adj=None,
                beta_per_sd=None, n=0, lag=0, available=False,
                reason="no macro data over this window",
            ))
            continue

        best: tuple[float, int, np.ndarray, np.ndarray] | None = None
        for lag in range(-max_lag, max_lag + 1):
            # lag > 0: the macro move leads the return by `lag` sessions.
            shifted = change.shift(lag)
            pair = pd.concat([returns, shifted], axis=1, join="inner").dropna()
            if len(pair) < 2:
                continue
            r = _pearson(pair.iloc[:, 1].to_numpy(), pair.iloc[:, 0].to_numpy())
            if r is None:
                continue
            if best is None or abs(r) > abs(best[0]):
                best = (r, lag, pair.iloc[:, 0].to_numpy(), pair.iloc[:, 1].to_numpy())

        if best is None:
            rows.append(DriverRow(
                **base, pearson=None, spearman=None, p_value=None, p_value_adj=None,
                beta_per_sd=None, n=0, lag=0, available=False,
                reason="no overlapping observations with this run's window",
            ))
            continue

        r, lag, y, x = best
        n = len(y)
        if n < min_obs:
            rows.append(DriverRow(
                **base, pearson=r, spearman=None, p_value=None, p_value_adj=None,
                beta_per_sd=None, n=n, lag=lag, available=False,
                reason=f"only {n} overlapping observations; {min_obs} needed",
            ))
            continue

        # Spearman as a rank correlation, so one COVID-era day cannot carry the
        # whole relationship. Pearson on ranks is exactly Spearman, so this
        # needs no scipy.
        spearman = _pearson(
            pd.Series(x).rank().to_numpy(), pd.Series(y).rank().to_numpy()
        )
        t_stat = r * np.sqrt((n - 2) / (1 - r ** 2)) if abs(r) < 1 else np.inf
        p = _p_value(float(t_stat), n - 2)
        rows.append(DriverRow(
            **base,
            pearson=r,
            spearman=spearman,
            p_value=p,
            # Bonferroni over the lags actually scanned.
            p_value_adj=(min(1.0, p * (2 * max_lag + 1)) if (p is not None and max_lag) else p),
            # Daily return in basis points per one-standard-deviation macro move
            # -- what makes a bare correlation legible.
            beta_per_sd=float(r * np.std(y, ddof=1) * 1e4),
            n=n, lag=lag, available=True, reason=None,
        ))

    rows.sort(key=lambda row: (not row.available, -abs(row.pearson or 0.0)))
    return rows


# --------------------------------------------------------------------------
# 2. OLS factor betas
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class BetaRow:
    key: str
    label: str
    group: str
    beta: float
    std_error: float
    t_stat: float
    p_value: float | None
    vif: float | None


@dataclass(frozen=True)
class FactorModel:
    alpha: BetaRow
    rows: list[BetaRow]
    r_squared: float
    adj_r_squared: float
    n: int
    k: int
    cov: str
    hac_lags: int
    dropped: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _hac_lags(n: int) -> int:
    """Newey-West's standard automatic bandwidth: 4(n/100)^(2/9).

    ~4 lags at 250 observations, ~5 at 1000. Matches statsmodels' own default
    for ``cov_type="HAC"``, which is what makes the agreement test meaningful.
    """
    return int(np.floor(4 * (n / 100.0) ** (2.0 / 9.0)))


def _sandwich(X: np.ndarray, u: np.ndarray, lags: int) -> np.ndarray:
    """Bartlett-kernel Newey-West covariance, with the small-sample correction.

    Mirrors statsmodels ``cov_hac_simple(..., use_correction=True)`` term for
    term, so the two agree to floating-point noise.
    """
    n, k = X.shape
    xu = X * u[:, None]
    S = xu.T @ xu
    for lag in range(1, lags + 1):
        weight = 1.0 - lag / (lags + 1.0)
        block = xu[lag:].T @ xu[:-lag]
        S += weight * (block + block.T)
    XtX_inv = np.linalg.inv(X.T @ X)
    V = XtX_inv @ S @ XtX_inv
    return V * (n / float(n - k))


def _vif(X: np.ndarray) -> list[float | None]:
    """Variance inflation per regressor. ``X`` excludes the constant."""
    n, k = X.shape
    out: list[float | None] = []
    ones = np.ones((n, 1))
    for j in range(k):
        others = np.delete(X, j, axis=1)
        design = np.hstack([ones, others]) if others.size else ones
        target = X[:, j]
        try:
            coef, *_ = np.linalg.lstsq(design, target, rcond=None)
        except np.linalg.LinAlgError:  # pragma: no cover
            out.append(None)
            continue
        resid = target - design @ coef
        tss = float(((target - target.mean()) ** 2).sum())
        if tss <= 0:
            out.append(None)
            continue
        r2 = 1.0 - float(resid @ resid) / tss
        out.append(float(1.0 / (1.0 - r2)) if r2 < 1 - 1e-12 else None)
    return out


def factor_betas(
    returns: pd.Series,
    keys: Sequence[str] | None = None,
    cov: Literal["hac", "ols"] = "hac",
    min_obs: int = MIN_OBS,
) -> FactorModel:
    """Regress ``returns`` on the macro basket.

    ``y`` is the raw daily return; each regressor is standardised over the
    estimation window. Standardising the regressors but not ``y`` is what makes
    a beta read directly as *extra daily return per one-standard-deviation
    macro move* while leaving the intercept meaningful -- the mean daily return
    with every driver at its window average.

    HAC standard errors by default. ``TopkDropoutStrategy`` returns are
    autocorrelated (holdings persist between drops) and heteroskedastic, and
    plain-OLS t-statistics overstate significance materially on exactly this
    kind of series. Showing a t-statistic at all is meant to stop a reader
    over-reading a beta, so it had better not be the optimistic one.
    """
    _require(returns, min_obs, "a factor regression")
    index = pd.DatetimeIndex(returns.index)
    entries = [e for e in (
        [registry.get(k) for k in keys] if keys else registry.default_basket()
    ) if e is not None]

    dropped: list[dict] = []
    warnings: list[str] = []
    usable: list = []
    columns: dict[str, pd.Series] = {}

    for entry in entries:
        if not entry.daily_ok:
            dropped.append({"key": entry.key, "reason": "not a daily series"})
            continue
        change = macro.change(entry.key, index)
        coverage = float(change.notna().mean()) if len(change) else 0.0
        if coverage < 0.8:
            dropped.append({
                "key": entry.key,
                "reason": f"only {coverage:.0%} of the window has data; 80% needed",
            })
            continue
        if float(np.nanstd(change.to_numpy())) == 0.0:
            dropped.append({"key": entry.key, "reason": "no variation over this window"})
            continue
        usable.append(entry)
        columns[entry.key] = change

    if not usable:
        raise MacroAnalyticsError(
            "no macro series has enough coverage over this window to regress against"
        )

    frame = pd.concat([returns.rename("__y__"), pd.DataFrame(columns, index=index)],
                      axis=1, join="inner").dropna()
    n = len(frame)
    k = len(usable) + 1
    if n < max(min_obs, 5 * k):
        raise MacroAnalyticsError(
            f"a {len(usable)}-factor regression needs at least {max(min_obs, 5 * k)} "
            f"complete observations; this window has {n}"
        )

    y = frame["__y__"].to_numpy(dtype=float)
    raw_X = frame[[e.key for e in usable]].to_numpy(dtype=float)
    means = raw_X.mean(axis=0)
    sds = raw_X.std(axis=0, ddof=1)
    sds[sds == 0] = 1.0
    Z = (raw_X - means) / sds
    X = np.hstack([np.ones((n, 1)), Z])

    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ coef
    dof = n - k

    lags = _hac_lags(n) if cov == "hac" else 0
    if cov == "hac":
        V = _sandwich(X, resid, lags)
    else:
        V = float(resid @ resid) / dof * np.linalg.inv(X.T @ X)
    se = np.sqrt(np.clip(np.diag(V), 0.0, None))

    tss = float(((y - y.mean()) ** 2).sum())
    rss = float(resid @ resid)
    r2 = 1.0 - rss / tss if tss > 0 else float("nan")
    adj = 1.0 - (1.0 - r2) * (n - 1) / dof if dof > 0 and np.isfinite(r2) else float("nan")

    vifs = _vif(Z)
    for entry, vif in zip(usable, vifs):
        if vif is not None and vif > 5.0:
            warnings.append(
                f"{entry.label} has a variance inflation factor of {vif:.1f} — it is "
                "largely explained by the other regressors, so read its beta with care"
            )

    def _row(i: int, key: str, label: str, group: str, vif: float | None) -> BetaRow:
        t = float(coef[i] / se[i]) if se[i] > 0 else float("nan")
        return BetaRow(
            key=key, label=label, group=group,
            beta=float(coef[i]), std_error=float(se[i]), t_stat=t,
            p_value=_p_value(t, dof), vif=vif,
        )

    return FactorModel(
        alpha=_row(0, "ALPHA", "Alpha (daily)", "alpha", None),
        rows=[_row(i + 1, e.key, e.label, e.group, vifs[i]) for i, e in enumerate(usable)],
        r_squared=r2, adj_r_squared=adj, n=n, k=k,
        cov=cov, hac_lags=lags, dropped=dropped, warnings=warnings,
    )


# --------------------------------------------------------------------------
# 3. Regime attribution
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class RegimeBucket:
    regime: str
    label: str
    rates: Literal["rising", "falling"]
    vol: Literal["high", "low"]
    days: int
    share: float
    mean_daily_return: float | None
    ann_return: float | None
    ann_vol: float | None
    sharpe: float | None
    hit_rate: float | None
    reason: str | None


@dataclass(frozen=True)
class RegimeReport:
    buckets: list[RegimeBucket]
    unclassified: int
    runs: list[dict]
    rates_key: str
    vol_key: str
    momentum: int
    lookback: int
    warnings: list[str] = field(default_factory=list)


_REGIME_LABELS = {
    ("rising", "high"): "Rates up, vol high",
    ("rising", "low"): "Rates up, vol low",
    ("falling", "high"): "Rates down, vol high",
    ("falling", "low"): "Rates down, vol low",
}

TRADING_DAYS = 252


@dataclass(frozen=True)
class MarketAxes:
    """The rates x volatility axes, on whatever index was asked for."""

    rates_axis: pd.Series      # "rising" / "falling" / None
    vol_axis: pd.Series        # "high" / "low" / None
    rates_momentum: pd.Series  # the raw level - level.shift(momentum)
    vol_z: pd.Series           # the raw rolling z of log(vol)
    rates_key: str
    vol_key: str
    momentum: int
    lookback: int


def market_regime_axes(
    rates_key: str = "US2Y",
    vol_key: str = "VIX",
    momentum: int = 60,
    lookback: int = 756,
    index: pd.DatetimeIndex | None = None,
) -> MarketAxes:
    """The two axes behind the market regime, computed once and shared.

    **Rates** is a *momentum* rule -- the level against itself ``momentum``
    sessions ago. A z-score of a yield level is a slow trend, which would carve
    a four-year window into two disjoint blocks and turn "quadrants" into
    sub-periods.

    **Volatility** is a rolling z-score of ``log(VIX)``. Rolling because an
    absolute VIX-20 line puts almost all of 2010-2012 in "high" and almost all
    of 2017 in "low"; log because VIX is strongly right-skewed and a raw
    z-score is dominated by March 2020.

    Both are computed on the **full macro history and then sliced** to
    ``index``. That is the only reason a 2022-2026 window is classifiable at
    all -- the 756-session warm-up sits in the years before it. Computing on
    the sliced window would leave the first three years unclassified.

    Extracted from ``regimes`` so the desk-wide market lens in ``macro_regime``
    and the per-strategy attribution here cannot disagree about what regime a
    given day was in.
    """
    full = macro.reference_index()
    if len(full) == 0:
        raise MacroAnalyticsError("no macro history is available to classify regimes")

    rates_level = macro.level(rates_key, full)
    vol_level = macro.level(vol_key, full)

    direction = rates_level - rates_level.shift(momentum)
    log_vol = np.log(vol_level.where(vol_level > 0))
    rolling = log_vol.rolling(lookback, min_periods=min(252, lookback))
    z = (log_vol - rolling.mean()) / rolling.std()

    target = pd.DatetimeIndex(index) if index is not None else full
    direction = direction.reindex(target)
    z = z.reindex(target)

    rates_axis = pd.Series(np.where(direction > 0, "rising", "falling"), index=target)
    rates_axis[direction.isna()] = None
    vol_axis = pd.Series(np.where(z > 0, "high", "low"), index=target)
    vol_axis[z.isna()] = None

    return MarketAxes(
        rates_axis=rates_axis, vol_axis=vol_axis,
        rates_momentum=direction, vol_z=z,
        rates_key=rates_key, vol_key=vol_key,
        momentum=momentum, lookback=lookback,
    )


def conditional_stats(
    returns: pd.Series,
    mask: pd.Series,
    min_days: int,
    compounding: Literal["simple", "log"] = "simple",
) -> dict:
    """Performance over the days ``mask`` selects.

    ``simple`` treats ``returns`` as arithmetic daily returns; ``log`` treats
    them as log returns and compounds with ``expm1``. Both matter: a run's
    equity curve gives arithmetic returns, while ``macro.change`` gives log
    returns for every price series.

    Deliberately no max drawdown. A drawdown across a non-contiguous set of
    days is not a drawdown, and a plausible-looking number here would be read
    as one.
    """
    days = int(mask.sum())
    if days < min_days:
        return {
            "days": days, "mean_daily_return": None, "ann_return": None,
            "ann_vol": None, "sharpe": None, "hit_rate": None,
            "reason": f"only {days} days in this regime; {min_days} needed",
        }

    sample = returns[mask]
    mean = float(sample.mean())
    sd = float(sample.std(ddof=1))
    ann_return = (
        float(np.expm1(mean * TRADING_DAYS)) if compounding == "log"
        else float((1.0 + mean) ** TRADING_DAYS - 1.0)
    )
    return {
        "days": days,
        "mean_daily_return": mean,
        "ann_return": ann_return,
        "ann_vol": float(sd * np.sqrt(TRADING_DAYS)),
        # Excess over zero: a risk-free leg would need a second series and
        # would not change the ordering.
        "sharpe": float(mean / sd * np.sqrt(TRADING_DAYS)) if sd > 0 else None,
        "hit_rate": float((sample > 0).mean()),
        "reason": None,
    }


def regimes(
    returns: pd.Series,
    rates_key: str = "US2Y",
    vol_key: str = "VIX",
    momentum: int = 60,
    lookback: int = 756,
    min_days: int = 20,
) -> RegimeReport:
    """Split the window into rates x volatility quadrants.

    **Rates** is a *momentum* rule -- the level against itself ``momentum``
    sessions ago. A z-score of a yield level is a slow trend, which would carve
    a four-year test window into two disjoint blocks and turn "quadrants" into
    sub-periods.

    **Volatility** is a rolling z-score of ``log(VIX)``. Rolling because an
    absolute VIX-20 line puts almost all of 2010-2012 in "high" and almost all
    of 2017 in "low"; log because VIX is strongly right-skewed and a raw
    z-score is dominated by March 2020.

    Both axes are computed on the **full macro history and then sliced** to the
    return window -- see ``market_regime_axes``, which owns that computation so
    this and the desk-wide market lens cannot disagree.
    """
    _require(returns, min_days, "a regime attribution")
    warnings: list[str] = []
    index = pd.DatetimeIndex(returns.index)
    axes = market_regime_axes(rates_key, vol_key, momentum, lookback, index=index)
    rates_axis, vol_axis = axes.rates_axis, axes.vol_axis

    classified = rates_axis.notna() & vol_axis.notna()
    unclassified = int((~classified).sum())
    if unclassified:
        warnings.append(
            f"{unclassified} of {len(index)} days could not be classified — the "
            "macro series does not cover them"
        )
    total = int(classified.sum())
    if total == 0:
        raise MacroAnalyticsError(
            "no day in this window could be classified; the macro series does not "
            "overlap it"
        )

    buckets: list[RegimeBucket] = []
    for rates in ("rising", "falling"):
        for vol in ("high", "low"):
            mask = classified & (rates_axis == rates) & (vol_axis == vol)
            stats = conditional_stats(returns, mask, min_days, compounding="simple")
            buckets.append(RegimeBucket(
                regime=f"{rates}_{vol}", label=_REGIME_LABELS[(rates, vol)],
                rates=rates, vol=vol,
                share=stats["days"] / total if total else 0.0,
                days=stats["days"],
                mean_daily_return=stats["mean_daily_return"],
                ann_return=stats["ann_return"],
                ann_vol=stats["ann_vol"],
                sharpe=stats["sharpe"],
                hit_rate=stats["hit_rate"],
                reason=stats["reason"],
            ))

    label_series = pd.Series(
        [
            _REGIME_LABELS[(r, v)] if (r and v) else None
            for r, v in zip(rates_axis, vol_axis)
        ],
        index=index,
    )
    return RegimeReport(
        buckets=buckets,
        unclassified=unclassified,
        runs=_compress(label_series),
        rates_key=rates_key, vol_key=vol_key,
        momentum=momentum, lookback=lookback,
        warnings=warnings,
    )


def _compress(labels: pd.Series) -> list[dict]:
    """Consecutive equal labels as spans, for shading the equity curve."""
    out: list[dict] = []
    current: str | None = None
    start: pd.Timestamp | None = None
    previous: pd.Timestamp | None = None
    for stamp, label in labels.items():
        if label != current:
            if current is not None and start is not None and previous is not None:
                out.append({"start": start.strftime("%Y-%m-%d"),
                            "end": previous.strftime("%Y-%m-%d"), "label": current})
            current, start = label, stamp
        previous = stamp
    if current is not None and start is not None and previous is not None:
        out.append({"start": start.strftime("%Y-%m-%d"),
                    "end": previous.strftime("%Y-%m-%d"), "label": current})
    return out


# --------------------------------------------------------------------------
# 4. Event study
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class EventStudy:
    event_type: str
    country: str
    n_events: int
    dropped: int
    model: Literal["constant_mean", "market"]
    path: list[dict]
    headline: dict
    warnings: list[str] = field(default_factory=list)


def event_study(
    returns: pd.Series,
    event_dates: Sequence[pd.Timestamp],
    event_type: str = "",
    country: str = "",
    pre: int = 5,
    post: int = 5,
    min_events: int = 10,
    market: pd.Series | None = None,
) -> EventStudy:
    """Cumulative abnormal return around a repeated economic release.

    Abnormal return is measured against a constant mean by default. When a
    ``market`` return series is supplied, ``alpha`` and ``beta`` are estimated
    on sessions **outside every event window**, so the model is not fitted on
    the days it is meant to explain.

    The headline is ``CAR`` over ``[0, +1]``: the release day plus the
    following session, which is the standard post-release drift read.
    """
    _require(returns, max(min_events, pre + post + 1), "an event study")
    warnings: list[str] = []
    index = pd.DatetimeIndex(returns.index)
    values = returns.to_numpy(dtype=float)

    # Map each release to the session it could first have been traded on.
    positions: set[int] = set()
    for raw in event_dates:
        stamp = pd.Timestamp(raw)
        target = stamp.normalize()
        pos = int(index.searchsorted(target, side="left"))
        if pos >= len(index):
            continue
        positions.add(pos)
    ordered = sorted(positions)

    usable = [p for p in ordered if p - pre >= 0 and p + post < len(index)]
    dropped = len(ordered) - len(usable)
    n = len(usable)
    if n < min_events:
        raise MacroAnalyticsError(
            f"only {n} usable releases of '{event_type or 'this type'}' fall inside "
            f"the run's window with a full [-{pre}, +{post}] session span; "
            f"{min_events} needed"
        )
    if n < 25:
        warnings.append(
            f"{n} events — the cross-sectional standard error is unreliable below 25"
        )

    offsets = list(range(-pre, post + 1))
    if market is not None:
        aligned_market = market.reindex(index)
        in_window = np.zeros(len(index), dtype=bool)
        for p in usable:
            in_window[p - pre: p + post + 1] = True
        estimation = (~in_window) & np.isfinite(values) & aligned_market.notna().to_numpy()
        if estimation.sum() < 60:
            warnings.append(
                "fewer than 60 non-event sessions to fit the market model; falling "
                "back to a constant mean"
            )
            model, abnormal = "constant_mean", values - np.nanmean(values)
        else:
            mkt = aligned_market.to_numpy(dtype=float)
            design = np.vstack([np.ones(estimation.sum()), mkt[estimation]]).T
            coef, *_ = np.linalg.lstsq(design, values[estimation], rcond=None)
            model = "market"
            abnormal = values - (coef[0] + coef[1] * np.nan_to_num(mkt))
    else:
        model, abnormal = "constant_mean", values - np.nanmean(values)

    matrix = np.vstack([abnormal[p - pre: p + post + 1] for p in usable])
    cumulative = np.nancumsum(matrix, axis=1)

    path: list[dict] = []
    for column, offset in enumerate(offsets):
        column_values = cumulative[:, column]
        finite = column_values[np.isfinite(column_values)]
        if len(finite) < 2:
            path.append({"offset": offset, "car": None, "se": None, "t": None, "n": len(finite)})
            continue
        car = float(finite.mean())
        se = float(finite.std(ddof=1) / np.sqrt(len(finite)))
        path.append({
            "offset": offset, "car": car, "se": se,
            "t": float(car / se) if se > 0 else None, "n": int(len(finite)),
        })

    # Headline: CAR over the release day and the one after it.
    window = matrix[:, pre: pre + 2]
    totals = np.nansum(window, axis=1)
    totals = totals[np.isfinite(totals)]
    car = float(totals.mean()) if len(totals) else None
    se = float(totals.std(ddof=1) / np.sqrt(len(totals))) if len(totals) > 1 else None
    t_stat = float(car / se) if (car is not None and se) else None
    headline = {
        "window": [0, 1],
        "car": car,
        "se": se,
        "t": t_stat,
        "p": _p_value(t_stat, len(totals) - 1) if t_stat is not None else None,
        "hit_rate": float((totals > 0).mean()) if len(totals) else None,
    }

    return EventStudy(
        event_type=event_type, country=country, n_events=n, dropped=dropped,
        model=model, path=path, headline=headline, warnings=warnings,
    )
