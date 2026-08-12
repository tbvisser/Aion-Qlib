"""Unit tests for citation wiring in tool execution."""

import json

import pytest

from app.services.citation_service import CitationContext
from app.services.tool_executor import execute_tool_call


class _FakeExecuteResult:
    def __init__(self, data):
        self.data = data

    def execute(self):
        return self


class _FakeSupabase:
    def __init__(self, chunks=None):
        self._chunks = chunks or []

    def rpc(self, name, params):
        assert name == "get_chunks_by_ranges"
        assert "p_input_data" in params
        return _FakeExecuteResult(self._chunks)


@pytest.mark.asyncio
async def test_web_search_registers_citation_spans_from_content(monkeypatch):
    from app.services import tool_executor

    async def fake_web_search(query, max_results):
        return [
            {
                "title": "Weather",
                "url": "https://example.com/weather",
                "content": "Visible snippet supports the answer.",
                "raw_content": "Raw page snapshot has different wording for the side panel.",
            }
        ]

    monkeypatch.setattr(tool_executor, "web_search", fake_web_search)

    ctx = CitationContext(turn_id="turn-web", max_aliases=24)
    result = await execute_tool_call(
        {
            "name": "web_search",
            "arguments": json.dumps({"query": "weather", "max_results": 1}),
        },
        "user-1",
        thread_id="thread-1",
        citation_context=ctx,
    )

    assert ctx.aliases
    assert ctx.aliases[0].span.text == "Visible snippet supports the answer."
    assert "Raw page snapshot" not in result
    assert "Citable passages" not in result
    assert "{[S1]} Visible snippet supports the answer." in result
    assert ctx.web_snapshots[ctx.aliases[0].span.source_id]["content"].startswith(
        "Raw page snapshot"
    )


@pytest.mark.asyncio
async def test_read_tool_registers_citation_spans(monkeypatch):
    from app.services import tool_executor

    async def fake_execute_read(document_id, supabase, user_id, start_line=None, end_line=None):
        return (
            "**Document: manual.md** (lines 4-6 of 20)\n\n"
            "4: Section 0330 covers concrete placement.\n"
            "5: The section requires submittals for mix design.\n"
        )

    monkeypatch.setattr(tool_executor, "get_supabase_client", lambda: object())
    monkeypatch.setattr(tool_executor, "execute_read", fake_execute_read)

    ctx = CitationContext(turn_id="turn-read", max_aliases=24)
    result = await execute_tool_call(
        {
            "name": "read",
            "arguments": json.dumps({"document_id": "doc-read", "start_line": 4}),
        },
        "user-1",
        thread_id="thread-1",
        citation_context=ctx,
    )

    assert ctx.aliases
    assert ctx.aliases[0].span.document_id == "doc-read"
    # Inline labeling: no separate re-quoted block, alias injected in place,
    # content shown exactly once.
    assert "Citable evidence" not in result
    assert "{[S1]}" in result
    assert "Section 0330 covers concrete placement." in result


@pytest.mark.asyncio
async def test_get_document_sections_registers_chunk_spans(monkeypatch):
    from app.services import tool_executor

    chunks = [
        {
            "id": "chunk-9",
            "document_id": "doc-sections",
            "chunk_index": 9,
            "content": "Section 0330 requires finishing procedures for concrete surfaces.",
            "metadata": {"content_type": "application/pdf"},
        }
    ]
    monkeypatch.setattr(tool_executor, "get_supabase_client", lambda: _FakeSupabase(chunks))
    monkeypatch.setattr(
        tool_executor,
        "_document_titles_by_id",
        lambda supabase, ids: {"doc-sections": "manual.pdf"},
    )

    ctx = CitationContext(turn_id="turn-sections", max_aliases=24)
    result = await execute_tool_call(
        {
            "name": "get_document_sections",
            "arguments": json.dumps({
                "items": [
                    {"document_id": "doc-sections", "chunk_ranges": [[9, 9]]}
                ]
            }),
        },
        "user-1",
        thread_id="thread-1",
        citation_context=ctx,
    )

    assert ctx.aliases
    assert ctx.aliases[0].span.title == "manual.pdf"
    assert ctx.aliases[0].span.chunk_id == "chunk-9"
    assert "Citable evidence" not in result
    assert "{[S1]}" in result


@pytest.mark.asyncio
async def test_analyze_document_forwards_citation_context(monkeypatch):
    from app.services import tool_executor

    captured = {}

    async def fake_generator():
        yield {"type": "sub_agent_complete", "result": "Done {[S1]}."}

    def fake_run_sub_agent(document_id, user_id, query, redaction_svc=None, citation_context=None):
        captured["document_id"] = document_id
        captured["citation_context"] = citation_context
        return fake_generator()

    monkeypatch.setattr(tool_executor, "run_sub_agent", fake_run_sub_agent)

    ctx = CitationContext(turn_id="turn-analyze", max_aliases=24)
    result = await execute_tool_call(
        {
            "name": "analyze_document",
            "arguments": json.dumps({"document_id": "doc-analyze", "query": "summarize"}),
        },
        "user-1",
        thread_id="thread-1",
        citation_context=ctx,
    )

    assert hasattr(result, "__anext__")
    assert captured["document_id"] == "doc-analyze"
    assert captured["citation_context"] is ctx


@pytest.mark.asyncio
async def test_sub_agent_depth_blocks_nested_sub_agent_tools():
    ctx = CitationContext(turn_id="turn-depth", max_aliases=24)

    result = await execute_tool_call(
        {
            "name": "analyze_document",
            "arguments": json.dumps({"document_id": "doc-analyze", "query": "summarize"}),
        },
        "user-1",
        thread_id="thread-1",
        citation_context=ctx,
        sub_agent_depth=1,
    )

    assert isinstance(result, str)
    assert "cannot be called from inside a sub-agent" in result


def test_task_sub_agent_filters_delegation_tools():
    from app.services.deep_agent_service import _filter_tools

    parent_tools = [
        {"function": {"name": "search_documents"}},
        {"function": {"name": "analyze_document"}},
        {"function": {"name": "explore_knowledge_base"}},
        {"function": {"name": "task"}},
        {"function": {"name": "read_todos"}},
    ]

    filtered_names = [tool["function"]["name"] for tool in _filter_tools(parent_tools)]

    assert filtered_names == ["search_documents"]


def test_explorer_tools_do_not_include_analyze_document():
    from app.services.explorer_agent_service import build_explorer_tools

    names = [
        tool.get("function", {}).get("name")
        for tool in build_explorer_tools()
    ]

    assert "analyze_document" not in names
    assert "read" in names
    assert "get_document_sections" in names


@pytest.mark.asyncio
async def test_navigation_tool_strips_stale_aliases(monkeypatch):
    from app.services import tool_executor

    async def fake_execute_ls(path, supabase, user_id):
        return "Contents of root include a literal stale marker {[S1]}."

    monkeypatch.setattr(tool_executor, "get_supabase_client", lambda: object())
    monkeypatch.setattr(tool_executor, "execute_ls", fake_execute_ls)

    ctx = CitationContext(turn_id="turn-neutral", max_aliases=24)
    result = await execute_tool_call(
        {"name": "ls", "arguments": json.dumps({"path": "root"})},
        "user-1",
        thread_id="thread-1",
        citation_context=ctx,
    )

    assert "{[S1]}" not in result
    assert not ctx.aliases


def test_spans_for_document_registers_every_sentence_in_order():
    # Plan 23 A3: analyze_document makes every sentence citable in reading order
    # (no top-N keyword selection), so the body can be inline-labeled once.
    from app.services.sub_agent_service import _spans_for_document
    from app.services.citation_service import inline_label_result

    sentences = [
        f"Distinct and clearly citable sentence number {i} with more than enough length here."
        for i in range(15)
    ]
    content = " ".join(sentences)
    doc = {"id": "doc-1", "filename": "report.pdf", "content": content, "metadata": {}}

    spans = _spans_for_document(doc)
    assert len(spans) > 8  # every sentence citable, not the old top-8 selection
    positions = [content.find(s.text) for s in spans]
    assert all(p >= 0 for p in positions)
    assert positions == sorted(positions)  # reading order preserved

    ctx = CitationContext(turn_id="t")
    aliases = ctx.register_spans(spans)
    labeled = inline_label_result(content, aliases)
    assert all(a.display_ref in labeled for a in aliases)
