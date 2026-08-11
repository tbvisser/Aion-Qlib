"""Layered message-history compaction.

Three cheap-to-expensive stages run in order, stopping as soon as the assembled
message list fits the budget:

  Stage A (tool_prune)   - replace stored tool-result content for any assistant
                           message older than the recent tail with a short
                           placeholder. Zero LLM cost.
  Stage B (window)       - drop the middle of the thread, keeping first-user-msg
                           + last K turns. Zero LLM cost.
  Stage C (summarize)    - call a small LLM to summarize the evicted middle and
                           persist the summary into ``thread_compactions``.

The service always preserves the OpenAI atomic ``tool_calls`` <-> ``tool`` pairing
(each DB row carrying ``tool_calls`` JSONB is one atomic unit) and never deletes
original messages -- the DB stays the ground truth.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from app.config import get_settings
from app.db.supabase import get_supabase_client
from app.services.langsmith import get_traced_async_openai_client
from app.services.llm_service import get_global_llm_settings
from app.services.token_service import count_messages_tokens

logger = logging.getLogger(__name__)


TOOL_RESULT_PLACEHOLDER = "[Tool result evicted to save context ({chars} chars originally)]"

SUMMARY_SYSTEM_PROMPT = (
    "You are compressing the earlier part of a conversation so it fits in a smaller "
    "context window. Write a concise but information-dense summary that preserves: "
    "user goals, key decisions, file/path/ID/citation references the user gave, "
    "what tools were called and what they returned, and any unresolved threads. "
    "Do NOT include filler, pleasantries, or restate things in the summary that aren't "
    "load-bearing. Output plain prose, no headers, max 800 words."
)


@dataclass
class CompactionResult:
    """Result of a compaction pass.

    ``compacted_messages`` is in OpenAI wire format and is what should be sent
    to the LLM. When ``action == "none"`` no change was made and the caller can
    safely keep its own message list (compacted_messages still contains a valid
    OpenAI-format view for convenience).
    """

    compacted_messages: list[dict]
    compaction_row: dict | None
    action: str  # "none" | "tool_prune" | "window" | "summarize"


class MessageCompactionService:
    def __init__(self, thread_id: str, user_id: str):
        self.thread_id = thread_id
        self.user_id = user_id
        self.settings = get_settings()
        self.supabase = get_supabase_client()

    # ------------------------------------------------------------------ public

    async def compact(
        self,
        raw_messages: list[dict],
        model: str,
        force: bool = False,
    ) -> CompactionResult:
        """Run the compaction pipeline against a thread's raw message rows.

        ``raw_messages`` is the output of selecting
        ``id, role, content, anonymized_content, tool_calls, sequence_number``
        from ``messages`` for the thread, ordered by ``sequence_number``.

        ``model`` is the active chat model name (used for token counting).
        ``force`` (manual /compact endpoint) skips the budget check and forces
        at least Stage B + C if there is anything to evict.
        """
        if not self.settings.compaction_enabled and not force:
            built = self._build_openai_view(raw_messages)
            return CompactionResult(built, None, "none")

        # Safety cap: stop running expensive compactions on pathological threads.
        try:
            count_resp = (
                self.supabase.table("thread_compactions")
                .select("id", count="exact")
                .eq("thread_id", self.thread_id)
                .execute()
            )
            existing_count = count_resp.count or 0
        except Exception as e:
            logger.warning(f"[COMPACTION] could not fetch existing compaction count: {e}")
            existing_count = 0

        if existing_count >= self.settings.compaction_max_per_thread and not force:
            logger.warning(
                f"[COMPACTION] thread={self.thread_id} hit compaction_max_per_thread="
                f"{self.settings.compaction_max_per_thread}; skipping"
            )
            built = self._build_openai_view(raw_messages)
            return CompactionResult(built, None, "none")

        budget = int(self.settings.llm_context_window * self.settings.compaction_trigger_ratio)

        built = self._build_openai_view(raw_messages)
        current_tokens = count_messages_tokens(built, model=model)

        if current_tokens < budget and not force:
            return CompactionResult(built, None, "none")

        logger.info(
            f"[COMPACTION] thread={self.thread_id} over budget: "
            f"{current_tokens} >= {budget} (force={force})"
        )

        # ---------------------------------------------------------- Stage A
        tail_idx = self._tail_start_index(raw_messages)
        pruned_view = self._build_openai_view(
            raw_messages,
            prune_tool_results_before_idx=tail_idx,
        )
        if not force and count_messages_tokens(pruned_view, model=model) < budget:
            return CompactionResult(pruned_view, None, "tool_prune")

        # ---------------------------------------------------------- Stage B
        head_raws, middle_raws, tail_raws = self._partition(raw_messages)
        if not middle_raws:
            # Nothing to evict beyond Stage A.
            return CompactionResult(pruned_view, None, "tool_prune")

        head_view = self._build_openai_view(head_raws)
        # Use the (already-pruned) tail content from `pruned_view` slice — easier:
        tail_view = self._build_openai_view(tail_raws)

        # ---------------------------------------------------------- Stage C
        prev_row: dict | None = None
        try:
            prev = (
                self.supabase.table("thread_compactions")
                .select("*")
                .eq("thread_id", self.thread_id)
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            prev_row = prev.data[0] if prev.data else None
        except Exception as e:
            logger.warning(f"[COMPACTION] could not fetch previous compaction: {e}")

        try:
            summary_text = await self._summarize(
                middle_raws,
                previous_summary=(prev_row or {}).get("summary_text"),
                model=model,
            )
        except Exception as e:
            logger.warning(
                f"[COMPACTION] summarizer failed for thread={self.thread_id}; "
                f"falling back to Stage B window drop: {e}"
            )
            window_view = head_view + tail_view
            return CompactionResult(window_view, None, "window")

        summary_tokens = count_messages_tokens(
            [{"role": "system", "content": summary_text}], model=model
        )

        covers_from = min(
            (m.get("sequence_number", 0) for m in middle_raws),
            default=0,
        )
        covers_to = max(
            (m.get("sequence_number", 0) for m in middle_raws),
            default=0,
        )

        compaction_row: dict | None = None
        try:
            ins = (
                self.supabase.table("thread_compactions")
                .insert(
                    {
                        "thread_id": self.thread_id,
                        "user_id": self.user_id,
                        "summary_text": summary_text,
                        "covers_from_sequence": int(covers_from),
                        "covers_to_sequence": int(covers_to),
                        "evicted_message_count": len(middle_raws),
                        "summary_tokens": summary_tokens,
                        "model_used": self.settings.compaction_model or model,
                        "previous_compaction_id": prev_row["id"] if prev_row else None,
                    }
                )
                .execute()
            )
            compaction_row = ins.data[0] if ins.data else None
        except Exception as e:
            logger.warning(
                f"[COMPACTION] failed to persist compaction row for thread={self.thread_id}: {e}"
            )

        if compaction_row:
            evicted_ids = [m["id"] for m in middle_raws if m.get("id")]
            if evicted_ids:
                try:
                    self.supabase.table("messages").update(
                        {"compaction_id": compaction_row["id"]}
                    ).in_("id", evicted_ids).execute()
                except Exception as e:
                    logger.warning(
                        f"[COMPACTION] failed to tag evicted messages with compaction_id: {e}"
                    )

        summary_msg = {
            "role": "system",
            "content": f"Conversation summary so far:\n\n{summary_text}",
            "_synthetic": True,
        }
        final = head_view + [summary_msg] + tail_view
        return CompactionResult(final, compaction_row, "summarize")

    # ----------------------------------------------------------- view builder

    def _build_openai_view(
        self,
        raw_messages: list[dict],
        prune_tool_results_before_idx: int | None = None,
    ) -> list[dict]:
        """Convert raw DB rows to OpenAI-format messages.

        Mirrors the rebuilder in ``chat.py``: each assistant row with stored
        ``tool_calls`` expands into ``assistant(tool_calls=...)`` plus N
        ``tool`` result messages.

        Prefers ``anonymized_content`` over ``content`` when present (compaction
        runs post-anonymization so summaries never bake in raw PII).

        ``prune_tool_results_before_idx`` -- when set, every raw row with index
        < that value has its rebuilt tool-result content replaced with a short
        placeholder.
        """
        out: list[dict] = []
        for idx, msg in enumerate(raw_messages):
            role = msg.get("role")
            content = msg.get("anonymized_content") or msg.get("content")
            tool_calls = msg.get("tool_calls")

            if role == "assistant" and tool_calls:
                # Lazy import to avoid a circular dependency with chat.py,
                # which imports this service at module scope.
                from app.routers.chat import _rebuild_tool_messages

                tool_msgs = _rebuild_tool_messages(tool_calls)
                if (
                    prune_tool_results_before_idx is not None
                    and idx < prune_tool_results_before_idx
                ):
                    for tm in tool_msgs:
                        if tm.get("role") == "tool":
                            original_len = len(tm.get("content") or "")
                            tm["content"] = TOOL_RESULT_PLACEHOLDER.format(chars=original_len)
                out.extend(tool_msgs)
                if content:
                    out.append({"role": "assistant", "content": content})
            elif role in ("user", "assistant"):
                out.append({"role": role, "content": content})
            elif content is not None:
                # Defensive: pass through any unrecognised role.
                out.append({"role": role, "content": content})
        return out

    # --------------------------------------------------------------- partition

    def _tail_start_index(self, raw_messages: list[dict]) -> int:
        """Return the index in raw_messages where the recent-tail starts.

        Walks backward accumulating built-view tokens until either
        ``keep_recent_tokens`` is exhausted or ``keep_recent_turns`` user-msg
        boundaries are crossed. Whichever cap fires first wins.
        """
        if not raw_messages:
            return 0

        token_cap = self.settings.keep_recent_tokens
        turn_cap = self.settings.keep_recent_turns

        accumulated_tokens = 0
        user_msgs_seen = 0

        # Walk backwards. start_idx is the smallest index still in the tail.
        start_idx = len(raw_messages)
        for i in range(len(raw_messages) - 1, -1, -1):
            row_view = self._build_openai_view([raw_messages[i]])
            row_tokens = count_messages_tokens(row_view) if row_view else 0

            if accumulated_tokens + row_tokens > token_cap and start_idx < len(raw_messages):
                # Adding this would blow the budget and we already have at
                # least one message in the tail.
                break

            accumulated_tokens += row_tokens
            start_idx = i

            if raw_messages[i].get("role") == "user":
                user_msgs_seen += 1
                if user_msgs_seen >= turn_cap:
                    break

        return start_idx

    def _partition(
        self, raw_messages: list[dict]
    ) -> tuple[list[dict], list[dict], list[dict]]:
        """Split raw_messages into (head, middle, tail).

        Head: first user message if present (preserves original intent).
        Tail: last K turns / N tokens worth (see ``_tail_start_index``).
        Middle: everything between -- the eviction candidate slice.

        Each raw message is treated as one atomic unit (the rebuilt
        ``tool_calls`` <-> ``tool`` pair is bundled in a single assistant row).
        """
        if not raw_messages:
            return [], [], []

        head: list[dict] = []
        head_indices: set[int] = set()
        if raw_messages[0].get("role") == "user":
            head.append(raw_messages[0])
            head_indices.add(0)

        tail_start = self._tail_start_index(raw_messages)
        tail = raw_messages[tail_start:]

        middle: list[dict] = []
        for i, msg in enumerate(raw_messages):
            if i in head_indices:
                continue
            if i >= tail_start:
                continue
            middle.append(msg)

        return head, middle, tail

    # -------------------------------------------------------------- tool prune

    def _prune_old_tool_results(
        self, raw_messages: list[dict]
    ) -> list[dict]:
        """Return a shallow copy of raw_messages with old tool results pruned.

        This is provided for unit-test introspection; the production path uses
        ``_build_openai_view(..., prune_tool_results_before_idx=...)`` instead.
        """
        tail_start = self._tail_start_index(raw_messages)
        out: list[dict] = []
        for i, msg in enumerate(raw_messages):
            if i < tail_start and msg.get("tool_calls"):
                pruned_calls = []
                for tc in msg["tool_calls"]:
                    new_tc = dict(tc)
                    if new_tc.get("result"):
                        original_len = len(new_tc["result"])
                        new_tc["result"] = TOOL_RESULT_PLACEHOLDER.format(chars=original_len)
                    pruned_calls.append(new_tc)
                new_msg = dict(msg)
                new_msg["tool_calls"] = pruned_calls
                out.append(new_msg)
            else:
                out.append(msg)
        return out

    # ---------------------------------------------------------------- summarize

    async def _summarize(
        self,
        middle_raws: list[dict],
        previous_summary: str | None,
        model: str,
    ) -> str:
        """Call a cheap LLM to summarize ``middle_raws``.

        Includes the previous summary in the prompt so successive compactions
        produce a single rolling summary rather than independent fragments.
        """
        # Render the evicted slice as plain text so the summarizer can read it.
        middle_view = self._build_openai_view(middle_raws)
        rendered = _render_messages_as_text(middle_view)

        user_prompt_parts: list[str] = []
        if previous_summary:
            user_prompt_parts.append(
                "Earlier summary (already covers content before the messages below):\n\n"
                + previous_summary
            )
        user_prompt_parts.append(
            "Conversation messages to summarize (oldest first):\n\n" + rendered
        )
        user_prompt = "\n\n---\n\n".join(user_prompt_parts)

        summarizer_settings: dict[str, Any] = get_global_llm_settings()
        summarizer_model = self.settings.compaction_model or summarizer_settings["model"]

        client = get_traced_async_openai_client(
            base_url=summarizer_settings["base_url"],
            api_key=summarizer_settings["api_key"],
        )

        completion = await client.chat.completions.create(
            model=summarizer_model,
            messages=[
                {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=self.settings.compaction_summary_max_tokens,
            stream=False,
        )

        choice = completion.choices[0] if completion.choices else None
        text = (choice.message.content if choice and choice.message else "") or ""
        text = text.strip()
        if not text:
            raise RuntimeError("Summarizer returned empty content")
        return text


def _render_messages_as_text(messages: list[dict]) -> str:
    """Flatten a list of OpenAI-format messages into a readable text block."""
    lines: list[str] = []
    for m in messages:
        role = m.get("role", "?")
        content = m.get("content")
        if m.get("tool_calls"):
            calls_repr = json.dumps(m["tool_calls"], ensure_ascii=False)
            lines.append(f"[{role}] tool_calls: {calls_repr}")
            if content:
                lines.append(f"[{role}] {content}")
        elif role == "tool":
            lines.append(f"[tool result for {m.get('tool_call_id', '?')}]\n{content}")
        else:
            lines.append(f"[{role}] {content}")
    return "\n\n".join(lines)


async def create_thread_compaction_service(
    thread_id: str, user_id: str
) -> MessageCompactionService:
    """Async factory mirroring ``create_thread_redaction_service``."""
    return MessageCompactionService(thread_id, user_id)
