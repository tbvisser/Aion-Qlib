"""Unit tests for the layered message-history compaction pipeline.

All tests are pure-logic — no real Supabase, no real LLM. The service's
``self.supabase`` and ``self.settings`` are replaced after construction with
fakes that capture inserts/updates and let each test dial knobs independently.

Why the heavy mock plumbing: the production pipeline is small but its tests
need to exercise atomic-group preservation, fallback paths and recursive
folding -- all things that depend on the precise interaction with the DB +
summarizer LLM, not on the LLM's content.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeQuery:
    """Records the fluent chain and returns the pre-programmed result."""

    def __init__(self, sink: dict, data: list | None = None, count: int | None = None):
        self._sink = sink
        self._data = data if data is not None else []
        self._count = count

    def select(self, *_a, **_k):
        return self

    def insert(self, payload):
        self._sink.setdefault("inserts", []).append(payload)
        # Return inserted row with a synthetic id so the service can chain on it.
        row = dict(payload)
        row.setdefault("id", "compaction-id-1")
        self._data = [row]
        return self

    def update(self, payload):
        self._sink.setdefault("updates", []).append(payload)
        return self

    def eq(self, *_a, **_k):
        return self

    def in_(self, key, values):
        self._sink.setdefault("update_in", []).append((key, list(values)))
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        return SimpleNamespace(data=self._data, count=self._count)


class _FakeSupabase:
    """Captures Supabase calls keyed by table name."""

    def __init__(self):
        self.sink: dict = {}
        # Per-table programmed selects (data list)
        self.programmed: dict[str, dict] = {}

    def table(self, name: str) -> _FakeQuery:
        prog = self.programmed.get(name, {})
        return _FakeQuery(self.sink, data=prog.get("data", []), count=prog.get("count"))


def _make_service(monkeypatch, **settings_overrides):
    """Construct a MessageCompactionService with isolated mocks."""
    from app.services import message_compaction_service as mcs

    # Patch out the chat.py lazy import so we don't require the full app stack.
    def _fake_rebuild(tool_calls_data):
        # Mirrors the production rebuilder semantics but with no external state.
        if not tool_calls_data:
            return []
        openai_calls = []
        tool_results = []
        for tc in tool_calls_data:
            tcid = tc.get("tool_call_id")
            if not tcid:
                continue
            openai_calls.append(
                {
                    "id": tcid,
                    "type": "function",
                    "function": {
                        "name": tc["tool_name"],
                        "arguments": tc["arguments"],
                    },
                }
            )
            if tc.get("result"):
                tool_results.append(
                    {"role": "tool", "tool_call_id": tcid, "content": tc["result"]}
                )
        if not openai_calls:
            return []
        out = [{"role": "assistant", "content": None, "tool_calls": openai_calls}]
        out.extend(tool_results)
        return out

    import sys

    # Stub `app.routers.chat` so the lazy `_rebuild_tool_messages` import works
    # without dragging in FastAPI / Supabase clients at test time.
    if "app.routers.chat" not in sys.modules:
        chat_stub = type(sys)("app.routers.chat")
        chat_stub._rebuild_tool_messages = _fake_rebuild
        sys.modules["app.routers.chat"] = chat_stub
    else:
        sys.modules["app.routers.chat"]._rebuild_tool_messages = _fake_rebuild

    svc = mcs.MessageCompactionService("thread-x", "user-y")

    # Replace the Supabase client + settings with fakes.
    svc.supabase = _FakeSupabase()
    base_settings = svc.settings
    overrides = {
        "compaction_enabled": True,
        "compaction_trigger_ratio": 0.75,
        "llm_context_window": 128000,
        "keep_recent_turns": 4,
        "keep_recent_tokens": 20000,
        "compaction_model": "",
        "compaction_max_per_thread": 50,
        "compaction_summary_max_tokens": 2000,
        "pii_redaction_enabled": False,
    }
    overrides.update(settings_overrides)

    # SimpleNamespace acts as a duck-typed Settings replacement.
    fake_settings = SimpleNamespace(
        **{**base_settings.model_dump(), **overrides}
    )
    svc.settings = fake_settings
    return svc, mcs


def _build_summarizer_completion(text: str = "summary text"):
    """Build the AsyncOpenAI shape the service expects."""
    msg = SimpleNamespace(content=text)
    choice = SimpleNamespace(message=msg)
    return SimpleNamespace(choices=[choice])


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_compact_no_op_under_threshold(monkeypatch):
    """Below budget => returns action='none' and leaves messages alone."""
    svc, mcs = _make_service(monkeypatch)
    raw = [
        {"id": "1", "role": "user", "content": "hi", "sequence_number": 1, "tool_calls": None},
        {"id": "2", "role": "assistant", "content": "hello", "sequence_number": 2, "tool_calls": None},
    ]
    result = await svc.compact(raw, model="gpt-4o")
    assert result.action == "none"
    assert result.compaction_row is None


async def test_count_messages_tokens_includes_tool_calls():
    """tool_calls JSON content must contribute to the token count."""
    from app.services.token_service import count_messages_tokens

    plain = [
        {"role": "assistant", "content": "ok"},
    ]
    with_calls = [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "abc",
                    "type": "function",
                    "function": {"name": "search_documents", "arguments": '{"query": "long argument string"}'},
                }
            ],
        }
    ]
    assert count_messages_tokens(with_calls) > count_messages_tokens(plain)


async def test_tool_result_pruning_stage_a(monkeypatch):
    """Stage A replaces stale tool results with placeholders; tool_call_id pairing preserved."""
    svc, mcs = _make_service(
        monkeypatch,
        llm_context_window=500,
        compaction_trigger_ratio=0.5,
        keep_recent_turns=1,
        keep_recent_tokens=300,
    )

    # Mixed entropy so it actually consumes tokens proportional to length
    # (long runs of a single char tokenize too efficiently to blow the budget).
    big_result = " ".join(f"chunk_{i}" for i in range(800))
    raw = [
        {"id": "1", "role": "user", "content": "do a search", "sequence_number": 1, "tool_calls": None},
        {
            "id": "2",
            "role": "assistant",
            "content": "searching",
            "sequence_number": 2,
            "tool_calls": [
                {
                    "tool_call_id": "tc1",
                    "tool_name": "search_documents",
                    "arguments": '{"q": "x"}',
                    "result": big_result,
                }
            ],
        },
        {"id": "3", "role": "user", "content": "thanks", "sequence_number": 3, "tool_calls": None},
        {"id": "4", "role": "assistant", "content": "yw", "sequence_number": 4, "tool_calls": None},
    ]

    result = await svc.compact(raw, model="gpt-4o")

    # Hard guarantee: compaction MUST have fired -- otherwise the assertions
    # below pass vacuously and the test's name lies.
    assert result.action != "none", (
        f"expected over-budget compaction to run, got action={result.action!r}"
    )

    flat = result.compacted_messages
    tool_msgs = [m for m in flat if m.get("role") == "tool"]
    # Assistant tool_calls and tool result counts must still match.
    assistant_with_calls = [m for m in flat if m.get("tool_calls")]
    if assistant_with_calls:
        expected_tool_ids = {tc["id"] for tc in assistant_with_calls[0]["tool_calls"]}
        actual_tool_ids = {m.get("tool_call_id") for m in tool_msgs}
        assert expected_tool_ids.issubset(actual_tool_ids), "atomic pairing must hold"

    # The big result must have been pruned to a placeholder.
    rendered = json.dumps(flat)
    assert big_result not in rendered, "old tool result should have been pruned"
    assert "Tool result evicted" in rendered, "placeholder text should appear"


async def test_atomic_group_preservation(monkeypatch):
    """The (assistant_with_tool_calls + tool_result) pair must never split.

    The tool_calls row is placed in the *tail* (via keep_recent_turns=2 and a
    high keep_recent_tokens) so it survives compaction; otherwise the loop
    asserting pairing would never execute and the test would pass vacuously.
    """
    svc, mcs = _make_service(
        monkeypatch,
        llm_context_window=1000,
        compaction_trigger_ratio=0.1,
        keep_recent_turns=2,
        keep_recent_tokens=200000,
    )

    fake_client = MagicMock()
    fake_client.chat.completions.create = AsyncMock(
        return_value=_build_summarizer_completion("rolling summary")
    )
    monkeypatch.setattr(
        mcs, "get_traced_async_openai_client", lambda **kwargs: fake_client
    )
    monkeypatch.setattr(
        mcs,
        "get_global_llm_settings",
        lambda: {"model": "gpt-4o", "base_url": None, "api_key": "test"},
    )

    raw = [
        {"id": "u0", "role": "user", "content": "first", "sequence_number": 1, "tool_calls": None},
        # Old turn -- will be evicted into the middle.
        {"id": "u1", "role": "user", "content": "old", "sequence_number": 2, "tool_calls": None},
        {"id": "a1", "role": "assistant", "content": "old resp", "sequence_number": 3, "tool_calls": None},
        # Tool-calls round in the tail so it must survive compaction.
        {
            "id": "a2",
            "role": "assistant",
            "content": "calling",
            "sequence_number": 4,
            "tool_calls": [
                {"tool_call_id": "TC_A", "tool_name": "search_documents", "arguments": "{}", "result": "result body"}
            ],
        },
        {"id": "u2", "role": "user", "content": "tail-user", "sequence_number": 5, "tool_calls": None},
    ]

    result = await svc.compact(raw, model="gpt-4o", force=True)
    flat = result.compacted_messages

    # There must be at least one assistant message with tool_calls in the result.
    assistants_with_calls = [m for m in flat if m.get("tool_calls")]
    assert assistants_with_calls, "tool_calls row should survive compaction in the tail"

    # Every tool_call id must have a matching tool result message in the output.
    for m in assistants_with_calls:
        need_ids = {tc["id"] for tc in m["tool_calls"]}
        have_ids = {t.get("tool_call_id") for t in flat if t.get("role") == "tool"}
        assert need_ids.issubset(have_ids), (
            f"atomic pairing broken: missing {need_ids - have_ids}"
        )


def test_partition_keeps_tool_calls_row_intact(monkeypatch):
    """Lower-level: the row containing tool_calls is never split across head/middle/tail."""
    svc, _ = _make_service(
        monkeypatch,
        keep_recent_turns=1,
        keep_recent_tokens=200000,
    )
    raw = [
        {"id": "u0", "role": "user", "content": "first", "sequence_number": 1, "tool_calls": None},
        {
            "id": "a_tc",
            "role": "assistant",
            "content": "x",
            "sequence_number": 2,
            "tool_calls": [{"tool_call_id": "TC", "tool_name": "t", "arguments": "{}", "result": "r"}],
        },
        {"id": "u1", "role": "user", "content": "tail", "sequence_number": 3, "tool_calls": None},
    ]
    head, middle, tail = svc._partition(raw)
    placements = [
        s
        for s, group in (("head", head), ("middle", middle), ("tail", tail))
        if any(m["id"] == "a_tc" for m in group)
    ]
    assert len(placements) == 1, (
        f"tool_calls row must land in exactly one of head/middle/tail, got {placements}"
    )


async def test_first_user_message_kept(monkeypatch):
    """Even when evicting the middle, the very first user msg stays at the head."""
    svc, mcs = _make_service(
        monkeypatch,
        llm_context_window=1000,
        compaction_trigger_ratio=0.1,
        keep_recent_turns=2,
        keep_recent_tokens=200,
    )
    fake_client = MagicMock()
    fake_client.chat.completions.create = AsyncMock(
        return_value=_build_summarizer_completion("s")
    )
    monkeypatch.setattr(mcs, "get_traced_async_openai_client", lambda **k: fake_client)
    monkeypatch.setattr(
        mcs, "get_global_llm_settings", lambda: {"model": "gpt-4o", "base_url": None, "api_key": "t"}
    )

    raw = []
    raw.append({"id": "u0", "role": "user", "content": "ORIGINAL_INTENT_SENTINEL", "sequence_number": 1, "tool_calls": None})
    for i in range(2, 12):
        raw.append(
            {
                "id": f"m{i}",
                "role": "user" if i % 2 == 0 else "assistant",
                "content": f"filler {i}",
                "sequence_number": i,
                "tool_calls": None,
            }
        )

    result = await svc.compact(raw, model="gpt-4o")
    rendered = json.dumps(result.compacted_messages)
    assert "ORIGINAL_INTENT_SENTINEL" in rendered


async def test_keep_recent_turns_honored(monkeypatch):
    """The tail must always contain at least `keep_recent_turns` user messages."""
    svc, mcs = _make_service(
        monkeypatch,
        llm_context_window=1000,
        compaction_trigger_ratio=0.1,
        keep_recent_turns=3,
        keep_recent_tokens=200000,  # high so it's not the cap that fires
    )
    raw = []
    for i in range(1, 21):
        raw.append(
            {
                "id": f"m{i}",
                "role": "user" if i % 2 == 1 else "assistant",
                "content": f"m{i}",
                "sequence_number": i,
                "tool_calls": None,
            }
        )
    # Check the partition picks at least keep_recent_turns user messages in tail.
    _head, _middle, tail = svc._partition(raw)
    user_in_tail = sum(1 for m in tail if m["role"] == "user")
    assert user_in_tail >= 3


async def test_keep_recent_tokens_overrides_turns(monkeypatch):
    """When token cap fires before turn cap, the tail is bounded by tokens."""
    svc, mcs = _make_service(
        monkeypatch,
        llm_context_window=1000,
        compaction_trigger_ratio=0.1,
        keep_recent_turns=100,  # very high, so turns won't be the cap
        keep_recent_tokens=15,  # very low — only the last message or two can fit
    )
    raw = []
    for i in range(1, 11):
        raw.append(
            {
                "id": f"m{i}",
                "role": "user" if i % 2 == 1 else "assistant",
                "content": f"this is a fairly long message number {i}",
                "sequence_number": i,
                "tool_calls": None,
            }
        )
    _head, _middle, tail = svc._partition(raw)
    # Tail should be much smaller than the full history when token cap is low.
    assert len(tail) < 10
    assert len(tail) >= 1


async def test_recursive_summary_includes_previous(monkeypatch):
    """When a prior compaction exists, its summary text is folded into the new prompt."""
    svc, mcs = _make_service(
        monkeypatch,
        llm_context_window=1000,
        compaction_trigger_ratio=0.1,
        keep_recent_turns=1,
        keep_recent_tokens=100,
    )
    svc.supabase.programmed["thread_compactions"] = {
        "data": [
            {
                "id": "prev-compaction-id",
                "summary_text": "PRIOR_SUMMARY_SENTINEL",
                "created_at": "2026-01-01T00:00:00Z",
            }
        ],
        "count": 1,
    }

    captured = {}

    async def fake_create(**kwargs):
        captured["kwargs"] = kwargs
        return _build_summarizer_completion("new summary")

    fake_client = MagicMock()
    fake_client.chat.completions.create = fake_create
    monkeypatch.setattr(mcs, "get_traced_async_openai_client", lambda **k: fake_client)
    monkeypatch.setattr(
        mcs, "get_global_llm_settings", lambda: {"model": "gpt-4o", "base_url": None, "api_key": "t"}
    )

    raw = [
        {"id": "u0", "role": "user", "content": "first", "sequence_number": 1, "tool_calls": None},
        {"id": "a0", "role": "assistant", "content": "ok", "sequence_number": 2, "tool_calls": None},
        {"id": "u1", "role": "user", "content": "middle1", "sequence_number": 3, "tool_calls": None},
        {"id": "a1", "role": "assistant", "content": "mid resp", "sequence_number": 4, "tool_calls": None},
        {"id": "u2", "role": "user", "content": "tail", "sequence_number": 5, "tool_calls": None},
    ]

    await svc.compact(raw, model="gpt-4o", force=True)
    rendered_prompt = json.dumps(captured["kwargs"]["messages"])
    assert "PRIOR_SUMMARY_SENTINEL" in rendered_prompt


async def test_summarize_failure_falls_back_to_stage_b(monkeypatch):
    """When the summarizer LLM raises, return Stage-B window drop, no exception."""
    svc, mcs = _make_service(
        monkeypatch,
        llm_context_window=1000,
        compaction_trigger_ratio=0.1,
        keep_recent_turns=1,
        keep_recent_tokens=100,
    )

    fake_client = MagicMock()
    fake_client.chat.completions.create = AsyncMock(side_effect=RuntimeError("boom"))
    monkeypatch.setattr(mcs, "get_traced_async_openai_client", lambda **k: fake_client)
    monkeypatch.setattr(
        mcs, "get_global_llm_settings", lambda: {"model": "gpt-4o", "base_url": None, "api_key": "t"}
    )

    raw = [
        {"id": "u0", "role": "user", "content": "first", "sequence_number": 1, "tool_calls": None},
        {"id": "a0", "role": "assistant", "content": "ok", "sequence_number": 2, "tool_calls": None},
        {"id": "u1", "role": "user", "content": "middle", "sequence_number": 3, "tool_calls": None},
        {"id": "a1", "role": "assistant", "content": "resp", "sequence_number": 4, "tool_calls": None},
        {"id": "u2", "role": "user", "content": "tail", "sequence_number": 5, "tool_calls": None},
    ]
    result = await svc.compact(raw, model="gpt-4o", force=True)
    assert result.action == "window"
    assert result.compaction_row is None


async def test_compaction_uses_anonymized_content_not_raw(monkeypatch):
    """Compaction MUST send anonymized_content to the summarizer (privacy).

    The single-line precedence at `_build_openai_view` (anonymized_content or
    content) is the load-bearing privacy guarantee. A future refactor flipping
    it would silently leak raw PII into the persisted summary; this test is the
    wall against that regression.
    """
    svc, mcs = _make_service(
        monkeypatch,
        llm_context_window=1000,
        compaction_trigger_ratio=0.1,
        keep_recent_turns=1,
        keep_recent_tokens=100,
    )

    captured = {}

    async def fake_create(**kwargs):
        captured["kwargs"] = kwargs
        return _build_summarizer_completion("redacted summary text")

    fake_client = MagicMock()
    fake_client.chat.completions.create = fake_create
    monkeypatch.setattr(mcs, "get_traced_async_openai_client", lambda **k: fake_client)
    monkeypatch.setattr(
        mcs,
        "get_global_llm_settings",
        lambda: {"model": "gpt-4o", "base_url": None, "api_key": "t"},
    )

    # First user row (head) is PII-free so the head pass-through doesn't
    # confound the assertion. PII rows go into the middle (eviction window)
    # so they actually flow through the summarizer prompt.
    raw = [
        {
            "id": "u0",
            "role": "user",
            "content": "first message",
            "anonymized_content": "first message",
            "sequence_number": 1,
            "tool_calls": None,
        },
        {
            "id": "u1",
            "role": "user",
            "content": "Hi from RAW_EMAIL_SENTINEL@example.com",
            "anonymized_content": "Hi from <EMAIL_1>",
            "sequence_number": 2,
            "tool_calls": None,
        },
        {
            "id": "a1",
            "role": "assistant",
            "content": "RAW_NAME_SENTINEL Smith",
            "anonymized_content": "<PERSON_1> Smith",
            "sequence_number": 3,
            "tool_calls": None,
        },
        {
            "id": "u2",
            "role": "user",
            "content": "tail",
            "anonymized_content": "tail",
            "sequence_number": 4,
            "tool_calls": None,
        },
    ]

    await svc.compact(raw, model="gpt-4o", force=True)

    rendered_prompt = json.dumps(captured["kwargs"]["messages"])
    # Anonymized tokens MUST appear in the summarizer prompt.
    assert "<EMAIL_1>" in rendered_prompt
    assert "<PERSON_1>" in rendered_prompt
    # Raw PII tokens MUST NOT appear in the summarizer prompt.
    assert "RAW_EMAIL_SENTINEL" not in rendered_prompt
    assert "RAW_NAME_SENTINEL" not in rendered_prompt

    # And exactly one compaction row was persisted (sanity check that the
    # privacy path actually went through the full persistence flow).
    inserts = svc.supabase.sink.get("inserts", [])
    assert len(inserts) == 1


async def test_compaction_row_persisted_correctly(monkeypatch):
    """The inserted compaction row carries the right sequence ranges + counts."""
    svc, mcs = _make_service(
        monkeypatch,
        llm_context_window=1000,
        compaction_trigger_ratio=0.1,
        keep_recent_turns=1,
        keep_recent_tokens=100,
        compaction_model="gpt-4o-mini",  # exercise model_used override
    )
    fake_client = MagicMock()
    fake_client.chat.completions.create = AsyncMock(
        return_value=_build_summarizer_completion("summary")
    )
    monkeypatch.setattr(mcs, "get_traced_async_openai_client", lambda **k: fake_client)
    monkeypatch.setattr(
        mcs,
        "get_global_llm_settings",
        lambda: {"model": "gpt-4o", "base_url": None, "api_key": "t"},
    )

    raw = [
        {"id": "u0", "role": "user", "content": "first", "sequence_number": 1, "tool_calls": None},
        {"id": "a0", "role": "assistant", "content": "ok", "sequence_number": 2, "tool_calls": None},
        {"id": "u1", "role": "user", "content": "middle", "sequence_number": 3, "tool_calls": None},
        {"id": "a1", "role": "assistant", "content": "mid resp", "sequence_number": 4, "tool_calls": None},
        {"id": "u2", "role": "user", "content": "tail", "sequence_number": 5, "tool_calls": None},
    ]

    result = await svc.compact(raw, model="gpt-4o", force=True)
    assert result.action == "summarize"

    inserts = svc.supabase.sink.get("inserts", [])
    assert len(inserts) == 1
    row = inserts[0]
    assert row["thread_id"] == "thread-x"
    assert row["user_id"] == "user-y"
    assert row["covers_from_sequence"] >= 2   # middle starts after first user msg
    assert row["covers_to_sequence"] <= 4     # middle ends before tail
    assert row["evicted_message_count"] >= 1
    assert row["summary_tokens"] > 0
    assert row["model_used"] == "gpt-4o-mini"  # explicit override picked up
    assert row["previous_compaction_id"] is None  # no prior compaction here


async def test_compaction_row_links_to_previous_chain(monkeypatch):
    """When a prior compaction exists, the new row's previous_compaction_id points to it."""
    svc, mcs = _make_service(
        monkeypatch,
        llm_context_window=1000,
        compaction_trigger_ratio=0.1,
        keep_recent_turns=1,
        keep_recent_tokens=100,
    )
    svc.supabase.programmed["thread_compactions"] = {
        "data": [
            {
                "id": "prev-id-123",
                "summary_text": "PRIOR",
                "created_at": "2026-01-01T00:00:00Z",
            }
        ],
        "count": 1,
    }
    fake_client = MagicMock()
    fake_client.chat.completions.create = AsyncMock(
        return_value=_build_summarizer_completion("new summary")
    )
    monkeypatch.setattr(mcs, "get_traced_async_openai_client", lambda **k: fake_client)
    monkeypatch.setattr(
        mcs,
        "get_global_llm_settings",
        lambda: {"model": "gpt-4o", "base_url": None, "api_key": "t"},
    )

    raw = [
        {"id": "u0", "role": "user", "content": "first", "sequence_number": 1, "tool_calls": None},
        {"id": "a0", "role": "assistant", "content": "ok", "sequence_number": 2, "tool_calls": None},
        {"id": "u1", "role": "user", "content": "middle", "sequence_number": 3, "tool_calls": None},
        {"id": "a1", "role": "assistant", "content": "mid resp", "sequence_number": 4, "tool_calls": None},
        {"id": "u2", "role": "user", "content": "tail", "sequence_number": 5, "tool_calls": None},
    ]

    await svc.compact(raw, model="gpt-4o", force=True)
    inserts = svc.supabase.sink.get("inserts", [])
    assert inserts, "expected exactly one persistence insert"
    assert inserts[-1]["previous_compaction_id"] == "prev-id-123"
