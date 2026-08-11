"""Unit tests for the GET /documents/search endpoint and its merge helper.

These call the router coroutine directly with a fake Supabase client and a stubbed content
search, so they need neither a running backend, a database, nor an embedding provider — mirroring
the approach in ``test_documents_bulk.py``.
"""
import re

import pytest

from app.dependencies import User
from app.routers import documents

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# Fake Supabase (supports the query chain search_documents_endpoint uses)
# ---------------------------------------------------------------------------

def _like_to_regex(pattern: str) -> "re.Pattern[str]":
    """Convert a SQL ILIKE pattern (with backslash escapes) to a case-insensitive regex.

    Faithful enough to verify wildcard escaping: ``%``/``_`` are wildcards unless preceded by a
    backslash, in which case they (and ``\\``) are literal.
    """
    out: list[str] = []
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "\\" and i + 1 < len(pattern):
            out.append(re.escape(pattern[i + 1]))
            i += 2
            continue
        if ch == "%":
            out.append(".*")
        elif ch == "_":
            out.append(".")
        else:
            out.append(re.escape(ch))
        i += 1
    return re.compile("^" + "".join(out) + "$", re.IGNORECASE | re.DOTALL)


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, db: "_FakeSupabase"):
        self.db = db
        self.eqs: dict[str, str] = {}
        self.ilike_filter: tuple[str, str] | None = None
        self.in_field: str | None = None
        self.in_values: list[str] | None = None
        self.order_key: str | None = None
        self.order_desc = False
        self.limit_n: int | None = None

    def select(self, *_a, **_k):
        return self

    def eq(self, key: str, value):
        self.eqs[key] = value
        return self

    def ilike(self, field: str, pattern: str):
        self.ilike_filter = (field, pattern)
        return self

    def in_(self, field: str, values):
        self.in_field = field
        self.in_values = list(values)
        return self

    def order(self, key: str, desc: bool = False):
        self.order_key = key
        self.order_desc = desc
        return self

    def limit(self, n: int):
        self.limit_n = n
        return self

    def execute(self):
        rows = list(self.db.documents)
        for key, value in self.eqs.items():
            rows = [r for r in rows if r.get(key) == value]
        if self.ilike_filter is not None:
            field, pattern = self.ilike_filter
            rx = _like_to_regex(pattern)
            rows = [r for r in rows if rx.match(r.get(field) or "")]
        if self.in_field is not None:
            allowed = set(self.in_values or [])
            rows = [r for r in rows if r.get(self.in_field) in allowed]
        if self.order_key is not None:
            rows.sort(key=lambda r: r.get(self.order_key) or "", reverse=self.order_desc)
        if self.limit_n is not None:
            rows = rows[: self.limit_n]
        return _Result(rows)


class _FakeSupabase:
    def __init__(self, docs: list[dict]):
        self.documents = docs

    def table(self, _name: str):
        return _Query(self)


def _doc(doc_id: str, filename: str, user_id: str = "user-1", created_at: str = "2026-01-01T00:00:00Z") -> dict:
    return {
        "id": doc_id,
        "user_id": user_id,
        "folder_id": None,
        "filename": filename,
        "file_type": "application/pdf",
        "file_size": 100,
        "storage_path": f"{user_id}/{doc_id}.pdf",
        "status": "completed",
        "error_message": None,
        "ingestion_stage": "completed",
        "ingestion_progress": 100,
        "ingestion_message": "Ready",
        "chunk_count": 1,
        "content_hash": "hash",
        "hierarchical_index": None,
        "metadata": None,
        "created_at": created_at,
        "updated_at": created_at,
    }


def _stub_content_search(chunks: list[dict]):
    """Build an async stand-in for retrieval_service.search_documents returning ``chunks``."""
    async def _fake(query, user_id, top_k=10, threshold=0.3, metadata_filter=None,
                    search_mode="hybrid", folder_ids=None):
        return list(chunks)
    return _fake


def _chunk(doc_id: str) -> dict:
    return {"id": f"chunk-{doc_id}", "document_id": doc_id, "content": "...", "metadata": {}}


async def _search(monkeypatch, docs, *, q, content_chunks=None, limit=50, raise_content=False):
    monkeypatch.setattr(documents, "get_supabase_client", lambda: _FakeSupabase(docs))
    if raise_content:
        async def _boom(*_a, **_k):
            raise RuntimeError("embedding provider down")
        monkeypatch.setattr(documents, "search_documents", _boom)
    else:
        monkeypatch.setattr(documents, "search_documents", _stub_content_search(content_chunks or []))
    return await documents.search_documents_endpoint(q=q, limit=limit, current_user=User(id="user-1"))


# ---------------------------------------------------------------------------
# _merge_search_results (pure helper)
# ---------------------------------------------------------------------------

def test_merge_filename_rows_lead_then_content():
    a, b, c = _doc("a", "a.pdf"), _doc("b", "b.pdf"), _doc("c", "c.pdf")
    merged = documents._merge_search_results([a, b], [c], limit=50)
    assert [r["id"] for r in merged] == ["a", "b", "c"]


def test_merge_dedupes_keeping_filename_position():
    a, b = _doc("a", "a.pdf"), _doc("b", "b.pdf")
    # "a" matches both filename and content; it must appear once, in its filename position.
    merged = documents._merge_search_results([a], [a, b], limit=50)
    assert [r["id"] for r in merged] == ["a", "b"]


def test_merge_caps_at_limit():
    rows = [_doc(str(i), f"{i}.pdf") for i in range(5)]
    merged = documents._merge_search_results(rows, [], limit=2)
    assert [r["id"] for r in merged] == ["0", "1"]


# ---------------------------------------------------------------------------
# search_documents_endpoint
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_empty_query_returns_empty_envelope_without_content_search(monkeypatch):
    called = {"content": False}

    async def _track(*_a, **_k):
        called["content"] = True
        return []

    monkeypatch.setattr(documents, "get_supabase_client", lambda: _FakeSupabase([_doc("a", "a.pdf")]))
    monkeypatch.setattr(documents, "search_documents", _track)

    result = await documents.search_documents_endpoint(q="   ", limit=50, current_user=User(id="user-1"))

    assert result == {"documents": [], "total_count": 0, "has_more": False}
    assert called["content"] is False  # short-circuits before embedding work


@pytest.mark.asyncio
async def test_filename_match_returns_only_matching_docs(monkeypatch):
    docs = [_doc("a", "Quarterly report 2024.pdf"), _doc("b", "grocery list.pdf")]
    result = await _search(monkeypatch, docs, q="report")
    assert [r["id"] for r in result["documents"]] == ["a"]
    assert result["total_count"] == 1
    assert result["has_more"] is False


@pytest.mark.asyncio
async def test_content_match_hydrates_documents_in_rank_order(monkeypatch):
    # No filenames match "synergy"; both surface only via content, ordered by chunk rank (b, then a).
    docs = [_doc("a", "alpha.pdf"), _doc("b", "beta.pdf")]
    result = await _search(monkeypatch, docs, q="synergy", content_chunks=[_chunk("b"), _chunk("a")])
    assert [r["id"] for r in result["documents"]] == ["b", "a"]


@pytest.mark.asyncio
async def test_filename_matches_lead_content_matches_and_dedupe(monkeypatch):
    docs = [_doc("a", "report.pdf"), _doc("b", "beta.pdf")]
    # "report" matches filename of a; content search also returns a (dupe) and b.
    result = await _search(monkeypatch, docs, q="report", content_chunks=[_chunk("a"), _chunk("b")])
    assert [r["id"] for r in result["documents"]] == ["a", "b"]  # a once, filename-first


@pytest.mark.asyncio
async def test_percent_wildcard_is_matched_literally(monkeypatch):
    docs = [_doc("a", "Discount 100% off.pdf"), _doc("b", "No special chars.pdf")]
    result = await _search(monkeypatch, docs, q="100%")
    assert [r["id"] for r in result["documents"]] == ["a"]


@pytest.mark.asyncio
async def test_underscore_wildcard_is_matched_literally(monkeypatch):
    docs = [_doc("a", "build_log.txt"), _doc("b", "buildxlog.txt")]
    result = await _search(monkeypatch, docs, q="build_log")
    assert [r["id"] for r in result["documents"]] == ["a"]


@pytest.mark.asyncio
async def test_search_is_scoped_to_caller(monkeypatch):
    docs = [_doc("a", "report.pdf", user_id="user-1"), _doc("b", "report.pdf", user_id="user-2")]
    # Content search also tries to surface user-2's doc; the hydrate query filters it out by user_id.
    result = await _search(monkeypatch, docs, q="report", content_chunks=[_chunk("b")])
    assert [r["id"] for r in result["documents"]] == ["a"]


@pytest.mark.asyncio
async def test_falls_back_to_filename_when_content_search_fails(monkeypatch):
    docs = [_doc("a", "report.pdf")]
    result = await _search(monkeypatch, docs, q="report", raise_content=True)
    assert [r["id"] for r in result["documents"]] == ["a"]  # degraded, not a 500


@pytest.mark.asyncio
async def test_limit_caps_results(monkeypatch):
    docs = [_doc(str(i), f"report-{i}.pdf") for i in range(5)]
    result = await _search(monkeypatch, docs, q="report", limit=2)
    assert len(result["documents"]) == 2
    assert result["has_more"] is False
