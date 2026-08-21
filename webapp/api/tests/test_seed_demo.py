"""The demo roster, without running anything.

The test that earns its keep is ``test_roster_covers_every_model_handler_and_store``:
it is set equality with a message naming what is missing, so adding a model
backend fails here until the demo actually exercises it. A demo that silently
stops covering a code path is worse than no demo.
"""
from __future__ import annotations

import re

import pytest

from webapp.api import marketdata
from webapp.api.strategies import StrategySpec, available_models
from webapp.api.strategy_gen.templates import get_template
from webapp.scripts import seed_demo

pytestmark = pytest.mark.usefixtures("fake_stores")

ROSTER = seed_demo.STRATEGIES
PORTFOLIOS = seed_demo.PORTFOLIOS


# --------------------------------------------------------------------------
# Identifiers
# --------------------------------------------------------------------------
def test_ids_are_unique_and_prefixed():
    ids = [e.id for e in ROSTER] + [p.id for p in PORTFOLIOS]
    assert len(ids) == len(set(ids))
    for demo_id in ids:
        assert re.fullmatch(r"demo-[a-z0-9-]+", demo_id), demo_id


def test_ids_are_valid_store_ids():
    """The demo id *is* the store id -- that is the idempotency contract."""
    for demo_id in [e.id for e in ROSTER] + [p.id for p in PORTFOLIOS]:
        assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", demo_id), demo_id


def test_reset_prefix_matches_every_demo_id():
    """`--reset` must reach all of them and nothing else."""
    for demo_id in [e.id for e in ROSTER] + [p.id for p in PORTFOLIOS]:
        assert demo_id.startswith(seed_demo.DEMO_PREFIX)


def test_every_entry_says_why_it_exists():
    for entry in ROSTER:
        assert len(entry.why) > 20, f"{entry.id} has no rationale"
    for portfolio in PORTFOLIOS:
        assert len(portfolio.why) > 20, f"{portfolio.id} has no rationale"


# --------------------------------------------------------------------------
# Templates
# --------------------------------------------------------------------------
def test_every_template_id_resolves():
    """The roster names templates rather than restating strategies.

    A renamed template must fail here, not during a demo.
    """
    for entry in ROSTER:
        if entry.template_id is None:
            continue
        assert get_template(entry.template_id) is not None, (
            f"{entry.id} names template '{entry.template_id}', which no longer exists"
        )


def test_every_entry_lowers_into_a_valid_spec():
    for entry in ROSTER:
        spec = seed_demo.build_spec(entry, None)
        assert isinstance(spec, StrategySpec)
        assert spec.validate_windows() == [], f"{entry.id}: {spec.validate_windows()}"
        assert spec.validate_features() == [], f"{entry.id}: {spec.validate_features()}"


def test_roster_covers_every_model_handler_and_store():
    """Set equality, so a new backend fails until the demo exercises it."""
    specs = [seed_demo.build_spec(e, None) for e in ROSTER]

    covered_models = {s.model for s in specs}
    offered_models = {m["id"] for m in available_models()}
    assert offered_models <= covered_models, (
        "the demo roster does not exercise these models: "
        f"{sorted(offered_models - covered_models)}"
    )

    covered_handlers = {s.handler for s in specs}
    assert covered_handlers == {"Alpha158", "Alpha360"}, (
        f"missing handler coverage: {sorted({'Alpha158', 'Alpha360'} - covered_handlers)}"
    )

    covered_stores = {s.data_store for s in specs}
    assert covered_stores == {"us", "crypto_365"}, (
        f"missing store coverage: {sorted({'us', 'crypto_365'} - covered_stores)}"
    )


def test_demo_custom_factors_is_the_only_literal_spec_with_features():
    """The only route through the custom-DataHandlerLP path with a literal spec.

    Several official sleeves now extend Alpha158 with hand-built factors, but
    the literal-spec path (template_id=None) is still exercised only by the
    custom-factors demo.
    """
    literal_with_features = [
        e for e in ROSTER
        if e.template_id is None and seed_demo.build_spec(e, None).features
    ]
    assert [e.id for e in literal_with_features] == ["demo-custom-factors"]
    spec = seed_demo.build_spec(literal_with_features[0], None)
    assert len(spec.features) == 3
    # $vwap is absent from this store and evaluates to NaN everywhere.
    for column in spec.features:
        assert "$vwap" not in column.expression.lower()


def test_crypto_entry_keeps_its_own_benchmark():
    """crypto_365 has an empty benchmarks.txt, so SPY is not reachable there."""
    spec = seed_demo.build_spec(next(e for e in ROSTER if e.id == "demo-official-digital"), None)
    assert spec.data_store == "crypto_365"
    assert spec.benchmark == "BTC-USD"


def test_slow_templates_are_held_out_of_the_default_roster():
    slow = {e.id for e in ROSTER if e.slow}
    assert slow, "the slow entries should still be reachable via --all-templates"
    args = seed_demo.parse_args([])
    default_ids = {e.id for e in seed_demo.selected(args)[0]}
    assert not (default_ids & slow)
    opted_in = {e.id for e in seed_demo.selected(seed_demo.parse_args(["--all-templates"]))[0]}
    assert slow <= opted_in


# --------------------------------------------------------------------------
# Calendar safety
# --------------------------------------------------------------------------
def test_calendar_end_stops_short_of_the_last_session(tmp_path, monkeypatch):
    """qlib reads calendar[i+1] on the final step and raises IndexError.

    Two of the runs already on disk died exactly this way, intermittently,
    while two with an identical end date survived.
    """
    days = [f"2026-07-{d:02d}" for d in range(1, 21)]
    store = tmp_path / "store"
    (store / "calendars").mkdir(parents=True)
    (store / "calendars" / "day.txt").write_text("\n".join(days))
    monkeypatch.setattr(
        marketdata, "store_for",
        lambda key: {"key": key, "provider_uri": str(store), "exists": True},
    )
    end = marketdata.store_calendar_end("us", 5)
    assert end == days[-6]
    assert end < days[-1], "a backtest must not end on the store's final session"


def test_calendar_end_is_none_without_a_store(monkeypatch):
    monkeypatch.setattr(marketdata, "store_for", lambda key: None)
    assert marketdata.store_calendar_end("us") is None


# --------------------------------------------------------------------------
# Portfolios
# --------------------------------------------------------------------------
def test_every_portfolio_builds_and_validates():
    for entry in PORTFOLIOS:
        spec = seed_demo.build_portfolio(entry)
        assert spec.validate_holdings() == [], f"{entry.id}"
        assert len(spec.holdings) >= 1


def test_portfolio_weights_sum_to_one():
    for entry in PORTFOLIOS:
        total = sum(w for _, _, w in entry.holdings)
        assert abs(total - 1.0) < 1e-9, f"{entry.id} sums to {total}"


def test_portfolios_cover_the_paths_they_exist_for():
    by_id = {p.id: p for p in PORTFOLIOS}
    # A market-store-only book, so the 365-day calendar path is exercised.
    assert all(c == "crypto" for _, c, _ in by_id["demo-pf-digital"].holdings)
    assert by_id["demo-pf-digital"].benchmark == "BTC-USD"
    # The only non-USD book, so the FX leg is exercised.
    assert by_id["demo-pf-eur-6040"].base_ccy == "EUR"
    assert {p.base_ccy for p in PORTFOLIOS} == {"USD", "EUR"}
    # The model book exists to exercise strategy_ids; every book now links to an
    # official strategy so the /book linkage panel is populated across sleeves.
    assert len(by_id["demo-pf-model-book"].strategy_ids) == 3
    assert {p.rebalance for p in PORTFOLIOS} == {"monthly", "quarterly", "none"}


def test_linked_strategy_ids_exist_in_the_roster():
    """A demo portfolio must not point at a strategy the demo never seeds."""
    roster_ids = {e.id for e in ROSTER}
    for portfolio in PORTFOLIOS:
        for strategy_id in portfolio.strategy_ids:
            assert strategy_id in roster_ids, (
                f"{portfolio.id} links '{strategy_id}', which the roster does not seed"
            )


def test_portfolio_strategy_links_are_official():
    """Official portfolios link to official strategies; backtests live in the research tab."""
    origin_by_id = {
        e.id: seed_demo.build_spec(e, None).origin for e in ROSTER
    }
    for portfolio in PORTFOLIOS:
        for strategy_id in portfolio.strategy_ids:
            assert origin_by_id[strategy_id] == "official", (
                f"{portfolio.id} links '{strategy_id}' which is a research backtest; "
                "portfolios should point at official sleeves"
            )


def test_every_portfolio_links_to_at_least_one_official_strategy():
    official_ids = {e.id for e in ROSTER if seed_demo.build_spec(e, None).origin == "official"}
    for portfolio in PORTFOLIOS:
        assert any(sid in official_ids for sid in portfolio.strategy_ids), (
            f"{portfolio.id} has no official strategy link"
        )


def test_asset_classes_are_declared_correctly():
    for portfolio in PORTFOLIOS:
        for symbol, asset_class, _ in portfolio.holdings:
            if symbol.endswith("-USD"):
                assert asset_class == "crypto", f"{portfolio.id}/{symbol}"
            else:
                assert asset_class in {"equity", "etf", "index"}, f"{portfolio.id}/{symbol}"


def test_portfolios_carry_enriched_metadata():
    for portfolio in PORTFOLIOS:
        spec = seed_demo.build_portfolio(portfolio)
        assert spec.objective, f"{portfolio.id}: missing objective"
        assert spec.constraints, f"{portfolio.id}: missing constraints"
        assert spec.tags, f"{portfolio.id}: missing tags"


# --------------------------------------------------------------------------
# Metadata: origins, descriptions and trade years
# --------------------------------------------------------------------------
def test_every_strategy_has_an_origin_and_description():
    for entry in ROSTER:
        spec = seed_demo.build_spec(entry, None)
        assert spec.origin in ("official", "backtest"), f"{entry.id}: bad origin {spec.origin!r}"
        assert len(spec.description) > 20, f"{entry.id}: description is too short"


def test_roster_has_both_official_and_backtest_strategies():
    specs = [seed_demo.build_spec(e, None) for e in ROSTER]
    origins = {s.origin for s in specs}
    assert origins == {"official", "backtest"}, f"missing origins: {origins}"


def test_official_strategies_align_with_portfolios():
    """Every official strategy's description names at least one portfolio it feeds."""
    portfolio_ids = {p.id for p in PORTFOLIOS}
    for entry in ROSTER:
        if seed_demo.build_spec(entry, None).origin != "official":
            continue
        mentioned = {pid for pid in portfolio_ids if pid in entry.description}
        assert mentioned, (
            f"{entry.id}: official strategy description should mention a portfolio id"
        )


def test_high_turnover_strategies_target_two_years_and_roughly_one_thousand_trades():
    """The churn demos exist to put realistic trade volume on screen."""
    churn = [e for e in ROSTER if e.id.startswith("demo-churn-")]
    assert len(churn) >= 4, "expected at least four two-year churn windows"
    for entry in churn:
        spec = seed_demo.build_spec(entry, None)
        assert spec.topk == 20, f"{entry.id}: topk should force daily churn"
        assert spec.n_drop == 10, f"{entry.id}: n_drop should target high turnover"
        start_year = int(spec.test_start[:4])
        end_year = int(spec.test_end[:4])
        assert end_year - start_year == 1, f"{entry.id}: should span two calendar years"


def test_portfolio_notes_mention_trade_years():
    for entry in PORTFOLIOS:
        spec = seed_demo.build_portfolio(entry)
        assert "Trades from" in spec.notes, f"{entry.id}: notes missing trade years"
        assert "2021" in spec.notes, f"{entry.id}: notes missing inception year"


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def test_dry_run_writes_nothing(tmp_path, monkeypatch, capsys):
    from webapp.api.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "strategies_dir", tmp_path / "s", raising=False)
    monkeypatch.setattr(settings, "portfolios_dir", tmp_path / "p", raising=False)

    assert seed_demo.main(["--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "demo-official-core-equity" in out and "Nothing written" in out
    assert not (tmp_path / "s").exists()
    assert not (tmp_path / "p").exists()


def test_runs_are_off_by_default():
    assert seed_demo.parse_args([]).with_runs is False
    assert seed_demo.parse_args(["--with-runs"]).with_runs is True


def test_only_filters_both_kinds():
    strategies, portfolios = seed_demo.selected(
        seed_demo.parse_args(["--only", "demo-official-core-equity", "demo-pf-6040"])
    )
    assert [e.id for e in strategies] == ["demo-official-core-equity"]
    assert [p.id for p in portfolios] == ["demo-pf-6040"]


def test_kind_filters_are_exclusive():
    strategies, portfolios = seed_demo.selected(seed_demo.parse_args(["--strategies-only"]))
    assert strategies and not portfolios
    strategies, portfolios = seed_demo.selected(seed_demo.parse_args(["--portfolios-only"]))
    assert portfolios and not strategies


def test_max_parallel_is_not_offered():
    """LightGBM asks for 20 threads under RunManager's OMP_NUM_THREADS=1.

    Running two backtests at once oversubscribes the box for no gain, so the
    flag deliberately does not exist.
    """
    assert not hasattr(seed_demo.parse_args([]), "max_parallel")
