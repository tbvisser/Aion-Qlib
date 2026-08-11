import io

import pytest
from starlette.datastructures import Headers, UploadFile

from app.dependencies import User
from app.routers import workspace

pytestmark = pytest.mark.unit


class _Result:
    def __init__(self, data):
        self.data = data


class _Storage:
    def __init__(self):
        self.uploads = []

    def from_(self, bucket: str):
        self.bucket = bucket
        return self

    def upload(self, path, content, file_options=None):
        self.uploads.append((path, content, file_options))
        return _Result({"path": path})


class _WorkspaceFilesQuery:
    def __init__(self, db: "_FakeSupabase"):
        self.db = db

    def upsert(self, data, on_conflict=None):
        self.db.saved = data
        self.db.on_conflict = on_conflict
        return self

    def execute(self):
        return _Result([
            {
                "id": "workspace-file-1",
                "created_at": "2026-06-08T00:00:00Z",
                "updated_at": "2026-06-08T00:00:00Z",
                **self.db.saved,
            }
        ])


class _FakeSupabase:
    def __init__(self):
        self.storage = _Storage()
        self.saved = None
        self.on_conflict = None

    def table(self, name: str):
        assert name == "workspace_files"
        return _WorkspaceFilesQuery(self)


def _upload_file(filename: str, content_type: str, body: bytes) -> UploadFile:
    return UploadFile(
        file=io.BytesIO(body),
        filename=filename,
        headers=Headers({"content-type": content_type}),
    )


def test_sanitize_db_text_removes_postgres_invalid_null_bytes():
    assert workspace.workspace_service.sanitize_db_text("alpha\x00beta") == "alphabeta"
    assert workspace.workspace_service.sanitize_db_text("normal text") == "normal text"


@pytest.mark.asyncio
async def test_pdf_upload_sanitizes_extracted_preview_before_upsert(monkeypatch):
    fake = _FakeSupabase()

    async def fake_owns_thread(_thread_id, _user_id):
        return True

    async def fake_extract_text(_file_bytes, _content_type):
        return "Readable PDF text\x00with null"

    monkeypatch.setattr(workspace, "get_supabase_client", lambda: fake)
    monkeypatch.setattr(workspace.workspace_service, "verify_thread_ownership", fake_owns_thread)

    from app.services import text_extraction

    monkeypatch.setattr(text_extraction, "extract_text", fake_extract_text)

    result = await workspace.upload_file(
        "thread-1",
        file=_upload_file("paper.pdf", "application/pdf", b"%PDF-1.7"),
        current_user=User(id="user-1"),
    )

    assert fake.saved["content"] == "Readable PDF textwith null"
    assert "\x00" not in fake.saved["content"]
    assert fake.saved["storage_path"]
    assert fake.storage.uploads
    assert result["content_type"] == "application/pdf"


@pytest.mark.asyncio
async def test_json_upload_is_supported_as_sanitized_text(monkeypatch):
    fake = _FakeSupabase()

    async def fake_owns_thread(_thread_id, _user_id):
        return True

    monkeypatch.setattr(workspace, "get_supabase_client", lambda: fake)
    monkeypatch.setattr(workspace.workspace_service, "verify_thread_ownership", fake_owns_thread)

    result = await workspace.upload_file(
        "thread-1",
        file=_upload_file("data.json", "application/octet-stream", b'{"ok": true, "bad": "\x00"}'),
        current_user=User(id="user-1"),
    )

    assert fake.saved["content"] == '{"ok": true, "bad": ""}'
    assert "storage_path" not in fake.saved
    assert fake.storage.uploads == []
    assert result["content_type"] == "application/json"


@pytest.mark.asyncio
async def test_xlsx_upload_is_supported_as_binary_workspace_file(monkeypatch):
    fake = _FakeSupabase()

    async def fake_owns_thread(_thread_id, _user_id):
        return True

    monkeypatch.setattr(workspace, "get_supabase_client", lambda: fake)
    monkeypatch.setattr(workspace.workspace_service, "verify_thread_ownership", fake_owns_thread)

    result = await workspace.upload_file(
        "thread-1",
        file=_upload_file("workbook.xlsx", "application/octet-stream", b"PK\x03\x04xlsx bytes"),
        current_user=User(id="user-1"),
    )

    assert fake.saved["content"] == ""
    assert fake.saved["storage_path"]
    assert fake.storage.uploads
    assert result["content_type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
