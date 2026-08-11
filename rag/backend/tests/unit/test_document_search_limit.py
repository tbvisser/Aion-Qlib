"""Unit tests for document search retrieval limits."""

import inspect
import json

import pytest

from app.services.tool_executor import execute_tool_call

pytestmark = pytest.mark.unit


@pytest.mark.asyncio
async def test_search_documents_tool_returns_ten_chunks_by_default(monkeypatch):
    from app.services import retrieval_service
    from app.services import tool_executor

    default_top_k = inspect.signature(
        retrieval_service.search_documents
    ).parameters["top_k"].default
    assert default_top_k == 10

    captured = {}

    async def fake_search_documents(
        query,
        user_id,
        top_k=default_top_k,
        threshold=0.3,
        metadata_filter=None,
        search_mode="hybrid",
        folder_ids=None,
    ):
        captured["top_k"] = top_k
        return [
            {
                "id": f"chunk-{idx}",
                "document_id": "doc-1",
                "content": f"Chunk {idx}",
                "metadata": {"filename": "doc.md", "chunk_index": idx},
            }
            for idx in range(top_k)
        ]

    monkeypatch.setattr(tool_executor, "search_documents", fake_search_documents)

    result = await execute_tool_call(
        {
            "name": "search_documents",
            "arguments": json.dumps({"query": "benefits policy"}),
        },
        "user-1",
    )

    assert captured["top_k"] == 10
    assert result.count("[Source: doc.md]") == 10
