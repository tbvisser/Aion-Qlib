"""The roster: federation, the TTL cache, and degrading without lying.

The catalog's tests are about what survives a rebuild. These are about what
survives a *service being down*, which is the roster's whole design problem: it
holds nothing, so every row on screen is one HTTP call away from vanishing.

Three properties carry the weight:

* a provider that fails keeps its previous rows and is named as degraded — the
  sidecar restarting must not empty the Skills tab;
* a provider that fails *cold* is empty and still named — a silent zero would
  read as "there are no swarms";
* a second search inside the TTL does not re-fetch — otherwise the search box
  hits four services per keystroke.

Providers are faked at the provider boundary rather than the HTTP one, so the
suite never needs the sidecar or rag-api running. The two in-process providers
are exercised against the real thing, because they read this repo and are
therefore the same on any checkout.
"""
from __future__ import annotations

import pytest

from webapp.api.catalog.schema import Entity
from webapp.api.registry import aggregate
from webapp.api.registry.aggregate import Provider


@pytest.fixture(autouse=True)
def clean_cache():
    """Every test starts cold. The cache is module-level and would leak."""
    aggregate._reset_for_tests()
    yield
    aggregate._reset_for_tests()


@pytest.fixture
def settings():
    from webapp.api.config import get_settings

    return get_settings()


def entity(local_id: str, **overrides) -> Entity:
    base = dict(
        kind="skill", source="vibe", local_id=local_id, name=local_id,
        summary="a test skill", family="sidecar", tags=["alpha"],
    )
    merged = {**base, **overrides}
    if "local_id" in overrides and "name" not in overrides:
        merged["name"] = merged["local_id"]
    return Entity(**merged)


def provider(name: str, entities, **overrides) -> Provider:
    base = dict(
        name=name, kind="skill", source="vibe", label=name,
        fetch=lambda settings: entities,
    )
    return Provider(**{**base, **overrides})


@pytest.fixture
def fake(monkeypatch):
    """Install a provider set for the duration of one test."""

    def install(*providers: Provider) -> None:
        monkeypatch.setattr(aggregate, "_providers", lambda: tuple(providers))

    return install


# --------------------------------------------------------------------------
# Federation
# --------------------------------------------------------------------------


def test_rows_from_every_provider_land_in_one_page(fake, settings):
    fake(
        provider("a", [entity("one"), entity("two")]),
        provider("b", [entity("swarm-one", kind="swarm", family="bundled")],
                 kind="swarm", source="vibe"),
    )
    page = aggregate.search(settings)
    assert page["total"] == 3
    assert {r["kind"] for r in page["results"]} == {"skill", "swarm"}


def test_a_provider_may_not_return_rows_outside_the_slice_it_declares(fake, settings):
    fake(provider("stray", [entity("ok"), entity("wrong", source="rag")]))
    assert aggregate.summary(settings)["degraded"] == ["stray"]


def test_a_provider_may_not_return_a_duplicate_uid(fake, settings):
    fake(provider("dupe", [entity("same"), entity("same")]))
    result = aggregate._ensure(settings)["dupe"]
    assert "duplicate uid" in result.error


# --------------------------------------------------------------------------
# Degrading
# --------------------------------------------------------------------------


def test_a_failing_provider_keeps_its_previous_rows(fake, settings):
    """A sidecar restart must not empty the Skills tab."""
    calls = {"n": 0}

    def flaky(_settings):
        calls["n"] += 1
        if calls["n"] == 1:
            return [entity("one"), entity("two")]
        raise RuntimeError("sidecar is down")

    fake(provider("vibe_skills", None, fetch=flaky))

    assert aggregate.search(settings)["total"] == 2
    aggregate.refresh(settings)

    assert aggregate.search(settings)["total"] == 2, "rows survived the failure"
    summary = aggregate.summary(settings)
    assert summary["degraded"] == ["vibe_skills"]
    assert summary["providers"][0]["stale"] is True
    assert "sidecar is down" in summary["providers"][0]["error"]


def test_a_cold_failure_is_empty_and_says_so(fake, settings):
    """The distinction a silent zero destroys: failed, versus genuinely none."""
    def explode(_settings):
        raise RuntimeError("connection refused")

    fake(provider("vibe_swarms", None, kind="swarm", fetch=explode))

    assert aggregate.search(settings)["total"] == 0
    provider_row = aggregate.summary(settings)["providers"][0]
    assert provider_row["error"].startswith("RuntimeError: connection refused")
    assert provider_row["stale"] is False, "no previous rows to be stale"
    assert provider_row["fetched_at"] is None


def test_one_dead_provider_does_not_take_the_others_down(fake, settings):
    def explode(_settings):
        raise RuntimeError("down")

    fake(
        provider("dead", None, fetch=explode),
        provider("alive", [entity("here")]),
    )
    page = aggregate.search(settings)
    assert [r["name"] for r in page["results"]] == ["here"]
    assert aggregate.summary(settings)["degraded"] == ["dead"]


# --------------------------------------------------------------------------
# The TTL cache
# --------------------------------------------------------------------------


def test_a_second_search_inside_the_ttl_does_not_refetch(fake, settings):
    """Otherwise the search box hits four services on every keystroke."""
    calls = {"n": 0}

    def counted(_settings):
        calls["n"] += 1
        return [entity("one")]

    fake(provider("p", None, fetch=counted))

    aggregate.search(settings, q="on")
    aggregate.search(settings, q="one")
    aggregate.facets(settings, "skill")
    assert calls["n"] == 1


def test_refresh_refetches(fake, settings):
    calls = {"n": 0}

    def counted(_settings):
        calls["n"] += 1
        return [entity("one")]

    fake(provider("p", None, fetch=counted))
    aggregate.search(settings)
    aggregate.refresh(settings)
    assert calls["n"] == 2


def test_a_failed_provider_is_retried_on_the_next_request(fake, settings):
    """Not cached for the full TTL: the usual cause is a container still starting."""
    calls = {"n": 0}

    def flaky(_settings):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("not up yet")
        return [entity("one")]

    fake(provider("p", None, fetch=flaky))

    assert aggregate.search(settings)["total"] == 0
    assert aggregate.search(settings)["total"] == 1, "retried rather than cached as failed"


# --------------------------------------------------------------------------
# Querying
# --------------------------------------------------------------------------


def test_search_is_substring_not_prefix(fake, settings):
    """`market` should find `get_market_data` — the roster is small enough."""
    fake(provider("p", [entity("get_market_data"), entity("screen_market"), entity("backtest")]))
    assert {r["name"] for r in aggregate.search(settings, q="market")["results"]} == {
        "get_market_data", "screen_market"}


def test_every_token_must_match(fake, settings):
    fake(provider("p", [
        entity("a", summary="options payoff analysis"),
        entity("b", summary="options chain fetch"),
    ]))
    assert aggregate.search(settings, q="options payoff")["total"] == 1


@pytest.mark.parametrize("query", ["get_market_data", "$close", "a - b", '"unbalanced', "*"])
def test_a_search_box_is_not_a_query_language(fake, settings, query):
    fake(provider("p", [entity("get_market_data")]))
    aggregate.search(settings, q=query)  # must not raise


def test_filters_compose(fake, settings):
    fake(
        provider("p", [
            entity("a", family="sidecar", tags=["x"]),
            entity("b", family="sidecar", tags=["y"]),
        ]),
        provider("q", [entity("c", source="aion", family="dev workflow", tags=["x"])],
                 source="aion"),
    )
    assert aggregate.search(settings, kind="skill")["total"] == 3
    assert aggregate.search(settings, source="vibe")["total"] == 2
    assert aggregate.search(settings, family="sidecar")["total"] == 2
    assert aggregate.search(settings, tag="x")["total"] == 2
    assert aggregate.search(settings, source="vibe", tag="x")["total"] == 1


def test_paging_reports_the_unpaged_total(fake, settings):
    fake(provider("p", [entity(f"s{i:02}") for i in range(30)]))
    page = aggregate.search(settings, limit=10, offset=20)
    assert page["total"] == 30
    assert page["returned"] == 10
    assert page["results"][0]["name"] == "s20"


def test_facet_counts_match_the_rows_they_filter(fake, settings):
    fake(
        provider("p", [
            entity("a", family="sidecar", tags=["x", "y"]),
            entity("b", family="sidecar", tags=["x"]),
        ]),
        provider("q", [entity("c", source="aion", family="seed skill", tags=[])],
                 source="aion"),
    )
    facets = aggregate.facets(settings, "skill")
    assert facets["source"] == [{"value": "vibe", "count": 2}, {"value": "aion", "count": 1}]
    assert facets["family"] == [
        {"value": "sidecar", "count": 2}, {"value": "seed skill", "count": 1}]

    for facet in facets["family"]:
        assert aggregate.search(settings, family=facet["value"])["total"] == facet["count"]
    for facet in facets["tags"]:
        assert aggregate.search(settings, tag=facet["value"])["total"] == facet["count"]


def test_facets_are_scoped_to_one_collection(fake, settings):
    fake(
        provider("p", [entity("a", family="sidecar")]),
        provider("q", [entity("s", kind="swarm", family="bundled")], kind="swarm"),
    )
    assert [f["value"] for f in aggregate.facets(settings, "skill")["family"]] == ["sidecar"]
    assert [f["value"] for f in aggregate.facets(settings, "swarm")["family"]] == ["bundled"]


def test_entity_carries_an_empty_link_shape(fake, settings):
    """So one detail rail reads both pages' payloads without branching."""
    fake(provider("p", [entity("one")]))
    found = aggregate.entity(settings, "skill:vibe:one")
    assert found["links"] == {"out": [], "in": []}
    assert aggregate.entity(settings, "skill:vibe:nope") is None


def test_the_row_shape_matches_the_catalog(fake, settings):
    """One browser component renders both pages; a missing key is a blank column."""
    fake(provider("p", [entity("one")]))
    row = aggregate.search(settings)["results"][0]
    assert set(row) == {
        "uid", "kind", "source", "local_id", "name", "title", "summary",
        "family", "tags", "expression", "metric", "updated_at", "payload",
    }
    assert row["uid"] == "skill:vibe:one"


# --------------------------------------------------------------------------
# The in-process providers, on real repo data
# --------------------------------------------------------------------------


def test_chat_profiles_describe_the_builders_capability_boundary(settings):
    """`run_backtest` in general and not in builder is the safety model."""
    from webapp.api.registry.providers import chat_profiles

    rows = {e.local_id: e for e in chat_profiles.fetch(settings)}
    assert set(rows) == {"general", "builder"}
    assert "run_backtest" in rows["general"].payload["tools"]
    assert "run_backtest" not in rows["builder"].payload["tools"]
    for row in rows.values():
        row.validate_shape()


def test_chat_tools_record_which_profiles_carry_them(settings):
    from webapp.api.registry.providers import chat_tools_provider

    rows = {e.local_id: e for e in chat_tools_provider.fetch(settings)}
    assert rows["evaluate_factor"].payload["in_every_profile"] is True
    assert rows["run_backtest"].payload["profiles"] == ["general"]
    assert rows["propose_strategy"].payload["profiles"] == ["builder"]


def test_repo_skills_are_found_and_labelled_by_what_they_are(settings):
    """A dev chore listed beside factor-research without saying so misleads."""
    from webapp.api.registry.providers import repo_skills

    rows = {e.local_id: e for e in repo_skills.fetch(settings)}
    assert "skill-creator" in rows
    families = {e.family for e in rows.values()}
    assert families <= {"dev workflow", "seed skill"}
    for row in rows.values():
        row.validate_shape()
        assert row.payload["body_available"] is True
        assert row.payload["body"], f"{row.local_id} has no body"


def test_vibe_skill_descriptions_lose_their_stray_quotes():
    """17 of the 89 arrive wrapped, because the sidecar hand-parses frontmatter."""
    from webapp.api.registry.providers.vibe_skills import _unquote

    assert _unquote('"Behavioral finance applications"') == "Behavioral finance applications"
    assert _unquote("'single quoted'") == "single quoted"
    assert _unquote("plain text") == "plain text"
    # Unbalanced: a description legitimately opening with a quote keeps it.
    assert _unquote('"unclosed') == '"unclosed'


def test_a_non_json_body_from_the_sidecar_is_an_error_not_an_empty_collection(monkeypatch):
    """The sidecar answers 200 with its SPA for paths it does not route."""
    import httpx

    from webapp.api.registry.providers import _vibe

    class _Response:
        status_code = 200
        headers = {"content-type": "text/html; charset=utf-8"}

        def raise_for_status(self):
            return None

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get(self, *a, **k):
            return _Response()

    monkeypatch.setattr(httpx, "Client", lambda **kwargs: _Client())

    class _Settings:
        vibe_api_url = "http://vibe-api:8000"
        vibe_api_token = ""

    with pytest.raises(RuntimeError, match="rather than JSON"):
        _vibe.get_json(_Settings(), "swarm/presets/investment_committee")


def test_scalability_agent_row_reports_health(monkeypatch):
    """The agent's single roster row is its /health probe, degraded when down."""
    import httpx

    from webapp.api.registry.providers import scalability_agent

    class _Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"ok": True, "service": "scalability-agent", "db": {"ok": True}}

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get(self, url):
            assert url.endswith("/health")
            return _Response()

    class _Settings:
        scalability_agent_url = "http://agent:8771"

    monkeypatch.setattr(httpx, "Client", lambda **kwargs: _Client())
    rows = list(scalability_agent.fetch(_Settings()))
    assert len(rows) == 1
    row = rows[0]
    row.validate_shape()
    assert row.uid == "agent:aion:scalability-agent"
    assert row.payload["health"]["ok"] is True

    def _down(**kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "Client", _down)
    with pytest.raises(httpx.ConnectError):
        list(scalability_agent.fetch(_Settings()))
