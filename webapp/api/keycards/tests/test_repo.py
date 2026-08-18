"""Tests for the Keycard repository layer."""
from __future__ import annotations

import pytest

from ...keycards.models import KeycardSpec, Node, Position, Windows
from ...keycards.repo import KeycardRepo

pytestmark = [pytest.mark.usefixtures("fake_stores"), pytest.mark.usefixtures("_authenticated")]


def _sample_spec(name: str = "Sample") -> KeycardSpec:
    return KeycardSpec(
        name=name,
        description="A test keycard",
        tags=["test"],
        nodes=[
            Node(id="store-1", type="data_store", position=Position(x=0, y=0),
                 config={"store": "us"}),
            Node(id="univ-1", type="universe", position=Position(x=0, y=100),
                 config={"universe": "top500", "benchmark": "SPY"}),
            Node(id="hand-1", type="handler", position=Position(x=0, y=200),
                 config={"handler": "Alpha158"}),
            Node(id="model-1", type="model", position=Position(x=0, y=300),
                 config={"model": "lightgbm"}),
            Node(id="port-1", type="portfolio", position=Position(x=0, y=400),
                 config={"strategy": "TopkDropoutStrategy", "topk": 50, "n_drop": 5}),
            Node(id="costs-1", type="costs", position=Position(x=0, y=500),
                 config={"open_cost": 0.0005, "close_cost": 0.0015, "min_cost": 5.0,
                         "account": 100_000_000}),
            Node(id="rec-1", type="records", position=Position(x=0, y=600), config={}),
        ],
        edges=[
            {"id": "e1", "source": "store-1", "source_port": "data",
             "target": "univ-1", "target_port": "data"},
            {"id": "e2", "source": "univ-1", "source_port": "data",
             "target": "hand-1", "target_port": "data"},
            {"id": "e3", "source": "hand-1", "source_port": "features",
             "target": "model-1", "target_port": "features"},
            {"id": "e4", "source": "model-1", "source_port": "signal",
             "target": "port-1", "target_port": "signal"},
            {"id": "e5", "source": "port-1", "source_port": "trades",
             "target": "costs-1", "target_port": "trades"},
            {"id": "e6", "source": "costs-1", "source_port": "trades",
             "target": "rec-1", "target_port": "trades"},
        ],
        windows=Windows(),
    )


@pytest.fixture
def repo(test_principal) -> KeycardRepo:
    return KeycardRepo(test_principal)


@pytest.mark.usefixtures("needs_db")
def test_create_and_get(repo):
    spec = _sample_spec("Create test")
    stored = repo.create(spec)
    assert stored.id
    assert stored.name == "Create test"
    assert stored.user_id == repo.principal.user_id

    fetched = repo.get(stored.id)
    assert fetched is not None
    assert fetched.name == stored.name
    assert fetched.nodes[0].config["store"] == "us"


@pytest.mark.usefixtures("needs_db")
def test_list_and_filter(repo):
    plain = repo.create(_sample_spec("Plain"))
    template = repo.create(_sample_spec("Template").model_copy(
        update={"is_template": True, "template_family": "baseline"}))

    all_cards = repo.list()
    assert {c.id for c in all_cards} == {plain.id, template.id}

    templates = repo.list_templates()
    assert [c.id for c in templates] == [template.id]

    baseline = repo.list_by_family("baseline")
    assert [c.id for c in baseline] == [template.id]


@pytest.mark.usefixtures("needs_db")
def test_update_and_delete(repo):
    stored = repo.create(_sample_spec("Before"))
    updated = repo.update(stored.id, _sample_spec("After"))
    assert updated is not None
    assert updated.name == "After"

    assert repo.delete(stored.id) is True
    assert repo.get(stored.id) is None


@pytest.mark.usefixtures("needs_db")
def test_filter_by_tag(repo):
    tagged = repo.create(_sample_spec("Tagged").model_copy(update={"tags": ["alpha"]}))
    repo.create(_sample_spec("Untagged"))

    filtered = repo.list_filtered(tag="alpha")
    assert [c.id for c in filtered] == [tagged.id]

    missing = repo.list_filtered(tag="beta")
    assert missing == []
