"""Unit tests: paginated list endpoints tolerate an out-of-range offset.

When a client requests an offset past the end of the result set, PostgREST raises
PGRST103 ("Requested range not satisfiable") instead of returning an empty page.
This happens routinely in practice: the row count can shrink between a client's
successive page requests (e.g. uploads failing or being cleaned up during bulk
ingestion), leaving the client's offset beyond the current count. The list
endpoints must degrade to an empty final page rather than surfacing a 500.
"""

import pytest
from postgrest.exceptions import APIError

from app.dependencies import User

pytestmark = pytest.mark.unit


class _Result:
    def __init__(self, data=None, count=None):
        self.data = data
        self.count = count


class _FolderCheckQuery:
    """Stub for the ``folders`` look-up that precedes the documents query."""

    def select(self, *args, **kwargs):
        return self

    def eq(self, *args, **kwargs):
        return self

    def maybe_single(self):
        return self

    def execute(self):
        # Folder not found / not a global folder -> caller falls back to own docs.
        return _Result(data=None)


class _RaisingQuery:
    """Chainable Supabase query stub whose ``.execute()`` raises ``error``."""

    def __init__(self, error):
        self._error = error

    def select(self, *args, **kwargs):
        return self

    def eq(self, *args, **kwargs):
        return self

    def is_(self, *args, **kwargs):
        return self

    def ilike(self, *args, **kwargs):
        return self

    def order(self, *args, **kwargs):
        return self

    def range(self, *args, **kwargs):
        return self

    def execute(self):
        raise self._error


class _FakeSupabase:
    """Routes ``folders`` to a benign look-up and everything else to a raiser."""

    def __init__(self, error):
        self._error = error

    def table(self, name):
        if name == "folders":
            return _FolderCheckQuery()
        return _RaisingQuery(self._error)


def _range_not_satisfiable() -> APIError:
    return APIError(
        {
            "message": "Requested range not satisfiable",
            "code": "PGRST103",
            "hint": None,
            "details": "An offset of 150 was requested, but there are only 114 rows.",
        }
    )


@pytest.mark.asyncio
async def test_list_documents_out_of_range_offset_returns_empty_page(monkeypatch):
    from app.routers import documents

    monkeypatch.setattr(
        documents, "get_supabase_client", lambda: _FakeSupabase(_range_not_satisfiable())
    )

    # Mirrors the reported request: ?folder_id=...&offset=150&limit=50
    result = await documents.list_documents(
        folder_id="88b8ce5b-3030-4c7d-b3a2-cba623a047c1",
        offset=150,
        limit=50,
        current_user=User(id="user-1"),
    )

    assert result == {"documents": [], "total_count": 0, "has_more": False}


@pytest.mark.asyncio
async def test_list_documents_other_api_error_propagates(monkeypatch):
    from app.routers import documents

    other = APIError({"message": "boom", "code": "PGRST500", "hint": None, "details": None})
    monkeypatch.setattr(documents, "get_supabase_client", lambda: _FakeSupabase(other))

    with pytest.raises(APIError):
        await documents.list_documents(
            folder_id=None, offset=0, limit=50, current_user=User(id="user-1")
        )


@pytest.mark.asyncio
async def test_list_threads_out_of_range_offset_returns_empty_page(monkeypatch):
    from app.routers import threads

    monkeypatch.setattr(
        threads, "get_supabase_client", lambda: _FakeSupabase(_range_not_satisfiable())
    )

    result = await threads.list_threads(
        search=None, offset=150, limit=50, current_user=User(id="user-1")
    )

    assert result == {"threads": [], "total_count": 0, "has_more": False}


@pytest.mark.asyncio
async def test_list_threads_other_api_error_propagates(monkeypatch):
    from app.routers import threads

    other = APIError({"message": "boom", "code": "PGRST500", "hint": None, "details": None})
    monkeypatch.setattr(threads, "get_supabase_client", lambda: _FakeSupabase(other))

    with pytest.raises(APIError):
        await threads.list_threads(
            search=None, offset=0, limit=50, current_user=User(id="user-1")
        )
