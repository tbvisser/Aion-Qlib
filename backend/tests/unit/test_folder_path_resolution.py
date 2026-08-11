"""Unit tests for folder path resolution (root / UUID / folder name)."""
import pytest
from app.services.folder_navigation import _resolve_path


class _FakeQuery:
    """Minimal chainable stub for the supabase query builder used by _resolve_path."""

    def __init__(self, rows):
        self._rows = rows

    def or_(self, *_a, **_k):
        return self

    def ilike(self, *_a, **_k):
        return self

    def execute(self):
        return type("Res", (), {"data": self._rows})()


class _FakeTable:
    def __init__(self, rows):
        self._rows = rows

    def select(self, *_a, **_k):
        return _FakeQuery(self._rows)


class _FakeSupabase:
    def __init__(self, rows):
        self._rows = rows

    def table(self, _name):
        return _FakeTable(self._rows)


def test_resolve_root_and_blank_return_none():
    assert _resolve_path("root") is None
    assert _resolve_path("ROOT") is None
    assert _resolve_path("") is None
    assert _resolve_path("  ") is None


def test_resolve_uuid_passthrough():
    u = "96cef195-4809-4b48-ac67-14b309d35590"
    assert _resolve_path(u) == u


def test_resolve_name_single_match():
    rows = [{"id": "abc-123", "name": "Reports"}]
    assert _resolve_path("Reports", _FakeSupabase(rows), "user-1") == "abc-123"


def test_resolve_name_no_match_raises():
    with pytest.raises(ValueError, match="No folder named"):
        _resolve_path("Nope", _FakeSupabase([]), "user-1")


def test_resolve_name_multiple_matches_raises():
    rows = [{"id": "a", "name": "Dup"}, {"id": "b", "name": "Dup"}]
    with pytest.raises(ValueError, match="Multiple folders match"):
        _resolve_path("Dup", _FakeSupabase(rows), "user-1")


def test_resolve_name_without_client_raises():
    with pytest.raises(ValueError, match="Invalid path"):
        _resolve_path("SomeName")
