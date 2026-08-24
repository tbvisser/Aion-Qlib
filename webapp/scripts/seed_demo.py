"""Seed the demo strategies, portfolios and backtests.

    .venv/bin/python -m webapp.scripts.seed_demo --with-runs

Two rules shape everything here.

**Nothing is fabricated.** The seeder writes strategy specs and portfolio
records, then runs *real* backtests through the same ``RunManager`` the UI
uses. It never writes a metric, a curve or a Sharpe ratio -- the only way a
demo run has numbers is that ``qrun`` produced them and ``results.build_report``
read them back out of MLflow. Portfolio NAVs are likewise computed from real
bars; the allocations are hypothetical, the prices are not.

**The roster names templates, it does not restate strategies.** Each entry
points at a committed template in ``api/strategy_gen/templates/`` and says why
the demo needs it; ``lower_draft`` fills in everything nobody stated. So the
demo content and the shipped template gallery cannot drift, and a renamed
template fails a test instead of failing during a demo.

Re-running is safe: demo ids are stable and ``upsert`` overwrites in place, and
a strategy that already has a successful run is skipped unless ``--force``.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from typing import Any

from webapp.api import marketdata
from webapp.api.auth import Principal
from webapp.api.config import get_settings
from webapp.api.portfolios import Holding, PortfolioSpec, PortfolioStore
from webapp.api.runner import RunManager
from webapp.api.strategies import (
    FeatureColumn,
    StrategySpec,
    StrategyStore,
    build_workflow_config,
)
from webapp.api.strategy_gen.draft import lower_draft
from webapp.api.strategy_gen.templates import get_template
from webapp.scripts.migrate_to_postgres import resolve_owner

#: Every demo record's id starts with this. `--reset` deletes exactly these and
#: nothing else, so a user's own strategies and portfolios are never touched.
DEMO_PREFIX = "demo-"

#: Sessions to stop short of the store's final calendar day. qlib's
#: TradeCalendarManager reads calendar[i+1] on the last step, so a backtest
#: ending on the very last day raises IndexError -- intermittently, only when a
#: trade decision lands on that bar, which is why two runs already on disk died
#: this way while two identical ones survived. See marketdata.store_calendar_end.
DEFAULT_CALENDAR_BUFFER = 5


@dataclass(frozen=True)
class DemoStrategy:
    id: str
    #: A committed template id, or None for a spec stated literally below.
    template_id: str | None
    #: Why the demo needs this one -- which page it exists to make real.
    why: str
    overrides: dict[str, Any] = field(default_factory=dict)
    run: bool = True
    slow: bool = False
    origin: str = "backtest"
    description: str = ""


#: Official fund sleeves. Every portfolio links to at least one of these, so the
#: "Official" tab on /book and the portfolio linkage panel have a coherent story.
#: Each id is named after the mandate it implements, and its description says
#: which portfolios it feeds.
_OFFICIAL_STRATEGIES: tuple[DemoStrategy, ...] = (
    DemoStrategy(
        "demo-official-core-equity", "baseline-lgbm-alpha158",
        "the core US large-cap sleeve feeding the Classic 60/40 and Model Book",
        origin="official",
        description=(
            "Official core US equity sleeve. LightGBM reads Alpha158's 158 "
            "engineered factors on the top500 universe, trained 2010-2019 and "
            "validated 2020-2021. It ranks names, holds the top 50 and drops 5 "
            "per monthly rebalance, benchmarked to SPY. Feeds "
            "demo-pf-6040 (Classic 60/40) and demo-pf-model-book (Model Book)."
        ),
    ),
    DemoStrategy(
        "demo-official-balanced-6040", "official-balanced-6040",
        "the active equity/bond sleeve feeding the Classic 60/40 (EUR) book",
        origin="official",
        description=(
            "Official 60/40 sleeve. LightGBM/Alpha158 rotates within the ETF "
            "top 100 using quality and trend signals, benchmarked to SPY. This "
            "is the active overlay behind demo-pf-eur-6040 (Classic 60/40 EUR); "
            "the portfolio is reported in euros, the sleeve runs in USD."
        ),
    ),
    DemoStrategy(
        "demo-official-risk-parity", "official-risk-parity",
        "the volatility-aware multi-asset sleeve feeding risk-parity and macro",
        origin="official",
        description=(
            "Official risk-parity sleeve. LightGBM/Alpha158 over etf_top100, "
            "ranking funds by inverse 20-day volatility and 12-month momentum, "
            "holding 12 and rotating 3. Feeds demo-pf-risk-parity (Risk-parity "
            "sleeve) and demo-pf-global-macro (Global macro) as a multi-asset "
            "rotation engine."
        ),
    ),
    DemoStrategy(
        "demo-official-global-macro", "etf-rotation",
        "the multi-asset rotation sleeve feeding global macro and sector books",
        origin="official",
        description=(
            "Official global-macro sleeve. XGBoost/Alpha158 over etf_top100, "
            "rotating into the top fifteen broad ETFs each rebalance. Feeds "
            "demo-pf-global-macro (Global macro) and provides cross-asset "
            "exposure context for demo-pf-sector-tilt and demo-pf-momentum-tilt."
        ),
    ),
    DemoStrategy(
        "demo-official-sector-tilt", "etf-momentum",
        "the sector-momentum sleeve feeding sector-tilt and global-equity",
        origin="official",
        description=(
            "Official sector-momentum sleeve. XGBoost ranks the top 100 ETFs on "
            "12-month and 3-month momentum, holding 15 funds. Feeds "
            "demo-pf-sector-tilt (Sector tilt) and demo-pf-global-equity "
            "(Global equity) as the active rotation engine behind their "
            "sector/geographic exposures."
        ),
    ),
    DemoStrategy(
        "demo-official-momentum-tilt", "momentum-quality",
        "the momentum-quality factor sleeve feeding the momentum-tilt book",
        origin="official",
        description=(
            "Official momentum-quality sleeve. LightGBM/Alpha158 over top500, "
            "combining 12-month momentum with an inverse-volatility quality "
            "filter. Feeds demo-pf-momentum-tilt (Momentum tilt) as the active "
            "factor overlay behind its growth/tech/financials allocation."
        ),
    ),
    DemoStrategy(
        "demo-official-defensive", "official-defensive",
        "the defensive multi-asset sleeve feeding the defensive sleeve and 60/40",
        origin="official",
        description=(
            "Official defensive sleeve. LightGBM/Alpha158 over etf_top100, "
            "favouring low-volatility, positive-trend exposures in bonds, gold "
            "and equities. Feeds demo-pf-defensive (Defensive sleeve) and "
            "demo-pf-6040 (Classic 60/40) as their risk-reduction engine."
        ),
    ),
    DemoStrategy(
        "demo-official-global-equity", "index-rotation",
        "the geographic equity-rotation sleeve feeding global equity",
        origin="official",
        description=(
            "Official global-equity sleeve. XGBoost/Alpha158 over index_top50, "
            "rotating between world equity indices and holding the top ten. "
            "Feeds demo-pf-global-equity (Global equity) as the active "
            "geographic allocation engine behind its US/developed/emerging/energy mix."
        ),
    ),
    DemoStrategy(
        "demo-official-digital", "crypto-365",
        "the crypto sleeve feeding the Digital assets portfolio",
        origin="official",
        description=(
            "Official digital-assets sleeve. LightGBM/Alpha158 over "
            "crypto_top100 on the 365-day crypto calendar, benchmarked to "
            "BTC-USD with a price-limit guard for bad-tick protection. Feeds "
            "demo-pf-digital (Digital assets)."
        ),
    ),
)

#: Research backtests. These live in the "Backtested" tab and exist to exercise
#: every model backend, handler, store and shape the UI supports.
_BACKTEST_STRATEGIES: tuple[DemoStrategy, ...] = (
    DemoStrategy(
        "demo-alpha360", "alpha360-raw-lags",
        "the second handler, so Models shows Alpha158 and Alpha360 as things "
        "that ran rather than things that merely exist",
        description=(
            "Backtested research variant of the baseline: same LightGBM learner "
            "and top500 universe, but the model sees 60 days of raw price and "
            "volume lags via Alpha360 rather than engineered factors. Trades "
            "2022 onwards vs SPY."
        ),
    ),
    DemoStrategy(
        "demo-linear", "linear-ridge-floor",
        "the non-GBDT path, and fast enough to demo cancel and re-run on the "
        "Runs page",
        description=(
            "Backtested linear baseline: ridge regression on Alpha158 over "
            "top500 vs SPY. Same target as the official sleeve, but a simple "
            "linear model so the GBDT uplift is visible."
        ),
    ),
    DemoStrategy(
        "demo-catboost", "catboost-baseline",
        "a third model backend, so available_models() is visibly not a "
        "one-item list",
        description=(
            "Backtested CatBoost take on the Alpha158 top500 signal. Same "
            "rank-and-hold logic, different tree optimizer, benchmarked to SPY."
        ),
    ),
    DemoStrategy(
        "demo-concentrated", "concentrated-macro50",
        "a 50-name universe with a small topk -- a visibly lumpier equity "
        "curve, which is what makes the regime attribution show contrast",
        description=(
            "Backtested concentrated book: macro50 universe with a small topk, "
            "deliberately lumpier so regime attribution and contribution tables "
            "show contrast."
        ),
    ),
    DemoStrategy(
        "demo-cost-stressed", "cost-stressed",
        "makes curves.net_of_cost diverge visibly from curves.strategy, which "
        "is otherwise almost invisible on a run report",
        description=(
            "Backtested cost-stress test: same signal path as the baseline but "
            "with deliberately high open/close costs, so the net-of-cost curve "
            "visibly diverges from gross."
        ),
    ),
    DemoStrategy(
        "demo-short-memory", "short-memory",
        "a different train/test split, so Runs is not ten identical period "
        "labels; also the shortest window, which exercises the analytics' "
        "minimum-observation guards",
        description=(
            "Backtested short-memory variant: compressed train/valid/test "
            "windows that keep run labels distinct and exercise the analytics' "
            "minimum-observation guards."
        ),
    ),
    DemoStrategy(
        "demo-value-momentum", "value-momentum",
        "a factor-blend backtest combining a value proxy with 12-month momentum",
        description=(
            "Backtested value-momentum blend. LightGBM/Alpha158 over top500 "
            "combines distance from the 52-week high with 12-month momentum, "
            "holding 40 names and rotating 5."
        ),
    ),
    DemoStrategy(
        "demo-deep-book", "deep-book",
        "a low-conviction, broadly diversified book to show the other end of "
        "the concentration spectrum",
        description=(
            "Backtested deep book: LightGBM/Alpha158 over top500 holding 200 "
            "names and rotating 10, so the result comes from what is excluded "
            "rather than from a few high-conviction positions."
        ),
    ),
    DemoStrategy(
        "demo-custom-factors", None,
        "the only thing exercising the custom-handler path: Factor Lab -> "
        "Builder -> a real run. No template carries `features`.",
        description=(
            "Backtested custom-factor path. LightGBM on Alpha158 extended with "
            "three hand-built factors: 5-day momentum (MOM5), 20-day volatility "
            "(VOLA20) and 20-day price-volume correlation (PVCORR20)."
        ),
    ),
)


def _churn_strategy(start_year: int, model: str, template: str) -> DemoStrategy:
    """A two-calendar-year, high-turnover backtest.

    topk=20 and n_drop=10 rotates half the book each rebalance. qlib's report
    estimates trades as ``turnover * trading_days * 2``; with a daily turnover
    around 0.5x this produces roughly 250 round-trips per calendar year, or
    ~500 over the two-year window -- enough to fill the trade ladder and
    stress-test the strategy detail page without making the backtest unstable.
    """
    start = f"{start_year:04d}-01-04"
    end = f"{start_year + 1:04d}-12-29"
    return DemoStrategy(
        f"demo-churn-{start_year % 100:02d}{(start_year + 1) % 100:02d}",
        template,
        f"a high-turnover book that generates roughly 500 trades over the "
        f"{start_year}-{start_year + 1} window",
        description=(
            f"Backtested high-turnover sleeve. {model} over its template "
            f"universe, holding 20 names and rotating the bottom 10 each day, "
            f"producing roughly 500 round-trip trades over the {start_year}-"
            f"{start_year + 1} test window."
        ),
        overrides={
            "train_start": "2010-01-04",
            "train_end": "2017-12-29",
            "valid_start": "2018-01-02",
            "valid_end": "2019-12-31",
            "test_start": start,
            "test_end": end,
            "topk": 20,
            "n_drop": 10,
        },
    )


#: Four consecutive two-year windows, alternating model backend so the Runs page
#: shows both LightGBM/Alpha158 and XGBoost/Alpha158 churn variants.
#: Alpha158 is used for all of them because Alpha360's memory footprint pushes
#: the demo container into OOM kills when multiple years of top500 are loaded.
_CHURN_STRATEGIES: tuple[DemoStrategy, ...] = (
    _churn_strategy(2020, "LightGBM/Alpha158", "baseline-lgbm-alpha158"),
    _churn_strategy(2021, "XGBoost/Alpha158", "xgboost-baseline"),
    _churn_strategy(2022, "LightGBM/Alpha158", "baseline-lgbm-alpha158"),
    _churn_strategy(2023, "XGBoost/Alpha158", "xgboost-baseline"),
)

#: The heaviest model path; slow, so opt in with --all-templates.
_SLOW_STRATEGIES: tuple[DemoStrategy, ...] = (
    DemoStrategy(
        "demo-double-ensemble", "double-ensemble",
        "the heaviest model path; slow, so opt in with --all-templates",
        slow=True,
        description=(
            "Backtested DoubleEnsemble over top500: 28 epochs across six base "
            "learners. The heaviest model path, held out of default demos."
        ),
    ),
    DemoStrategy(
        "demo-wide-and-slow", "wide-and-slow",
        "the longest training window; slow, so opt in with --all-templates",
        slow=True,
        description=(
            "Backtested wide-and-slow variant: the longest training window in "
            "the roster, stressing the long-history path."
        ),
    ),
)

STRATEGIES: tuple[DemoStrategy, ...] = (
    *_OFFICIAL_STRATEGIES,
    *_BACKTEST_STRATEGIES,
    *_CHURN_STRATEGIES,
    *_SLOW_STRATEGIES,
)


def _custom_factor_spec() -> StrategySpec:
    """The one literal spec: a custom ``DataHandlerLP`` with the user's columns.

    Every expression is valid against this store. Note the absence of
    ``$vwap`` -- the US EODHD store does not carry it, and a factor referencing
    it silently evaluates to NaN rather than failing.
    """
    return StrategySpec(
        name="Custom factors (momentum, vol, price-volume)",
        model="lightgbm",
        handler="Alpha158",
        universe="macro50",
        feature_mode="extend",
        features=[
            FeatureColumn(name="MOM5", expression="Ref($close, 5)/$close - 1"),
            FeatureColumn(name="VOLA20", expression="Std($close, 20)/Mean($close, 20)"),
            FeatureColumn(name="PVCORR20",
                          expression="Corr($close, Log($volume + 1), 20)"),
        ],
    )


@dataclass(frozen=True)
class DemoPortfolio:
    id: str
    name: str
    holdings: tuple[tuple[str, str, float], ...]
    why: str
    benchmark: str = "SPY"
    base_ccy: str = "USD"
    rebalance: str = "monthly"
    strategy_ids: tuple[str, ...] = ()
    notes: str = ""
    objective: str = ""
    constraints: str = ""
    tags: tuple[str, ...] = ()


PORTFOLIOS: tuple[DemoPortfolio, ...] = (
    DemoPortfolio(
        "demo-pf-6040", "Classic 60/40",
        (("SPY", "etf", 0.60), ("AGG", "etf", 0.40)),
        "the reference NAV -- two qlib-store ETFs on one calendar. If this one "
        "is wrong, everything else is.",
        strategy_ids=("demo-official-core-equity", "demo-official-defensive"),
        objective="Replicate a classic 60/40 strategic allocation with a small "
                  "active equity overlay.",
        constraints="Long-only; 60% equity/40% bonds target; monthly rebalance; "
                    "10bp one-way cost.",
        tags=("balanced", "core", "multi-asset"),
        notes=(
            "Trades from 2021 (~5 years). The textbook balanced book: 60% US "
            "equities via SPY and 40% aggregate bonds via AGG, rebalanced monthly "
            "at 10bp. Linked to the official core-equity sleeve and the official "
            "defensive sleeve."
        ),
    ),
    DemoPortfolio(
        "demo-pf-risk-parity", "Risk-parity sleeve",
        (("SPY", "etf", 0.25), ("TLT", "etf", 0.25),
         ("GLD", "etf", 0.25), ("DBC", "etf", 0.25)),
        "four asset classes on one calendar; the book whose macro betas are "
        "supposed to be readable -- duration, gold, oil",
        strategy_ids=("demo-official-risk-parity", "demo-official-global-macro"),
        objective="Equal risk contribution from equities, duration, gold and "
                  "commodities.",
        constraints="Four-asset maximum; quarterly risk rebalance; 10bp cost.",
        tags=("macro", "multi-asset", "risk-parity"),
        notes=(
            "Trades from 2021 (~5 years). Equal-weight exposure to four asset "
            "classes -- equities, duration, gold and commodities -- so macro "
            "regime attribution can read each beta clearly. Linked to the "
            "official risk-parity and global-macro sleeves."
        ),
    ),
    DemoPortfolio(
        "demo-pf-digital", "Digital assets",
        (("BTC-USD", "crypto", 0.50), ("ETH-USD", "crypto", 0.30),
         ("SOL-USD", "crypto", 0.20)),
        "market-store only, so it keeps its own 365-day calendar -- and its "
        "benchmark comes from that store too",
        benchmark="BTC-USD",
        strategy_ids=("demo-official-digital",),
        objective="Capture beta in the three largest crypto assets via a "
                  "systematic rotation overlay.",
        constraints="Long-only crypto; 365-day calendar; BTC-USD benchmark; "
                    "monthly rebalance.",
        tags=("crypto", "digital", "altcoins"),
        notes=(
            "Trades from 2021 (~5 years) on the 365-day crypto calendar. "
            "Equal-weighted mix of BTC, ETH and SOL, benchmarked to BTC-USD. "
            "Linked to the official digital-assets sleeve."
        ),
    ),
    DemoPortfolio(
        "demo-pf-global-macro", "Global macro",
        (("SPY", "etf", 0.30), ("EFA", "etf", 0.20), ("EEM", "etf", 0.15),
         ("TLT", "etf", 0.20), ("GLD", "etf", 0.15)),
        "US, developed and emerging equity plus duration and gold -- the "
        "natural subject for the regime attribution",
        strategy_ids=("demo-official-risk-parity", "demo-official-global-macro"),
        objective="Harvest multi-asset momentum while keeping drawdowns contained "
                  "through a volatility overlay.",
        constraints="Multi-asset; monthly rebalance; SPY benchmark; 10bp cost.",
        tags=("macro", "multi-asset", "global"),
        notes=(
            "Trades from 2021 (~5 years). Multi-asset macro book blending US, "
            "developed and emerging equity with duration and gold. Linked to the "
            "official risk-parity and global-macro sleeves."
        ),
    ),
    DemoPortfolio(
        "demo-pf-sector-tilt", "Sector tilt",
        (("XLK", "etf", 0.35), ("XLF", "etf", 0.25),
         ("XLE", "etf", 0.20), ("SPY", "etf", 0.20)),
        "one calendar, one asset class, a clearly dominant contributor -- "
        "exercises the contribution table legibly",
        strategy_ids=("demo-official-sector-tilt", "demo-official-global-macro"),
        objective="Overweight tech, financials and energy against a US equity core.",
        constraints="Sector ETFs only; monthly rebalance; SPY benchmark.",
        tags=("sector", "equity", "rotation"),
        notes=(
            "Trades from 2021 (~5 years). US sector-tilt book overweight tech, "
            "financials and energy against a core SPY position. Linked to the "
            "official sector-tilt and global-macro sleeves."
        ),
    ),
    DemoPortfolio(
        "demo-pf-model-book", "Model book",
        (("SPY", "etf", 1.00),),
        "the portfolio whose point is strategy_ids -- the /book page's "
        "'these strategies feed this book' panel",
        strategy_ids=(
            "demo-official-core-equity",
            "demo-official-risk-parity",
            "demo-official-defensive",
        ),
        rebalance="none",
        objective="Demonstrate how multiple official sleeves feed a single portfolio.",
        constraints="100% SPY strategic allocation; no rebalance; linkage panel "
                    "shows the latest run of each sleeve.",
        tags=("model", "linkage", "official"),
        notes=(
            "Trades from 2021 (~5 years). A 100% SPY book used to demonstrate "
            "official strategy linkage: the core baseline, a volatility-aware "
            "risk-parity sleeve and a defensive sleeve feed this portfolio."
        ),
    ),
    DemoPortfolio(
        "demo-pf-eur-6040", "Classic 60/40 (EUR)",
        (("SPY", "etf", 0.60), ("AGG", "etf", 0.40)),
        "the only book exercising the base-currency FX leg; diffs cleanly "
        "against demo-pf-6040",
        base_ccy="EUR",
        strategy_ids=("demo-official-balanced-6040", "demo-official-defensive"),
        objective="Same 60/40 allocation as the USD book, reported in euros.",
        constraints="EUR reporting; 60/40 target; monthly rebalance; 10bp cost.",
        tags=("balanced", "fx", "eur"),
        notes=(
            "Trades from 2021 (~5 years). Same 60/40 allocation as the USD "
            "book, reported in euros to exercise the FX conversion leg. Linked "
            "to the official 60/40 sleeve and defensive sleeve."
        ),
    ),
    DemoPortfolio(
        "demo-pf-momentum-tilt", "Momentum tilt",
        (("SPY", "etf", 0.30), ("QQQ", "etf", 0.30),
         ("XLK", "etf", 0.20), ("XLF", "etf", 0.20)),
        "a factor-tilt book that blends core, growth, tech and financials "
        "so the contribution table shows several active bets at once",
        rebalance="quarterly",
        strategy_ids=("demo-official-momentum-tilt", "demo-official-sector-tilt"),
        objective="Capture momentum in growth/tech and financials against a core "
                  "US equity position.",
        constraints="Factor-tilt ETFs; quarterly rebalance; SPY benchmark.",
        tags=("factor", "momentum", "growth"),
        notes=(
            "Trades from 2021 (~5 years). Factor-tilt book blending core US "
            "equity (SPY), growth/tech (QQQ), technology (XLK) and financials "
            "(XLF), rebalanced quarterly to let momentum run. Linked to the "
            "official momentum-tilt and sector-tilt sleeves."
        ),
    ),
    DemoPortfolio(
        "demo-pf-defensive", "Defensive sleeve",
        (("TLT", "etf", 0.35), ("GLD", "etf", 0.25),
         ("SPY", "etf", 0.25), ("AGG", "etf", 0.15)),
        "a defensive allocation with duration, gold, equity and bonds -- "
        "the natural book for stress periods and drawdown comparison",
        rebalance="quarterly",
        strategy_ids=("demo-official-defensive", "demo-official-risk-parity"),
        objective="Preserve capital in stress periods through duration, gold and "
                  "low-volatility equity.",
        constraints="Defensive multi-asset; quarterly rebalance; SPY benchmark; "
                    "10bp cost.",
        tags=("defensive", "multi-asset", "low-vol"),
        notes=(
            "Trades from 2021 (~5 years). Defensive book: long-duration "
            "Treasuries (TLT), gold (GLD), core equity (SPY) and aggregate "
            "bonds (AGG), rebalanced quarterly. Linked to the official "
            "defensive and risk-parity sleeves."
        ),
    ),
    DemoPortfolio(
        "demo-pf-global-equity", "Global equity",
        (("SPY", "etf", 0.40), ("EFA", "etf", 0.30),
         ("EEM", "etf", 0.20), ("XLE", "etf", 0.10)),
        "a geographic sleeve that adds developed, emerging and energy "
        "exposure to a US core, so macro regime attribution can compare "
        "regions and sectors",
        rebalance="monthly",
        strategy_ids=("demo-official-global-equity", "demo-official-sector-tilt"),
        objective="Express geographic equity views through a systematic rotation "
                  "overlay on a US core.",
        constraints="Geographic ETFs; monthly rebalance; SPY benchmark.",
        tags=("global", "equity", "geographic"),
        notes=(
            "Trades from 2021 (~5 years). Global equity book: US large-cap "
            "core (SPY), developed ex-US (EFA), emerging markets (EEM) and "
            "energy (XLE), rebalanced monthly. Linked to the official "
            "global-equity and sector-tilt sleeves."
        ),
    ),
)


# --------------------------------------------------------------------------
# Building specs
# --------------------------------------------------------------------------
def build_spec(entry: DemoStrategy, test_end: str | None) -> StrategySpec:
    """Lower a roster entry into a runnable spec."""
    if entry.template_id is None:
        spec = _custom_factor_spec()
    else:
        template = get_template(entry.template_id)
        if template is None:
            raise SystemExit(
                f"{entry.id}: template '{entry.template_id}' no longer exists. "
                "The roster names templates on purpose -- fix the id rather than "
                "inlining the strategy."
            )
        spec = lower_draft(template.draft).spec

    updates = dict(entry.overrides)
    updates.setdefault("origin", entry.origin)
    updates.setdefault("description", entry.description)
    if test_end:
        # Per store: `us` and `crypto_365` have different calendar ends. Respect
        # the strategy's own test window (e.g. the 2-year churn demos); only cap
        # it when the calendar ends earlier than requested.
        strategy_end = updates.get("test_end", spec.test_end)
        calendar_end = marketdata.store_calendar_end(
            updates.get("data_store", spec.data_store), DEFAULT_CALENDAR_BUFFER
        )
        if strategy_end and strategy_end < test_end:
            updates["test_end"] = strategy_end
        elif calendar_end:
            updates["test_end"] = calendar_end
        else:
            updates["test_end"] = test_end
    if updates:
        spec = spec.model_copy(update=updates)
    return spec


def build_portfolio(entry: DemoPortfolio) -> PortfolioSpec:
    return PortfolioSpec(
        name=entry.name,
        base_ccy=entry.base_ccy,
        benchmark=entry.benchmark,
        rebalance=entry.rebalance,
        inception="2021-01-04",
        cost_bps=10.0,
        strategy_ids=list(entry.strategy_ids),
        notes=entry.notes or entry.why,
        objective=entry.objective,
        constraints=entry.constraints,
        tags=list(entry.tags),
        holdings=[
            Holding(symbol=s, asset_class=c, weight=w) for s, c, w in entry.holdings
        ],
    )


# --------------------------------------------------------------------------
# Running
# --------------------------------------------------------------------------
def run_and_wait(runs: RunManager, principal: Principal, spec: StrategySpec,
                 demo_id: str, timeout: int, poll: float = 3.0) -> dict:
    """Launch a real backtest and block until it reaches a terminal state.

    ``RunManager.start`` spawns a daemon thread inside *this* process, so the
    seeder has to wait; the API picks the finished run up from ``run.json`` on
    disk whenever it next looks.
    """
    provider_uri, region = marketdata.resolve_store(spec.data_store)
    config = build_workflow_config(spec, provider_uri, region)
    run = runs.start(
        principal,
        name=spec.name, config=config, kind="backtest", strategy_id=demo_id,
        extra={
            "model": spec.model, "handler": spec.handler,
            "universe": spec.universe, "benchmark": spec.benchmark,
            "data_store": spec.data_store, "demo": True,
        },
    )
    deadline = time.monotonic() + timeout
    last_phase = None
    while time.monotonic() < deadline:
        current = runs.get(principal, run.id)
        meta = current.meta if current else {}
        if meta.get("status") in ("succeeded", "failed", "cancelled"):
            return meta
        phase = meta.get("phase")
        if phase != last_phase:
            print(f"      {meta.get('status')}: {phase}", flush=True)
            last_phase = phase
        time.sleep(poll)

    runs.cancel(principal, run.id)
    meta = dict((runs.get(principal, run.id) or run).meta)
    meta["error"] = f"timed out after {timeout}s"
    return meta


def first_error_line(meta: dict, runs_dir) -> str:
    if meta.get("error"):
        return str(meta["error"]).strip().splitlines()[0][:120]
    log = runs_dir / meta.get("id", "") / "run.log"
    try:
        lines = [l for l in log.read_text().splitlines() if "Error" in l or "error" in l]
    except OSError:
        return ""
    return lines[-1][:120] if lines else ""


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="python -m webapp.scripts.seed_demo",
        description="Seed demo strategies, portfolios and real backtests.",
    )
    p.add_argument("--with-runs", action="store_true",
                   help="execute real backtests (minutes); off by default")
    p.add_argument("--owner",
                   help="email of the account that will own the runs (--with-runs)")
    p.add_argument("--only", nargs="+", metavar="ID",
                   help="seed only these demo ids")
    p.add_argument("--strategies-only", action="store_true")
    p.add_argument("--portfolios-only", action="store_true")
    p.add_argument("--all-templates", action="store_true",
                   help="include the slow templates held out of the roster")
    p.add_argument("--reset", action="store_true",
                   help=f"delete every '{DEMO_PREFIX}*' record first")
    p.add_argument("--force", action="store_true",
                   help="re-run backtests that already succeeded")
    p.add_argument("--timeout", type=int, default=1200, help="per run, seconds")
    p.add_argument("--calendar-buffer", type=int, default=DEFAULT_CALENDAR_BUFFER)
    p.add_argument("--dry-run", action="store_true",
                   help="print the roster and exit, writing nothing")
    p.add_argument("--json", action="store_true", help="machine-readable summary")
    return p.parse_args(argv)


def selected(args: argparse.Namespace) -> tuple[list[DemoStrategy], list[DemoPortfolio]]:
    strategies = [s for s in STRATEGIES if args.all_templates or not s.slow]
    portfolios = list(PORTFOLIOS)
    if args.only:
        wanted = set(args.only)
        strategies = [s for s in strategies if s.id in wanted]
        portfolios = [p for p in portfolios if p.id in wanted]
    if args.strategies_only:
        portfolios = []
    if args.portfolios_only:
        strategies = []
    return strategies, portfolios


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    settings = get_settings()
    strategies, portfolios = selected(args)

    if args.with_runs and not args.owner:
        print("--with-runs requires --owner <email> so runs can be filed under an account.")
        return 2
    principal: Principal | None = None
    if args.owner:
        owner = resolve_owner(args.owner)
        principal = Principal(
            user_id=owner.user_id,
            email=owner.email,
            org_id=owner.org_id,
            org_role="owner",
        )

    if args.dry_run:
        print("STRATEGIES")
        for entry in strategies:
            print(f"  {entry.id:22} {entry.template_id or '(literal spec)':26} {entry.why[:60]}")
        print("\nPORTFOLIOS")
        for entry in portfolios:
            holdings = " ".join(f"{s}:{w:g}" for s, _, w in entry.holdings)
            print(f"  {entry.id:22} {entry.base_ccy} {holdings[:44]:44} {entry.why[:44]}")
        print(f"\n{len(strategies)} strategies, {len(portfolios)} portfolios. "
              "Nothing written (--dry-run).")
        return 0

    strategy_store = StrategyStore(settings.strategies_dir)
    portfolio_store = PortfolioStore(settings.portfolios_dir)
    runs = RunManager(settings.runs_dir, settings.repo_root)

    if args.reset:
        removed = 0
        for stored in strategy_store.list():
            if stored.id.startswith(DEMO_PREFIX):
                strategy_store.delete(stored.id)
                removed += 1
        for stored in portfolio_store.list():
            if stored.id.startswith(DEMO_PREFIX):
                portfolio_store.delete(stored.id)
                removed += 1
        print(f"--reset: removed {removed} '{DEMO_PREFIX}*' records "
              "(nothing else was touched)")

    calendar_end = marketdata.store_calendar_end("us", args.calendar_buffer)
    if calendar_end:
        print(f"test_end capped at {calendar_end} "
              f"({args.calendar_buffer} sessions before the store's last day)")

    results: list[dict] = []

    for entry in strategies:
        spec = build_spec(entry, calendar_end)
        strategy_store.upsert(entry.id, spec)
        row = {"id": entry.id, "kind": "strategy", "name": spec.name,
               "model": spec.model, "handler": spec.handler,
               "universe": spec.universe, "store": spec.data_store,
               "status": "saved", "seconds": None, "error": None}

        if args.with_runs and entry.run:
            assert principal is not None
            existing = [
                m for m in runs.list(principal, limit=1000)
                if m.get("strategy_id") == entry.id and m.get("status") == "succeeded"
            ]
            if existing and not args.force:
                row["status"] = "skipped (already succeeded)"
                row["run_id"] = existing[0]["id"]
            else:
                print(f"  running {entry.id} ({spec.model}/{spec.handler}/{spec.universe})…",
                      flush=True)
                started = time.monotonic()
                meta = run_and_wait(runs, principal, spec, entry.id, args.timeout)
                row["status"] = meta.get("status", "unknown")
                row["seconds"] = round(time.monotonic() - started, 1)
                row["run_id"] = meta.get("id")
                if row["status"] != "succeeded":
                    row["error"] = first_error_line(meta, settings.runs_dir)
        results.append(row)

    for entry in portfolios:
        spec = build_portfolio(entry)
        portfolio_store.upsert(entry.id, spec)
        results.append({
            "id": entry.id, "kind": "portfolio", "name": spec.name,
            "holdings": len(spec.holdings), "base_ccy": spec.base_ccy,
            "status": "saved", "seconds": None, "error": None,
        })

    failed = [r for r in results if r["status"] not in ("saved", "succeeded")
              and not r["status"].startswith("skipped")]

    if args.json:
        print(json.dumps({"results": results, "failed": len(failed)}, indent=2))
    else:
        print("\n  ID                     KIND       STATUS                    SECS  NOTE")
        for row in results:
            secs = f"{row['seconds']:.0f}" if row.get("seconds") else ""
            print(f"  {row['id']:22} {row['kind']:10} {row['status']:25} "
                  f"{secs:>4}  {row.get('error') or ''}")
        print(f"\n{len(strategies)} strategies, {len(portfolios)} portfolios, "
              f"{len(failed)} failure(s).")
        if not args.with_runs and strategies:
            print("No backtests were run. Pass --with-runs to produce real results.")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
