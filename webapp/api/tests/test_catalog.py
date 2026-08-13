"""The catalog index: harvest, search, facets, links.

The index is derived, so almost every property worth pinning is about what
survives a rebuild. Three of them are load-bearing enough that breaking one
would be silent:

* a uid must be stable, or a hand-made paper link points at nothing after the
  next reindex;
* a failing harvester must leave its collection alone, or a sidecar hiccup
  empties the Alphas tab;
* a user-set link must outlive a harvest, because it exists nowhere else in the
  app.

The real harvesters run here rather than fakes wherever they are machine-
independent -- curated, indicators, operators and templates all read repo data,
so their counts are the same on any checkout, and pinning them catches a qlib
bump that changes the vocabulary.
"""
from __future__ import annotations

import json

import pytest

from webapp.api.catalog import db, harvest
from webapp.api.catalog.harvest import Harvester, normalise_expression
from webapp.api.catalog.schema import Entity


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


@pytest.fixture
def conn(tmp_path):
    connection = harvest.open_and_init(tmp_path / "catalog.db")
    yield connection
    connection.close()


def entity(local_id: str = "A", **overrides) -> Entity:
    base = dict(
        kind="alpha", source="curated", local_id=local_id, name=local_id,
        summary="a test factor", family="momentum", tags=["classic"],
        expression="Ref($close,5)/$close - 1",
    )
    merged = {**base, **overrides}
    # `name` tracks `local_id` unless a test says otherwise, so an override of
    # one does not silently leave the other on the default.
    if "local_id" in overrides and "name" not in overrides:
        merged["name"] = merged["local_id"]
    return Entity(**merged)


def harvester(name: str, entities, **overrides) -> Harvester:
    base = dict(
        name=name, kind="alpha", source="curated", label=name,
        fetch=lambda settings: entities,
    )
    return Harvester(**{**base, **overrides})


def write(conn, *harvesters) -> list:
    results = [harvest.collect(h, None) for h in harvesters]
    harvest.write(conn, results)
    return results


# --------------------------------------------------------------------------
# Entity shape
# --------------------------------------------------------------------------


def test_uid_is_the_three_identity_fields():
    assert entity("MOM_12_1").uid == "alpha:curated:MOM_12_1"


@pytest.mark.parametrize("bad", [
    {"kind": "nonsense"},
    {"source": "nonsense"},
    {"local_id": "has space"},
    {"local_id": "has\nnewline"},
    {"local_id": "-leading-dash"},
])
def test_validate_shape_refuses_anything_that_breaks_a_uid(bad):
    with pytest.raises(ValueError):
        entity(**bad).validate_shape()


# --------------------------------------------------------------------------
# Harvest
# --------------------------------------------------------------------------


def test_a_harvester_may_not_return_rows_outside_the_slice_it_declares():
    """The declaration is the delete scope, so a stray row would never be cleaned up."""
    result = harvest.collect(
        harvester("stray", [entity("A"), entity("B", source="vibe")]), None
    )
    assert not result.ok
    assert "declares" in result.error


def test_a_harvester_may_not_return_a_duplicate_uid():
    result = harvest.collect(harvester("dupe", [entity("A"), entity("A")]), None)
    assert not result.ok
    assert "duplicate uid" in result.error


def test_a_failing_harvester_leaves_the_previous_rows_intact(conn):
    """The property that keeps a sidecar hiccup from emptying a collection."""
    def explode(settings):
        raise RuntimeError("sidecar is down")

    write(conn, harvester("zoo", [entity("A"), entity("B")]))
    assert db.search(conn, kind="alpha")["total"] == 2

    results = write(conn, harvester("zoo", None, fetch=explode))

    assert db.search(conn, kind="alpha")["total"] == 2, "rows survived the failure"
    assert results[0].error.startswith("RuntimeError: sidecar is down")

    summary = db.summary(conn)
    assert summary["degraded"] == ["zoo"], "and the collection reports itself degraded"


def test_a_harvest_replaces_only_the_slice_it_owns(conn):
    write(
        conn,
        harvester("curated", [entity("A")]),
        harvester("zoo", [entity("Z", source="vibe")], source="vibe"),
    )
    assert db.search(conn, kind="alpha")["total"] == 2

    write(conn, harvester("curated", [entity("B"), entity("C")]))

    uids = {r["uid"] for r in db.search(conn, kind="alpha")["results"]}
    assert uids == {"alpha:curated:B", "alpha:curated:C", "alpha:vibe:Z"}


def test_uid_survives_a_rebuild(conn, tmp_path):
    """A hand-made paper link points at a uid; two harvests must agree on it."""
    from webapp.api.config import get_settings

    first = harvest.run(conn, get_settings(), include_remote=False)
    before = {r["uid"] for r in db.search(conn, kind="alpha", limit=500)["results"]}

    second = harvest.run(conn, get_settings(), include_remote=False)
    after = {r["uid"] for r in db.search(conn, kind="alpha", limit=500)["results"]}

    assert before == after
    assert first["indexed"] == second["indexed"]
    assert second["failed"] == []


# --------------------------------------------------------------------------
# Search
# --------------------------------------------------------------------------


def test_search_finds_a_factor_by_a_word_in_its_summary(conn):
    write(conn, harvester("curated", [
        entity("MOM_12_1", summary="Twelve-month return skipping the most recent month."),
        entity("REV_1W", summary="One-week reversal - fade the last week's move."),
    ]))
    assert [r["name"] for r in db.search(conn, q="reversal")["results"]] == ["REV_1W"]


def test_search_finds_an_alpha_by_a_fragment_of_its_expression(conn):
    write(conn, harvester("curated", [
        entity("A", expression="Std($close,20)/Mean($close,20)"),
        entity("B", expression="Corr($close,Log($volume + 1),20)"),
    ]))
    assert [r["name"] for r in db.search(conn, q="$volume")["results"]] == ["B"]


@pytest.mark.parametrize("query", [
    "MOM_12_1",          # underscores must not split into an AND of three terms
    "Ref($close, 20)",   # parens and $ are FTS5 syntax
    "a - b",             # a bare - is a column filter in FTS5
    '"unbalanced',
    "*",
    "NEAR(",
])
def test_a_search_box_is_not_an_fts_query_language(conn, query):
    """Whatever a user types, it searches -- it never raises a syntax error."""
    write(conn, harvester("curated", [entity("MOM_12_1")]))
    db.search(conn, q=query)  # must not raise


def test_an_empty_query_is_not_a_filter(conn):
    write(conn, harvester("curated", [entity("A"), entity("B")]))
    assert db.search(conn, q="   ")["total"] == 2


def test_filters_compose(conn):
    write(
        conn,
        harvester("curated", [
            entity("A", family="momentum", tags=["classic"]),
            entity("B", family="volume", tags=["classic"]),
            entity("C", family="momentum", tags=["fast"]),
        ]),
        harvester("zoo", [entity("Z", source="vibe", family="momentum", tags=["fast"])],
                  source="vibe"),
    )
    assert db.search(conn, kind="alpha")["total"] == 4
    assert db.search(conn, kind="alpha", family="momentum")["total"] == 3
    assert db.search(conn, kind="alpha", family="momentum", source="curated")["total"] == 2
    assert db.search(conn, kind="alpha", family="momentum", tag="classic")["total"] == 1


def test_paging_reports_the_unpaged_total(conn):
    write(conn, harvester("curated", [entity(f"F{i:02}") for i in range(30)]))
    page = db.search(conn, kind="alpha", sort="name", limit=10, offset=20)
    assert page["total"] == 30
    assert page["returned"] == 10
    assert page["results"][0]["name"] == "F20"


def test_rows_with_no_metric_sort_last_rather_than_as_zero(conn):
    write(conn, harvester("curated", [
        entity("HAS", metric=-2.0),
        entity("NONE"),
        entity("BIG", metric=5.0),
    ]))
    assert [r["name"] for r in db.search(conn, sort="-metric")["results"]] == \
        ["BIG", "HAS", "NONE"]


# --------------------------------------------------------------------------
# Facets
# --------------------------------------------------------------------------


def test_facet_counts_match_the_rows_they_filter(conn):
    write(conn, harvester("curated", [
        entity("A", family="momentum", tags=["classic", "slow"]),
        entity("B", family="momentum", tags=["classic"]),
        entity("C", family="volume", tags=[]),
    ]))
    facets = db.facets(conn, "alpha")

    assert facets["family"] == [{"value": "momentum", "count": 2}, {"value": "volume", "count": 1}]
    assert facets["tags"] == [{"value": "classic", "count": 2}, {"value": "slow", "count": 1}]

    for facet in facets["family"]:
        assert db.search(conn, kind="alpha", family=facet["value"])["total"] == facet["count"]
    for facet in facets["tags"]:
        assert db.search(conn, kind="alpha", tag=facet["value"])["total"] == facet["count"]


def test_facets_are_scoped_to_one_collection(conn):
    write(
        conn,
        harvester("curated", [entity("A", family="momentum")]),
        harvester("ind", [entity("K", kind="indicator", source="qlib", family="kbar")],
                  kind="indicator", source="qlib"),
    )
    assert [f["value"] for f in db.facets(conn, "alpha")["family"]] == ["momentum"]
    assert [f["value"] for f in db.facets(conn, "indicator")["family"]] == ["kbar"]


# --------------------------------------------------------------------------
# Links
# --------------------------------------------------------------------------


def test_whitespace_is_not_semantic_in_an_expression():
    assert normalise_expression("Ref($close, 5)/$close - 1") == \
        normalise_expression("Ref($close,5)/$close-1")


def test_a_strategy_links_to_every_alpha_computing_the_same_expression(conn):
    """The join that does not exist on disk: strategies copy expressions inline."""
    shared = "Ref($close,5)/$close - 1"
    write(
        conn,
        harvester("curated", [entity("MOM5_LIB", expression=shared)]),
        harvester("ind", [entity("ROC5", kind="indicator", source="qlib",
                                 expression="Ref($close, 5)/$close - 1")],
                  kind="indicator", source="qlib"),
        harvester("strat", [entity(
            "s1", kind="strategy", source="aion", expression=None,
            payload={"features": [{"name": "MOM5", "expression": shared}]},
        )], kind="strategy", source="aion"),
    )
    harvest.derive_links(conn)

    strategy = db.get(conn, "strategy:aion:s1")
    assert {l["uid"] for l in strategy["links"]["out"]} == \
        {"alpha:curated:MOM5_LIB", "indicator:qlib:ROC5"}
    assert {l["rel"] for l in strategy["links"]["out"]} == {"strategy_uses_alpha"}

    # And the edge is navigable from the factor's side, which is the question
    # nothing in the app can answer today: who uses MOM5_LIB?
    assert [l["uid"] for l in db.get(conn, "alpha:curated:MOM5_LIB")["links"]["in"]] == \
        ["strategy:aion:s1"]


def test_deriving_links_twice_does_not_double_them(conn):
    write(conn, harvester("strat", [entity(
        "s1", kind="strategy", source="aion", expression=None,
        payload={"features": [{"name": "M", "expression": "Ref($close,5)/$close - 1"}]},
    )], kind="strategy", source="aion"), harvester("curated", [entity("M_LIB")]))

    assert harvest.derive_links(conn) == harvest.derive_links(conn) == 1


def test_a_user_set_link_survives_a_reindex(conn):
    """It exists nowhere else in the app, so a harvest must not clear it."""
    write(conn, harvester("curated", [entity("MOM_12_1")]))
    db.add_link(conn, "alpha:curated:MOM_12_1", "document:rag:paper-uuid",
                "documented_by", "Jegadeesh & Titman 1993")

    harvest.derive_links(conn)
    write(conn, harvester("curated", [entity("MOM_12_1")]))
    harvest.derive_links(conn)

    links = db.get(conn, "alpha:curated:MOM_12_1")["links"]["out"]
    assert [(l["rel"], l["uid"], l["note"]) for l in links] == [
        ("documented_by", "document:rag:paper-uuid", "Jegadeesh & Titman 1993")
    ]


def test_a_link_to_a_row_that_is_gone_keeps_its_rel_rather_than_vanishing(conn):
    """A dangling id must degrade, not disappear -- same posture as ProjectSpec."""
    write(conn, harvester("curated", [entity("A")]))
    db.add_link(conn, "alpha:curated:A", "alpha:curated:GONE", "related_to")

    link = db.get(conn, "alpha:curated:A")["links"]["out"][0]
    assert link["uid"] == "alpha:curated:GONE"
    assert link["rel"] == "related_to"
    assert link["name"] is None, "unresolved, but present"


# --------------------------------------------------------------------------
# The real harvesters, on repo data
# --------------------------------------------------------------------------


@pytest.fixture(scope="module")
def real(tmp_path_factory):
    from webapp.api.config import get_settings

    connection = harvest.open_and_init(tmp_path_factory.mktemp("catalog") / "catalog.db")
    report = harvest.run(connection, get_settings(), include_remote=False)
    yield connection, report
    connection.close()


def test_every_local_harvester_succeeds(real):
    _, report = real
    assert report["failed"] == []


def test_the_only_remote_harvester_is_the_zoo_and_it_is_declared_remote():
    """`include_remote=False` is what makes this suite deterministic.

    A harvester that crosses the network without saying so would make every
    count test above depend on whether the sidecar happened to be running.
    """
    from webapp.api.catalog.harvesters import HARVESTERS

    remote = [h.name for h in HARVESTERS if h.remote]
    assert remote == ["vibe_zoo"]


def test_a_local_only_reindex_skips_the_remote_source(real):
    conn, report = real
    ran = {h["name"] for h in report["harvesters"]}
    assert "vibe_zoo" not in ran
    # And its collection is genuinely absent rather than silently empty-but-counted.
    assert db.search(conn, kind="alpha", source="vibe")["total"] == 0


@pytest.mark.parametrize("name,kind,source,count", [
    # Repo data, so these are the same on any checkout. A qlib bump that changes
    # the vocabulary, or a factor added without its family, fails here.
    ("curated", "alpha", "curated", 121),
    ("indicators", "indicator", "qlib", 184),
    ("operators", "operator", "qlib", 50),
    ("templates", "template", "aion", 31),
    # 158 Alpha158 columns + 360 Alpha360 columns, read out of qlib.
    ("qlib_alphas", "alpha", "qlib", 518),
])
def test_local_harvester_counts(real, name, kind, source, count):
    conn, report = real
    reported = next(h for h in report["harvesters"] if h["name"] == name)
    assert reported["count"] == count
    assert db.search(conn, kind=kind, source=source)["total"] == count


def test_the_handler_flag_survives_into_the_index(real):
    """184 is the vocabulary; 158 is what a strategy trains on."""
    conn, _ = real
    page = db.search(conn, kind="indicator", limit=500)
    in_handler = [r for r in page["results"] if r["payload"]["in_handler"]]
    assert page["total"] == 184
    assert len(in_handler) == 158


def test_refused_operators_are_indexed_with_their_reason(real):
    """'Why can't I use Sum(x, 0)?' is a question a missing row answers with silence."""
    conn, _ = real
    refused = db.search(conn, kind="operator", family="refused", limit=50)
    assert refused["total"] == 6
    assert all(r["payload"]["refused"] for r in refused["results"])


def test_curated_provenance_becomes_a_resolvable_uid(real):
    """The vibe-curated caveats carry an upstream alpha id; prose is not a link."""
    conn, _ = real
    page = db.search(conn, kind="alpha", family="vibe-curated", limit=50)
    derived = [r for r in page["results"] if r["payload"].get("derived_from")]
    assert derived, "no vibe-curated factor recorded where it was adapted from"
    assert all(r["payload"]["derived_from"].startswith("alpha:vibe:") for r in derived)


def test_search_reaches_every_collection_at_once(real):
    """The whole point: one query, all sources.

    `strategy` is deliberately not among them any more. Saved strategies became
    per-user rows in aion.strategies, and this index is one SQLite file served
    to every authenticated caller -- indexing them would have shown each
    colleague everyone else's work. Templates stand in as the `aion`-sourced
    collection here; they ship with the repo and belong to nobody.
    """
    conn, _ = real
    results = db.search(conn, q="momentum", limit=100)["results"]
    assert {r["kind"] for r in results} >= {"alpha", "template"}
    assert {r["source"] for r in results} >= {"curated", "aion"}
    assert "strategy" not in {r["kind"] for r in results}


def test_summary_counts_agree_with_the_rows(real):
    conn, _ = real
    summary = db.summary(conn)
    assert summary["total"] == sum(c["count"] for c in summary["collections"])
    for collection in summary["collections"]:
        assert db.search(conn, kind=collection["kind"])["total"] == collection["count"]
