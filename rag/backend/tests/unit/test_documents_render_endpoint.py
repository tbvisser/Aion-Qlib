import pytest
from fastapi import HTTPException

from app.dependencies import User
from app.routers import documents


class _Result:
    def __init__(self, data):
        self.data = data


class _TableQuery:
    def __init__(self, name: str, db: "_FakeSupabase"):
        self.name = name
        self.db = db
        self.filters: dict[str, str] = {}

    def select(self, _columns: str, **_kwargs):
        return self

    def eq(self, key: str, value: str):
        self.filters[key] = value
        return self

    def maybe_single(self):
        return self

    def execute(self):
        if self.name == "documents":
            if self.filters.get("id") == self.db.document.get("id"):
                return _Result(self.db.document)
            return _Result(None)

        if self.name == "folders":
            folder = self.db.folders.get(self.filters.get("id"))
            return _Result(folder)

        return _Result(None)


class _FakeSupabase:
    def __init__(self, document: dict, folders: dict[str, dict] | None = None):
        self.document = document
        self.folders = folders or {}

    def table(self, name: str):
        return _TableQuery(name, self)


@pytest.mark.asyncio
async def test_document_render_returns_missing_metadata_fallback(monkeypatch):
    monkeypatch.setattr(
        documents,
        "get_supabase_client",
        lambda: _FakeSupabase(
            {
                "id": "doc-1",
                "user_id": "user-1",
                "folder_id": None,
                "full_markdown": "# Existing",
                "document_pages": None,
                "document_structure": None,
            }
        ),
    )

    response = await documents.get_document_render(
        "doc-1",
        current_user=User(id="user-1"),
    )

    assert response == {
        "document_id": "doc-1",
        "markdown": "# Existing",
        "pages": [],
        "structure": None,
    }


@pytest.mark.asyncio
async def test_document_render_rejects_inaccessible_document(monkeypatch):
    monkeypatch.setattr(
        documents,
        "get_supabase_client",
        lambda: _FakeSupabase(
            {
                "id": "doc-1",
                "user_id": "other-user",
                "folder_id": None,
                "full_markdown": "# Secret",
                "document_pages": [],
                "document_structure": None,
            }
        ),
    )

    with pytest.raises(HTTPException) as exc:
        await documents.get_document_render(
            "doc-1",
            current_user=User(id="user-1"),
        )

    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_document_render_allows_global_folder_document(monkeypatch):
    monkeypatch.setattr(
        documents,
        "get_supabase_client",
        lambda: _FakeSupabase(
            {
                "id": "doc-1",
                "user_id": "other-user",
                "folder_id": "folder-1",
                "full_markdown": "# Shared",
                "document_pages": [{"page_no": 1, "markdown": "# Shared"}],
                "document_structure": {"version": 1, "source": "docling", "nodes": []},
            },
            folders={"folder-1": {"user_id": None}},
        ),
    )

    response = await documents.get_document_render(
        "doc-1",
        current_user=User(id="user-1"),
    )

    assert response["document_id"] == "doc-1"
    assert response["pages"] == [{"page_no": 1, "markdown": "# Shared"}]
    assert response["structure"]["version"] == 1
