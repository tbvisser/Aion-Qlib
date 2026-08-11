"""Unit tests for document folder deletion cleanup."""

import pytest
from fastapi import HTTPException

from app.dependencies import User
from app.routers import folders


class _Result:
    def __init__(self, data):
        self.data = data


class _Storage:
    def __init__(self, db: "_FakeSupabase"):
        self.db = db

    def from_(self, _bucket: str):
        return self

    def remove(self, paths):
        self.db.removed_paths.extend(paths)
        return _Result(None)


class _Query:
    def __init__(self, table: str, db: "_FakeSupabase"):
        self.table = table
        self.db = db
        self.op = "select"
        self.eqs = {}
        self.in_field = None
        self.in_values = None
        self.maybe = False

    def select(self, *_args, **_kwargs):
        self.op = "select"
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, field: str, value):
        self.eqs[field] = value
        return self

    def in_(self, field: str, values):
        self.in_field = field
        self.in_values = list(values)
        return self

    def or_(self, _expr: str):
        return self

    def maybe_single(self):
        self.maybe = True
        return self

    def execute(self):
        if self.table == "folders":
            return self._exec_folders()
        if self.table == "documents":
            return self._exec_documents()
        return _Result(None)

    def _matched(self, rows):
        matched = list(rows)
        if self.in_field and self.in_values is not None:
            allowed = set(self.in_values)
            matched = [row for row in matched if row.get(self.in_field) in allowed]
        for field, value in self.eqs.items():
            matched = [row for row in matched if row.get(field) == value]
        return matched

    def _exec_folders(self):
        matched = self._matched(self.db.folders)
        if self.op == "select":
            if self.maybe:
                return _Result(matched[0] if matched else None)
            return _Result(matched)
        if self.op == "delete":
            ids = {row["id"] for row in matched}
            self.db.deleted_folder_ids.extend(sorted(ids))
            self.db.folders = [row for row in self.db.folders if row["id"] not in ids]
            return _Result([{"id": folder_id} for folder_id in ids])
        return _Result(None)

    def _exec_documents(self):
        matched = self._matched(self.db.documents)
        if self.op == "select":
            return _Result(matched)
        if self.op == "delete":
            ids = {row["id"] for row in matched}
            self.db.deleted_document_ids.extend(sorted(ids))
            self.db.documents = [
                row for row in self.db.documents if row["id"] not in ids
            ]
            return _Result([{"id": document_id} for document_id in ids])
        return _Result(None)


class _FakeSupabase:
    def __init__(self, folder_rows, document_rows):
        self.folders = folder_rows
        self.documents = document_rows
        self.storage = _Storage(self)
        self.removed_paths = []
        self.deleted_folder_ids = []
        self.deleted_document_ids = []

    def table(self, name: str):
        return _Query(name, self)


def _folder(folder_id: str, user_id: str | None = "user-1", parent_id=None):
    return {
        "id": folder_id,
        "user_id": user_id,
        "parent_id": parent_id,
        "name": folder_id,
    }


def _doc(doc_id: str, folder_id: str, user_id: str = "user-1"):
    return {
        "id": doc_id,
        "user_id": user_id,
        "folder_id": folder_id,
        "storage_path": f"{user_id}/{doc_id}.pdf",
    }


@pytest.mark.asyncio
async def test_delete_folder_deletes_documents_in_descendant_folders(monkeypatch):
    fake = _FakeSupabase(
        folder_rows=[
            _folder("root"),
            _folder("child", parent_id="root"),
            _folder("grandchild", parent_id="child"),
            _folder("sibling"),
        ],
        document_rows=[
            _doc("root-doc", "root"),
            _doc("child-doc", "child"),
            _doc("grandchild-doc", "grandchild"),
            _doc("sibling-doc", "sibling"),
            _doc("other-user-doc", "child", user_id="other-user"),
        ],
    )
    monkeypatch.setattr(folders, "get_supabase_client", lambda: fake)

    result = await folders.delete_folder("root", current_user=User(id="user-1"))

    assert result == {"status": "deleted"}
    assert sorted(fake.deleted_document_ids) == [
        "child-doc",
        "grandchild-doc",
        "root-doc",
    ]
    assert sorted(fake.removed_paths) == [
        "user-1/child-doc.pdf",
        "user-1/grandchild-doc.pdf",
        "user-1/root-doc.pdf",
    ]
    assert {doc["id"] for doc in fake.documents} == {
        "other-user-doc",
        "sibling-doc",
    }
    assert fake.deleted_folder_ids == ["root"]


@pytest.mark.asyncio
async def test_delete_folder_rejects_global_folder_before_cleanup(monkeypatch):
    fake = _FakeSupabase(
        folder_rows=[_folder("shared", user_id=None)],
        document_rows=[_doc("shared-doc", "shared")],
    )
    monkeypatch.setattr(folders, "get_supabase_client", lambda: fake)

    with pytest.raises(HTTPException) as exc:
        await folders.delete_folder("shared", current_user=User(id="user-1"))

    assert exc.value.status_code == 403
    assert fake.deleted_document_ids == []
    assert fake.removed_paths == []
