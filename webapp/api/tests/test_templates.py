"""A template is a promise the app makes unprompted.

That is what makes a broken one worse than none at all: the user did not ask for
it, has no reason to doubt it, and would find out it was wrong minutes into a
training run. So the load-bearing test here is that every shipped template
actually lowers into a config the engine would accept.

The second thing being defended is honesty. A curated set is exactly where a
performance claim would be most tempting and least defensible — nobody has run
these, and the numbers would depend on data the reader has not seen. The model
refuses extra keys and requires each template to say what it is bad at, and the
prose is checked for claims it has no standing to make.
"""
from __future__ import annotations

import re

import pytest
import yaml
from fastapi.testclient import TestClient

from webapp.api import marketdata
from webapp.api.main import app
from webapp.api.strategies import HANDLERS, MODEL_SPECS, StrategySpec, build_workflow_config
from webapp.api.strategy_gen import compat as compat_mod
from webapp.api.strategy_gen import templates as tpl
from webapp.api.tests.helpers import import_check

pytestmark = pytest.mark.usefixtures("fake_stores")

ALL = tpl.load_templates()
IDS = [t.id for t in ALL]


@pytest.fixture(autouse=True)
def every_model_available(monkeypatch):
    """Judge a template's model against the declared set, not this machine's.

    `available_models()` import-probes each backend, so a laptop missing CatBoost
    would fail a template that is perfectly correct. Membership in `MODEL_SPECS`
    is asserted separately, which is the claim that actually matters.
    """
    monkeypatch.setattr(
        compat_mod, "available_models",
        lambda: [{"id": k, "label": v["label"], "class": v["class"]}
                 for k, v in MODEL_SPECS.items()])


# --------------------------------------------------------------------------
# The one that matters
# --------------------------------------------------------------------------
@pytest.mark.parametrize("template", ALL, ids=IDS)
def test_every_template_lowers_into_a_runnable_config(template):
    lowered = tpl.lower_draft(template.draft)
    spec = lowered.spec

    assert spec.model in MODEL_SPECS
    assert spec.handler in HANDLERS
    assert spec.validate_windows() == []

    store = marketdata.store_for(spec.data_store)
    assert store is not None and store["exists"]
    assert spec.universe in store["universes"]
    assert spec.benchmark in set(marketdata.store_symbols(spec.data_store, "all"))

    assert lowered.config == build_workflow_config(
        spec, store["provider_uri"], store["region"])
    assert yaml.safe_load(lowered.yaml) == lowered.config


@pytest.mark.parametrize("template", ALL, ids=IDS)
def test_every_template_leaves_something_unstated(template):
    """A template that decided everything is lying about what it is.

    It would also hard-code dates that go stale, and produce no `assumed` rows —
    the one artifact that tells a reader which choices were nobody's.
    """
    assert tpl.lower_draft(template.draft).assumed


# --------------------------------------------------------------------------
# Honesty
# --------------------------------------------------------------------------
_CLAIMS = re.compile(
    r"\b(sharpe|alpha of|outperform\w*|beats?\b|profit\w*|returns? of|"
    r"annuali[sz]ed|win rate|drawdown of|\d+\s*%)", re.I)


@pytest.mark.parametrize("template", ALL, ids=IDS)
def test_templates_make_no_performance_claims(template):
    prose = " ".join([template.rationale, *template.good_for, *template.bad_for])
    found = _CLAIMS.findall(prose)
    assert not found, f"{template.id} claims performance: {found}"


@pytest.mark.parametrize("claim", [
    "Sharpe of 1.8", "delivers 12% annualised", "outperforms the benchmark",
    "a win rate of 55", "beats the baseline", "profitable in most regimes",
])
def test_the_claim_guard_actually_catches_claims(claim):
    """A regex that never matches anything is not a guard.

    Pinning what it *does* catch is what stops it being quietly weakened into a
    pattern that passes whatever prose someone wanted to write.
    """
    assert _CLAIMS.search(claim)


@pytest.mark.parametrize("template", ALL, ids=IDS)
def test_every_template_declares_what_it_is_bad_at(template):
    assert template.bad_for and all(line.strip() for line in template.bad_for)


def test_a_performance_key_is_a_load_error():
    """`extra="forbid"` is what makes the ban structural rather than a habit."""
    with pytest.raises(Exception):
        tpl.StrategyTemplate.model_validate({
            **ALL[0].model_dump(), "expected_return": 0.2})


def test_a_template_without_bad_for_is_a_load_error():
    payload = ALL[0].model_dump()
    payload["bad_for"] = []
    with pytest.raises(Exception):
        tpl.StrategyTemplate.model_validate(payload)


# --------------------------------------------------------------------------
# The set itself
# --------------------------------------------------------------------------
def test_every_template_file_parses():
    """Glob the directory, not the loaded list.

    `StrategyStore.list` skips files it cannot read, which is right for a user's
    own strategies and wrong for shipped ones — a template that vanishes is a
    template nobody notices is missing. This asserts the loader sees every file.
    """
    on_disk = sorted(p.stem for p in tpl.TEMPLATE_DIR.glob("*.yaml"))
    assert on_disk == sorted(IDS)


def test_ids_are_unique_and_match_their_filename():
    assert len(set(IDS)) == len(IDS)
    for template in ALL:
        assert (tpl.TEMPLATE_DIR / f"{template.id}.yaml").is_file()


def test_the_set_spans_the_vocabulary():
    """A curated set that only covers one model teaches only one thing."""
    assert {t.draft.model for t in ALL} >= set(MODEL_SPECS)
    assert {t.draft.handler for t in ALL if t.draft.handler} == set(HANDLERS)
    assert {t.draft.data_store or "us" for t in ALL} == {"us", "crypto_365"}
    # Equality, not a superset: a family declared in FAMILIES but shipped
    # empty appears in the gallery as a heading with nothing under it.
    assert {t.family for t in ALL} == set(tpl.FAMILIES)


def test_templates_are_ordered_baseline_first():
    assert ALL[0].family == "baseline"
    families = [tpl.FAMILIES.index(t.family) for t in ALL]
    assert families == sorted(families)


# --------------------------------------------------------------------------
# Reporting, not hiding
# --------------------------------------------------------------------------
def test_an_unbuildable_template_is_marked_not_hidden(fake_stores):
    fake_stores[1]["exists"] = False  # the crypto store
    by_id = {c["id"]: c for c in tpl.catalog()}

    crypto = by_id["crypto-365"]
    assert crypto["runnable"] is False
    assert crypto["blocked_by"][0]["code"] == "store_not_built"
    assert "spec" not in crypto

    assert by_id["baseline-lgbm-alpha158"]["runnable"] is True


def test_a_runnable_template_carries_the_from_draft_keys():
    """One payload shape, so one renderer serves templates and proposals."""
    entry = next(c for c in tpl.catalog() if c["runnable"])
    assert {"spec", "assumed", "warnings"} <= set(entry)
    assert {"id", "title", "family", "rationale", "good_for", "bad_for"} <= set(entry)
    assert "draft" not in entry, "the draft is an input, not part of the answer"


# --------------------------------------------------------------------------
# The endpoint
# --------------------------------------------------------------------------
def test_templates_endpoint_returns_the_catalog():
    body = TestClient(app).get("/api/templates").json()
    assert [t["id"] for t in body["templates"]] == IDS


def test_one_template_by_id_and_404_otherwise():
    client = TestClient(app)
    assert client.get("/api/templates/baseline-lgbm-alpha158").json()["title"]
    assert client.get("/api/templates/nope").status_code == 404


def test_templates_endpoint_neither_stores_nor_runs_anything():
    """Offering a strategy is not creating one."""
    client = TestClient(app)
    before = client.get("/api/strategies").json()["strategies"]
    client.get("/api/templates")
    assert client.get("/api/strategies").json()["strategies"] == before


# --------------------------------------------------------------------------
# Dependencies
# --------------------------------------------------------------------------
def test_templates_import_no_llm_client():
    result = import_check("webapp.api.strategy_gen.templates", "openai")
    assert result.returncode == 0, result.stderr


def test_strategies_does_not_import_templates():
    result = import_check("webapp.api.strategies", "webapp.api.strategy_gen")
    assert result.returncode == 0, result.stderr


# --------------------------------------------------------------------------
# Feature-set templates
# --------------------------------------------------------------------------
@pytest.mark.parametrize("template", ALL, ids=IDS)
def test_every_template_with_features_validates_its_expressions(template):
    """`lower_draft` resolves names, dates and stores -- never expressions.

    Without this a template carrying a broken factor reports `runnable: true`
    from `materialise` and then dies at POST /runs, which is the one place a
    curated promise must not break.
    """
    lowered = tpl.lower_draft(template.draft)
    assert lowered.spec.validate_features() == []


def test_materialise_refuses_a_template_whose_feature_reads_ahead():
    """The guard has to be shown to fire, not merely to exist."""
    source = next(t for t in ALL if t.draft.features)
    broken = source.model_copy(deep=True)
    broken.draft.features[0].expression = "Ref($close,-5)"

    result = tpl.materialise(broken)
    assert result["runnable"] is False
    assert [d["code"] for d in result["blocked_by"]] == ["bad_feature"]


# --------------------------------------------------------------------------
# The calendar clamp is an announcement, not a refusal
# --------------------------------------------------------------------------
@pytest.fixture
def stale_calendar(monkeypatch):
    """A store whose safe end has moved behind every template's `test_end`.

    `fake_stores` leaves `store_calendar_end` alone, and it reads a calendar
    file that does not exist under `/tmp/store-us`, so it returns None and the
    clamp never fires in this suite. That is precisely how the whole catalog
    could report `runnable: false` in production while every test here passed —
    so the fixture supplies the missing half.

    The date is the real one: templates carry `test_end: 2026-08-07`, and the
    `us` store's safe end had slipped to 2026-07-31. A few sessions, not a few
    years — a clamp far enough back to land before `test_start` would be a
    genuinely broken window, which is a different case and tested below.
    """
    safe_end = "2026-07-31"
    monkeypatch.setattr(marketdata, "store_calendar_end",
                        lambda key, buffer_sessions=5: safe_end)
    # `strategies` did `from .marketdata import store_calendar_end`, so its own
    # module attribute is what `validate_windows` actually reads.
    monkeypatch.setattr("webapp.api.strategies.store_calendar_end",
                        lambda key, buffer_sessions=5: safe_end)
    return safe_end


def test_a_test_end_past_the_calendar_is_clamped_not_refused(stale_calendar):
    """The message says "the run will end X instead" — so let it.

    Every template hardcodes a `test_end`, and an ingest that does not extend
    the calendar leaves them all pointing past it. Refusing on that turned the
    entire curated set into disabled rows explaining a run that would have
    worked perfectly well a few sessions shorter.
    """
    entry = next(c for c in tpl.catalog() if c["id"] == "baseline-lgbm-alpha158")

    assert entry["runnable"] is True
    assert entry["spec"]["test_end"] == stale_calendar


def test_the_clamp_is_recorded_as_an_assumption(stale_calendar):
    rows = [a for a in tpl.materialise(
        next(t for t in ALL if t.id == "baseline-lgbm-alpha158"))["assumed"]
        if a["path"] == "test_end"]

    # Exactly one row, and it agrees with the spec. `AssistantDock` keeps only
    # the assumed rows still true of what is on screen by comparing them field
    # by field, so a row quoting the pre-clamp date would silently vanish there
    # while still being rendered under "Filled in for you" in the gallery.
    assert len(rows) == 1
    assert rows[0]["value"] == stale_calendar
    assert "past the last day this store can safely backtest" in rows[0]["why"]


def test_clamping_does_not_excuse_a_genuinely_broken_window(stale_calendar):
    """A test window that ends before it starts is still fatal."""
    broken = ALL[0].model_copy(deep=True)
    broken.draft.test_start = "2019-06-01"
    broken.draft.test_end = "2019-01-01"

    result = tpl.materialise(broken)
    assert result["runnable"] is False
    # Moving the test window back to 2019 also drags it over validation, so
    # both ordering problems are reported — which is the aggregation
    # `lower_draft` promises, not an accident.
    assert {d["code"] for d in result["blocked_by"]} == {"window_order"}
    assert any("Test end is before test start." in d["message"]
               for d in result["blocked_by"])


def test_every_template_survives_a_calendar_that_has_moved_on(stale_calendar):
    """Not one of them — all of them. This is the state the machine was in."""
    catalog = tpl.catalog()
    assert catalog
    assert [c["id"] for c in catalog if not c["runnable"]] == []


def test_the_factors_family_is_not_empty():
    """The whole feature-canvas axis was unrepresented before this family."""
    with_features = [t for t in ALL if t.draft.features]
    assert with_features
    assert {t.family for t in with_features} == {"factors"}
    assert {t.draft.feature_mode for t in with_features} == {"extend", "replace"}


# --------------------------------------------------------------------------
# The gallery renders these
# --------------------------------------------------------------------------
def test_no_two_templates_share_a_title():
    """`id` is unique by construction; `title` is what the gallery shows."""
    titles = [t.title for t in ALL]
    assert len(titles) == len(set(titles))


def test_every_family_has_a_label():
    assert set(tpl.FAMILY_LABELS) == set(tpl.FAMILIES)


def test_the_endpoint_serves_the_families_in_order():
    body = TestClient(app).get("/api/templates").json()
    assert [f["key"] for f in body["families"]] == list(tpl.FAMILIES)
    assert all(f["label"] for f in body["families"])
