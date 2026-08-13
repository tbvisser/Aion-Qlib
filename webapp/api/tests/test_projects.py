"""The project store.

Mirrors the store half of ``test_portfolios.py``. A project has no pricing
engine behind it, so this is the whole surface: round-trip, idempotent upsert,
the path guard, and the two properties ``list()`` promises.
"""
from __future__ import annotations

import pytest

from webapp.api.projects import ProjectSpec, ProjectStore


def spec(name: str = "Test project", **overrides) -> ProjectSpec:
    return ProjectSpec(name=name, **overrides)


def test_store_round_trip(tmp_path):
    store = ProjectStore(tmp_path)
    created = store.create(spec(strategy_ids=["s1", "s2"], portfolio_ids=["p1"]))
    assert store.get(created.id).name == "Test project"
    assert store.get(created.id).strategy_ids == ["s1", "s2"]
    assert [p.id for p in store.list()] == [created.id]

    updated = store.update(created.id, spec(name="Renamed"))
    assert updated.created_at == created.created_at, "created_at is preserved"
    assert updated.updated_at >= created.updated_at
    assert store.get(created.id).name == "Renamed"
    assert store.get(created.id).strategy_ids == [], "update replaces, it does not merge"

    assert store.delete(created.id) is True
    assert store.get(created.id) is None
    assert store.delete(created.id) is False


def test_update_of_an_unknown_id_is_none_not_a_create(tmp_path):
    store = ProjectStore(tmp_path)
    assert store.update("nope", spec()) is None
    assert list(tmp_path.glob("*.json")) == []


def test_upsert_twice_writes_one_file(tmp_path):
    """The seeder's whole idempotency contract."""
    store = ProjectStore(tmp_path)
    first = store.upsert("demo-project", spec(name="First"))
    second = store.upsert("demo-project", spec(name="Second"))
    assert len(list(tmp_path.glob("*.json"))) == 1
    assert first.created_at == second.created_at
    assert store.get("demo-project").name == "Second"


def test_path_guard_rejects_traversal(tmp_path):
    store = ProjectStore(tmp_path)
    for bad in ("../escape", "a/b", "", "x" * 65):
        with pytest.raises(ValueError):
            store._path(bad)


def test_corrupt_file_is_skipped_not_fatal(tmp_path):
    store = ProjectStore(tmp_path)
    good = store.create(spec())
    (tmp_path / "broken.json").write_text("{not json")
    assert [p.id for p in store.list()] == [good.id]


def test_list_is_newest_first(tmp_path):
    store = ProjectStore(tmp_path)
    store.upsert("aaa", spec(name="A"))
    store.upsert("bbb", spec(name="B"))
    listed = store.list()
    assert len(listed) == 2
    assert listed[0].updated_at >= listed[-1].updated_at


def test_membership_is_not_validated(tmp_path):
    """A dangling member degrades the card; it must not block the save.

    Checking ids at write time would make a project holding one deleted
    strategy permanently unsaveable. See the module docstring.
    """
    store = ProjectStore(tmp_path)
    stored = store.create(spec(strategy_ids=["deleted-long-ago"]))
    assert store.get(stored.id).strategy_ids == ["deleted-long-ago"]


def test_unknown_fields_are_rejected(tmp_path):
    with pytest.raises(Exception):
        ProjectSpec(name="x", nope=1)
