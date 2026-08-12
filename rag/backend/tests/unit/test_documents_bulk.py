"""Unit tests for the bulk document endpoints and the flat folder list.

These call the router coroutines directly with a fake Supabase client, so they
need neither a running backend nor a database.
"""
import pytest
from fastapi import BackgroundTasks, HTTPException

from app.dependencies import User
from app.models.schemas import BulkDeleteRequest, BulkMoveRequest
from app.routers import documents, folders


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
        self.eqs: dict[str, str] = {}
        self.in_field: str | None = None
        self.in_values: list[str] | None = None
        self.maybe = False
        self.update_payload: dict | None = None

    def select(self, *_a, **_k):
        self.op = "select"
        return self

    def delete(self):
        self.op = "delete"
        return self

    def update(self, payload: dict):
        self.op = "update"
        self.update_payload = payload
        return self

    def eq(self, key: str, value):
        self.eqs[key] = value
        return self

    def in_(self, field: str, values):
        self.in_field = field
        self.in_values = list(values)
        return self

    def or_(self, _expr: str):
        return self

    def is_(self, _field: str, _val):
        return self

    def order(self, *_a, **_k):
        return self

    def maybe_single(self):
        self.maybe = True
        return self

    def single(self):
        self.maybe = True
        return self

    def execute(self):
        if self.table == "documents":
            return self._exec_documents()
        if self.table == "folders":
            return self._exec_folders()
        return _Result(None)

    def _matched_docs(self):
        docs = self.db.documents
        if self.in_field == "id" and self.in_values is not None:
            allowed = set(self.in_values)
            docs = [d for d in docs if d["id"] in allowed]
        if "user_id" in self.eqs:
            docs = [d for d in docs if d.get("user_id") == self.eqs["user_id"]]
        if "id" in self.eqs:
            docs = [d for d in docs if d.get("id") == self.eqs["id"]]
        return docs

    def _exec_documents(self):
        matched = self._matched_docs()
        if self.op == "select":
            if self.maybe:
                return _Result(matched[0] if matched else None)
            return _Result(list(matched))
        if self.op == "delete":
            ids = {d["id"] for d in matched}
            self.db.documents = [d for d in self.db.documents if d["id"] not in ids]
            self.db.deleted_ids.extend(sorted(ids))
            return _Result([{"id": i} for i in ids])
        if self.op == "update":
            for doc in matched:
                doc.update(self.update_payload or {})
            self.db.updates.append((dict(self.update_payload or {}), [d["id"] for d in matched]))
            return _Result(list(matched))
        return _Result(None)

    def _exec_folders(self):
        if "id" in self.eqs:
            folder = self.db.folders.get(self.eqs["id"])
            if self.maybe:
                return _Result(folder)
            return _Result([folder] if folder else [])
        # No id filter → flat list of every folder (the all=true path)
        return _Result(list(self.db.folders.values()))


class _FakeSupabase:
    def __init__(self, docs: list[dict], folder_ids: list[str] | None = None):
        self.documents = docs
        self.folders = {fid: {"id": fid, "user_id": "user-1", "parent_id": None, "name": fid}
                        for fid in (folder_ids or [])}
        self.storage = _Storage(self)
        self.removed_paths: list[str] = []
        self.deleted_ids: list[str] = []
        self.updates: list[tuple[dict, list[str]]] = []

    def table(self, name: str):
        return _Query(name, self)


def _doc(
    doc_id: str,
    user_id: str = "user-1",
    folder_id=None,
    status: str = "completed",
) -> dict:
    return {
        "id": doc_id,
        "user_id": user_id,
        "storage_path": f"{user_id}/{doc_id}.pdf",
        "folder_id": folder_id,
        "filename": f"{doc_id}.pdf",
        "file_type": "application/pdf",
        "file_size": 123,
        "status": status,
        "error_message": "failed" if status == "failed" else None,
        "ingestion_stage": "failed" if status == "failed" else "completed",
        "ingestion_progress": 100 if status in {"completed", "failed"} else 0,
        "ingestion_message": "failed" if status == "failed" else "Ready",
        "chunk_count": 1 if status == "completed" else 0,
        "content_hash": "hash",
        "hierarchical_index": None,
        "metadata": None,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }


# ---------------------------------------------------------------------------
# bulk_delete_documents
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_bulk_delete_removes_owned_documents(monkeypatch):
    fake = _FakeSupabase([_doc("a"), _doc("b"), _doc("c")])
    monkeypatch.setattr(documents, "get_supabase_client", lambda: fake)

    result = await documents.bulk_delete_documents(
        BulkDeleteRequest(document_ids=["a", "b"]),
        current_user=User(id="user-1"),
    )

    assert set(result["succeeded"]) == {"a", "b"}
    assert result["failed"] == []
    assert {d["id"] for d in fake.documents} == {"c"}
    assert sorted(fake.removed_paths) == ["user-1/a.pdf", "user-1/b.pdf"]


@pytest.mark.asyncio
async def test_bulk_delete_skips_documents_not_owned(monkeypatch):
    # "b" belongs to another user; "missing" does not exist.
    fake = _FakeSupabase([_doc("a"), _doc("b", user_id="other")])
    monkeypatch.setattr(documents, "get_supabase_client", lambda: fake)

    result = await documents.bulk_delete_documents(
        BulkDeleteRequest(document_ids=["a", "b", "missing"]),
        current_user=User(id="user-1"),
    )

    assert result["succeeded"] == ["a"]
    assert set(result["failed"]) == {"b", "missing"}
    assert {d["id"] for d in fake.documents} == {"b"}  # other user's doc untouched


@pytest.mark.asyncio
async def test_bulk_delete_empty_is_noop(monkeypatch):
    fake = _FakeSupabase([_doc("a")])
    monkeypatch.setattr(documents, "get_supabase_client", lambda: fake)

    result = await documents.bulk_delete_documents(
        BulkDeleteRequest(document_ids=[]),
        current_user=User(id="user-1"),
    )

    assert result == {"succeeded": [], "failed": []}
    assert fake.deleted_ids == []


@pytest.mark.asyncio
async def test_bulk_delete_rejects_oversized_request(monkeypatch):
    fake = _FakeSupabase([])
    monkeypatch.setattr(documents, "get_supabase_client", lambda: fake)

    with pytest.raises(HTTPException) as exc:
        await documents.bulk_delete_documents(
            BulkDeleteRequest(document_ids=[f"id-{i}" for i in range(201)]),
            current_user=User(id="user-1"),
        )

    assert exc.value.status_code == 400


# ---------------------------------------------------------------------------
# bulk_move_documents
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_bulk_move_updates_owned_documents(monkeypatch):
    fake = _FakeSupabase([_doc("a"), _doc("b")], folder_ids=["folder-1"])
    monkeypatch.setattr(documents, "get_supabase_client", lambda: fake)

    result = await documents.bulk_move_documents(
        BulkMoveRequest(document_ids=["a", "b"], folder_id="folder-1"),
        current_user=User(id="user-1"),
    )

    assert set(result["succeeded"]) == {"a", "b"}
    assert result["failed"] == []
    assert all(d["folder_id"] == "folder-1" for d in fake.documents)


@pytest.mark.asyncio
async def test_bulk_move_to_root_skips_folder_check(monkeypatch):
    fake = _FakeSupabase([_doc("a", folder_id="folder-1")])
    monkeypatch.setattr(documents, "get_supabase_client", lambda: fake)

    result = await documents.bulk_move_documents(
        BulkMoveRequest(document_ids=["a"], folder_id=None),
        current_user=User(id="user-1"),
    )

    assert result["succeeded"] == ["a"]
    assert fake.documents[0]["folder_id"] is None


@pytest.mark.asyncio
async def test_bulk_move_rejects_unknown_target_folder(monkeypatch):
    fake = _FakeSupabase([_doc("a")])  # no folders registered
    monkeypatch.setattr(documents, "get_supabase_client", lambda: fake)

    with pytest.raises(HTTPException) as exc:
        await documents.bulk_move_documents(
            BulkMoveRequest(document_ids=["a"], folder_id="ghost"),
            current_user=User(id="user-1"),
        )

    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_bulk_move_skips_documents_not_owned(monkeypatch):
    fake = _FakeSupabase([_doc("a"), _doc("b", user_id="other")], folder_ids=["folder-1"])
    monkeypatch.setattr(documents, "get_supabase_client", lambda: fake)

    result = await documents.bulk_move_documents(
        BulkMoveRequest(document_ids=["a", "b"], folder_id="folder-1"),
        current_user=User(id="user-1"),
    )

    assert result["succeeded"] == ["a"]
    assert result["failed"] == ["b"]


# ---------------------------------------------------------------------------
# retry_document
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_retry_document_resets_failed_document_and_requeues(monkeypatch):
    fake = _FakeSupabase([_doc("a", status="failed")])
    deleted: list[str] = []
    background_tasks = BackgroundTasks()

    monkeypatch.setattr(documents, "get_supabase_client", lambda: fake)
    monkeypatch.setattr(
        documents,
        "delete_existing_chunks",
        lambda document_id: deleted.append(document_id) or 0,
    )

    result = await documents.retry_document(
        "a",
        background_tasks=background_tasks,
        current_user=User(id="user-1"),
    )

    assert deleted == ["a"]
    assert result["status"] == "pending"
    assert result["error_message"] is None
    assert result["ingestion_stage"] == "queued"
    assert result["ingestion_progress"] == 0
    assert result["ingestion_message"] == "Queued for retry"
    assert result["chunk_count"] == 0
    assert len(background_tasks.tasks) == 1
    task = background_tasks.tasks[0]
    assert task.func is documents.process_document
    assert task.args == ("a", "user-1")


@pytest.mark.asyncio
async def test_retry_document_rejects_completed_document(monkeypatch):
    fake = _FakeSupabase([_doc("a", status="completed")])
    monkeypatch.setattr(documents, "get_supabase_client", lambda: fake)

    with pytest.raises(HTTPException) as exc:
        await documents.retry_document(
            "a",
            background_tasks=BackgroundTasks(),
            current_user=User(id="user-1"),
        )

    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_retry_document_skips_documents_not_owned(monkeypatch):
    fake = _FakeSupabase([_doc("a", user_id="other", status="failed")])
    monkeypatch.setattr(documents, "get_supabase_client", lambda: fake)

    with pytest.raises(HTTPException) as exc:
        await documents.retry_document(
            "a",
            background_tasks=BackgroundTasks(),
            current_user=User(id="user-1"),
        )

    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# list_folders(all=True)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_folders_all_returns_flat_list(monkeypatch):
    fake = _FakeSupabase([], folder_ids=["root", "child", "deep"])
    monkeypatch.setattr(folders, "get_supabase_client", lambda: fake)

    result = await folders.list_folders(all=True, current_user=User(id="user-1"))

    assert {f["id"] for f in result} == {"root", "child", "deep"}
