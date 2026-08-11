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


STRATEGIES: tuple[DemoStrategy, ...] = (
    DemoStrategy(
        "demo-baseline", "baseline-lgbm-alpha158",
        "the reference every other run is read against, and the primary "
        "subject of the Macro Desk linkage panel",
    ),
    DemoStrategy(
        "demo-alpha360", "alpha360-raw-lags",
        "the second handler, so Models shows Alpha158 and Alpha360 as things "
        "that ran rather than things that merely exist",
    ),
    DemoStrategy(
        "demo-linear", "linear-ridge-floor",
        "the non-GBDT path, and fast enough to demo cancel and re-run on the "
        "Runs page",
    ),
    DemoStrategy(
        "demo-catboost", "catboost-baseline",
        "a third model backend, so available_models() is visibly not a "
        "one-item list",
    ),
    DemoStrategy(
        "demo-etf-rotation", "etf-rotation",
        "xgboost and the ETF asset class; the only run whose universe is funds",
    ),
    DemoStrategy(
        "demo-crypto", "crypto-365",
        "the only run exercising data_store=crypto_365 and a non-SPY benchmark "
        "end to end",
    ),
    DemoStrategy(
        "demo-concentrated", "concentrated-macro50",
        "a 50-name universe with a small topk — a visibly lumpier equity "
        "curve, which is what makes the regime attribution show contrast",
    ),
    DemoStrategy(
        "demo-cost-stressed", "cost-stressed",
        "makes curves.net_of_cost diverge visibly from curves.strategy, which "
        "is otherwise almost invisible on a run report",
    ),
    DemoStrategy(
        "demo-short-memory", "short-memory",
        "a different train/test split, so Runs is not ten identical period "
        "labels; also the shortest window, which exercises the analytics' "
        "minimum-observation guards",
    ),
    DemoStrategy(
        "demo-custom-factors", None,
        "the only thing exercising the custom-handler path: Factor Lab -> "
        "Builder -> a real run. No template carries `features`.",
    ),
    # Held out of the default roster: 28 epochs x 6 models on top500 is far
    # past the 20-60s the rest of the roster takes.
    DemoStrategy(
        "demo-double-ensemble", "double-ensemble",
        "the heaviest model path; slow, so opt in with --all-templates",
        slow=True,
    ),
    DemoStrategy(
        "demo-wide-and-slow", "wide-and-slow",
        "the longest training window; slow, so opt in with --all-templates",
        slow=True,
    ),
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


PORTFOLIOS: tuple[DemoPortfolio, ...] = (
    DemoPortfolio(
        "demo-pf-6040", "Classic 60/40",
        (("SPY", "etf", 0.60), ("AGG", "etf", 0.40)),
        "the reference NAV — two qlib-store ETFs on one calendar. If this one "
        "is wrong, everything else is.",
        notes="The textbook balanced book, rebalanced monthly at 10bp.",
    ),
    DemoPortfolio(
        "demo-pf-risk-parity", "Risk-parity sleeve",
        (("SPY", "etf", 0.25), ("TLT", "etf", 0.25),
         ("GLD", "etf", 0.25), ("DBC", "etf", 0.25)),
        "four asset classes on one calendar; the book whose macro betas are "
        "supposed to be readable — duration, gold, oil",
        notes="Equal-weight, not risk-weighted: the name describes the intent.",
    ),
    DemoPortfolio(
        "demo-pf-digital", "Digital assets",
        (("BTC-USD", "crypto", 0.50), ("ETH-USD", "crypto", 0.30),
         ("SOL-USD", "crypto", 0.20)),
        "market-store only, so it keeps its own 365-day calendar — and its "
        "benchmark comes from that store too",
        benchmark="BTC-USD",
        notes="Trades every calendar day, including weekends.",
    ),
    DemoPortfolio(
        "demo-pf-global-macro", "Global macro",
        (("SPY", "etf", 0.30), ("EFA", "etf", 0.20), ("EEM", "etf", 0.15),
         ("TLT", "etf", 0.20), ("GLD", "etf", 0.15)),
        "US, developed and emerging equity plus duration and gold — the "
        "natural subject for the regime attribution",
    ),
    DemoPortfolio(
        "demo-pf-sector-tilt", "Sector tilt",
        (("XLK", "etf", 0.35), ("XLF", "etf", 0.25),
         ("XLE", "etf", 0.20), ("SPY", "etf", 0.20)),
        "one calendar, one asset class, a clearly dominant contributor — "
        "exercises the contribution table legibly",
    ),
    DemoPortfolio(
        "demo-pf-model-book", "Model book",
        (("SPY", "etf", 1.00),),
        "the only portfolio whose point is strategy_ids — the /book page's "
        "'these strategies feed this book' panel",
        strategy_ids=("demo-baseline", "demo-custom-factors", "demo-cost-stressed"),
        rebalance="none",
    ),
    DemoPortfolio(
        "demo-pf-eur-6040", "Classic 60/40 (EUR)",
        (("SPY", "etf", 0.60), ("AGG", "etf", 0.40)),
        "the only book exercising the base-currency FX leg; diffs cleanly "
        "against demo-pf-6040",
        base_ccy="EUR",
        notes="Same holdings as the USD 60/40, reported in euros — the "
              "difference is the currency, nothing else.",
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
                "The roster names templates on purpose — fix the id rather than "
                "inlining the strategy."
            )
        spec = lower_draft(template.draft).spec

    updates = dict(entry.overrides)
    if test_end:
        # Per store: `us` and `crypto_365` have different calendar ends.
        end = marketdata.store_calendar_end(
            updates.get("data_store", spec.data_store), DEFAULT_CALENDAR_BUFFER
        ) or test_end
        updates["test_end"] = end
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
        holdings=[
            Holding(symbol=s, asset_class=c, weight=w) for s, c, w in entry.holdings
        ],
    )


# --------------------------------------------------------------------------
# Running
# --------------------------------------------------------------------------
def run_and_wait(runs: RunManager, spec: StrategySpec, demo_id: str,
                 timeout: int, poll: float = 3.0) -> dict:
    """Launch a real backtest and block until it reaches a terminal state.

    ``RunManager.start`` spawns a daemon thread inside *this* process, so the
    seeder has to wait; the API picks the finished run up from ``run.json`` on
    disk whenever it next looks.
    """
    provider_uri, region = marketdata.resolve_store(spec.data_store)
    config = build_workflow_config(spec, provider_uri, region)
    run = runs.start(
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
        current = runs.get(run.id)
        meta = current.meta if current else {}
        if meta.get("status") in ("succeeded", "failed", "cancelled"):
            return meta
        phase = meta.get("phase")
        if phase != last_phase:
            print(f"      {meta.get('status')}: {phase}", flush=True)
            last_phase = phase
        time.sleep(poll)

    runs.cancel(run.id)
    meta = dict((runs.get(run.id) or run).meta)
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
            existing = [
                m for m in runs.list(limit=1000)
                if m.get("strategy_id") == entry.id and m.get("status") == "succeeded"
            ]
            if existing and not args.force:
                row["status"] = "skipped (already succeeded)"
                row["run_id"] = existing[0]["id"]
            else:
                print(f"  running {entry.id} ({spec.model}/{spec.handler}/{spec.universe})…",
                      flush=True)
                started = time.monotonic()
                meta = run_and_wait(runs, spec, entry.id, args.timeout)
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
