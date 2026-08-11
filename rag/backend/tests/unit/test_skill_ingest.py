"""Unit tests for the shared ingest_skill helper (used by both import paths)."""
from types import SimpleNamespace

import pytest

from app.routers.skills import ingest_skill

pytestmark = pytest.mark.unit


class _FakeQuery:
    def __init__(self, store, table):
        self.store = store
        self.table = table
        self._op = None

    def insert(self, data):
        self._op = ("insert", data)
        return self

    def upsert(self, data, on_conflict=None):
        self._op = ("upsert", data)
        return self

    def execute(self):
        op, data = self._op
        self.store.setdefault(self.table, []).append((op, data))
        if self.table == "skills":
            return SimpleNamespace(data=[{"id": "skill-123"}])
        return SimpleNamespace(data=[data])


class _FakeBucket:
    def __init__(self, store):
        self.store = store

    def upload(self, path, content, file_options=None):
        self.store.setdefault("uploads", []).append((path, content, file_options))


class _FakeStorage:
    def __init__(self, store):
        self.store = store

    def from_(self, bucket):
        return _FakeBucket(self.store)


class _FakeSupabase:
    def __init__(self):
        self.store: dict = {}
        self.storage = _FakeStorage(self.store)

    def table(self, name):
        return _FakeQuery(self.store, name)


def _parsed(name="docx", desc="A useful skill for doing useful things in tests."):
    return {"name": name, "description": desc, "instructions": "Do the thing."}


def test_ingest_success_records_source_url_and_uploads_files():
    fake = _FakeSupabase()
    parsed = _parsed()
    parsed["license"] = "MIT"
    files = [("run.py", b"print('hi')"), ("notes.md", b"# notes")]

    result = ingest_skill(
        fake, "user-1", parsed, files,
        source_url="https://github.com/anthropics/skills/tree/main/docx",
    )

    assert result.success is True
    assert result.skill_id == "skill-123"

    # skills insert carried name, source_url and the optional license
    insert_op, insert_data = fake.store["skills"][0]
    assert insert_op == "insert"
    assert insert_data["name"] == "docx"
    assert insert_data["source_url"] == "https://github.com/anthropics/skills/tree/main/docx"
    assert insert_data["license"] == "MIT"
    assert insert_data["user_id"] == "user-1"

    # both files uploaded under {user}/{skill}/{relative}
    upload_paths = {u[0] for u in fake.store["uploads"]}
    assert upload_paths == {"user-1/skill-123/run.py", "user-1/skill-123/notes.md"}
    # and a skill_files metadata row was upserted per file
    assert len(fake.store["skill_files"]) == 2


def test_ingest_without_source_url_omits_column():
    fake = _FakeSupabase()
    result = ingest_skill(fake, "user-1", _parsed(), [])
    assert result.success is True
    _, insert_data = fake.store["skills"][0]
    assert "source_url" not in insert_data


def test_ingest_rejects_invalid_name():
    fake = _FakeSupabase()
    result = ingest_skill(fake, "user-1", _parsed(name="Bad Name"), [])
    assert result.success is False
    assert "invalid skill name" in result.error.lower()
    assert "skills" not in fake.store  # nothing inserted


def test_ingest_rejects_short_description():
    fake = _FakeSupabase()
    result = ingest_skill(fake, "user-1", _parsed(desc="too short"), [])
    assert result.success is False
    assert "20 characters" in result.error


def test_ingest_rejects_empty_instructions():
    fake = _FakeSupabase()
    parsed = _parsed()
    parsed["instructions"] = ""
    result = ingest_skill(fake, "user-1", parsed, [])
    assert result.success is False
    assert "instructions" in result.error.lower()


def test_ingest_skips_oversized_file():
    fake = _FakeSupabase()
    big = b"x" * (10 * 1024 * 1024 + 1)
    result = ingest_skill(fake, "user-1", _parsed(), [("big.bin", big), ("ok.txt", b"hi")])
    assert result.success is True
    upload_paths = {u[0] for u in fake.store.get("uploads", [])}
    assert upload_paths == {"user-1/skill-123/ok.txt"}  # oversized file skipped
