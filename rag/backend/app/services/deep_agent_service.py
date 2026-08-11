"""Deep agent service — general-purpose task delegation to sub-agents."""
import asyncio
import json
import logging
import uuid
from typing import AsyncGenerator, Any

from app.config import get_settings
from app.services.llm_service import (
    CODEX_SUB_AGENT_REASONING_EFFORT,
    get_sub_agent_llm_settings,
    get_system_prompt,
    codex_chat_client_for,
)
from app.services.langsmith import get_traced_async_openai_client, traceable
from app.services.citation_service import (
    CitationContext,
    format_evidence_block_for_alias_numbers,
    format_evidence_block_for_new_aliases,
    sanitize_unowned_aliases,
)

logger = logging.getLogger(__name__)

# Tools excluded from task sub-agents to prevent nested delegation and isolate
# planning. Parent agents may delegate once; child agents must use direct tools.
_EXCLUDED_TOOLS = frozenset((
    "analyze_document",
    "explore_knowledge_base",
    "task",
    "write_todos",
    "read_todos",
    "ask_user",
))


def _filter_tools(parent_tools: list[dict]) -> list[dict]:
    """Return parent tools minus delegation and planning tools."""
    return [
        t for t in parent_tools
        if t.get("function", {}).get("name") not in _EXCLUDED_TOOLS
    ]


def _get_sub_agent_system_prompt(user_id: str | None = None) -> str:
    """Build system prompt for a sub-agent (no planning instructions)."""
    base = get_system_prompt(user_id=user_id, deep_mode=False)
    return (
        base
        + "\n\nYou are a focused sub-agent. Complete the given task and provide "
        "a clear summary of your results. You share the workspace with the "
        "parent agent. Do not delegate to other sub-agents; use direct tools "
        "available to you. Cite supporting evidence inline using the exact "
        "{[S#]} tokens shown next to passages in tool results. Do not invent "
        "citation tokens."
    )


async def _build_sub_agent_context(
    description: str,
    context_files: list[str] | None,
    thread_id: str,
    user_id: str,
) -> str:
    """Build the user message content with optional workspace file context."""
    if not context_files:
        return description

    from app.services.workspace_service import read_file

    parts = [description, "\n\n---\nContext Files:\n"]
    for path in context_files:
        try:
            content = await read_file(thread_id, path, user_id)
            parts.append(f"\n### {path}\n{content}\n")
        except Exception as e:
            parts.append(f"\n### {path}\n(File not found: {e})\n")

    return "".join(parts)


def _reduce_deep_agent_events(events: list) -> dict:
    """Reduce deep agent SSE events for LangSmith tracing."""
    for event in reversed(events):
        if isinstance(event, dict):
            if event.get("type") == "sub_agent_complete":
                return {"result": event.get("result", "")[:500]}
            if event.get("type") == "error":
                return {"error": event.get("error", "")}
    return {"events": len(events)}


@traceable(name="deep_agent_task", run_type="chain", reduce_fn=_reduce_deep_agent_events)
async def run_task_agent(
    description: str,
    context_files: list[str] | None,
    thread_id: str,
    user_id: str,
    parent_tools: list[dict],
    redaction_svc=None,
    system_prompt: str | None = None,
    allowed_tools: list[str] | None = None,
    model_override: str | None = None,
    citation_context: CitationContext | None = None,
    sub_agent_depth: int = 1,
) -> AsyncGenerator[dict[str, Any], None]:
    """
    Run a sub-agent with filtered tools and isolated context.

    Yields SSE-compatible event dicts. The final yield contains the
    sub-agent's result text.
    """
    settings = get_settings()
    max_rounds = settings.max_sub_agent_rounds
    sub_agent_id = str(uuid.uuid4())

    try:
        # Build context
        user_content = await _build_sub_agent_context(
            description, context_files, thread_id, user_id,
        )
        # PII redaction: tool_executor de-anonymized the task args before calling us,
        # and context files hold real values, so user_content is real-space. Anonymize
        # it (consistently, via the per-thread registry) so no real PII reaches the LLM
        # — mirroring run_sub_agent / explorer_agent_service. The sub-agent's output is
        # de-anonymized again before it leaves this function.
        if redaction_svc:
            user_content = await redaction_svc.anonymize(user_content)
        if not system_prompt:
            system_prompt = _get_sub_agent_system_prompt(user_id=user_id)
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]

        # Filter tools
        sub_tools = _filter_tools(parent_tools)
        if allowed_tools is not None:
            sub_tools = [t for t in sub_tools if t.get("function", {}).get("name") in allowed_tools]

        # Use CODEX_MODEL with medium reasoning when Codex is selected. The
        # OpenAI-compatible path keeps the existing sub-agent/model overrides.
        llm_settings: dict[str, Any] = {}
        client = codex_chat_client_for(
            "agent",
            llm_settings,
            reasoning_effort=CODEX_SUB_AGENT_REASONING_EFFORT,
        )
        if client is None:
            llm_settings = get_sub_agent_llm_settings()
            if model_override:
                llm_settings["model"] = model_override
            client = get_traced_async_openai_client(
                base_url=llm_settings["base_url"],
                api_key=llm_settings["api_key"],
            )
    except Exception as e:
        logger.error(f"Sub-agent setup error: {e}")
        yield {
            "type": "sub_agent_start",
            "sub_agent_id": sub_agent_id,
            "description": description,
        }
        yield {
            "type": "error",
            "sub_agent_id": sub_agent_id,
            "error": str(e),
        }
        yield {
            "type": "sub_agent_complete",
            "sub_agent_id": sub_agent_id,
            "result": f"Sub-agent failed during setup: {e}. You may retry with a different approach or ask the user for guidance.",
        }
        return

    yield {
        "type": "sub_agent_start",
        "sub_agent_id": sub_agent_id,
        "description": description,
    }

    last_assistant_text = ""

    try:
        round_num = 0
        while round_num < max_rounds:
            round_num += 1

            request_kwargs: dict[str, Any] = {
                "model": llm_settings["model"],
                "messages": messages,
                "stream": True,
                "stream_options": {"include_usage": True},
            }
            if sub_tools:
                request_kwargs["tools"] = sub_tools

            stream = await client.chat.completions.create(**request_kwargs)

            full_response = ""
            tool_calls_buffer: dict[int, dict] = {}
            finish_reason = None

            async for chunk in stream:
                delta = chunk.choices[0].delta if chunk.choices else None
                chunk_finish = chunk.choices[0].finish_reason if chunk.choices else None
                if chunk_finish:
                    finish_reason = chunk_finish

                if delta and delta.content:
                    full_response += delta.content
                    yield {
                        "type": "text_delta",
                        "sub_agent_id": sub_agent_id,
                        "content": delta.content,
                    }

                if delta and delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index
                        if idx not in tool_calls_buffer:
                            tool_calls_buffer[idx] = {
                                "id": tc.id,
                                "name": tc.function.name if tc.function else None,
                                "arguments": "",
                            }
                        else:
                            if tc.id:
                                tool_calls_buffer[idx]["id"] = tc.id
                            if tc.function and tc.function.name:
                                tool_calls_buffer[idx]["name"] = tc.function.name
                        if tc.function and tc.function.arguments:
                            tool_calls_buffer[idx]["arguments"] += tc.function.arguments

            if finish_reason == "stop":
                last_assistant_text = full_response
                break

            if finish_reason == "tool_calls":
                # Add assistant message with tool_calls
                assistant_msg: dict[str, Any] = {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": tc["id"],
                            "type": "function",
                            "function": {
                                "name": tc["name"],
                                "arguments": tc["arguments"],
                            },
                        }
                        for tc in tool_calls_buffer.values()
                    ],
                }
                messages.append(assistant_msg)

                # Execute tool calls (parallel for simple tools, sequential for generators)
                from app.services.tool_executor import execute_tool_call

                # Tools that return async generators must run sequentially
                _GENERATOR_TOOLS = {"analyze_document", "explore_knowledge_base", "task", "execute_code"}

                all_tcs = list(tool_calls_buffer.values())
                simple_tcs = [tc for tc in all_tcs if tc["name"] not in _GENERATOR_TOOLS]
                generator_tcs = [tc for tc in all_tcs if tc["name"] in _GENERATOR_TOOLS]

                # Emit start events for all tools upfront
                for tc in all_tcs:
                    yield {
                        "type": "tool_call_start",
                        "sub_agent_id": sub_agent_id,
                        "tool_name": tc["name"],
                        "arguments": tc["arguments"],
                    }

                # --- Execute simple tools in parallel ---
                if simple_tcs:
                    async def _run_simple(tc_item):
                        tc_dict = {
                            "name": tc_item["name"],
                            "arguments": tc_item["arguments"],
                            "_thread_id": thread_id,
                        }
                        res = await execute_tool_call(
                            tc_dict, user_id,
                            redaction_svc=redaction_svc,
                            thread_id=thread_id,
                            tools=sub_tools,
                            citation_context=citation_context,
                            sub_agent_depth=sub_agent_depth,
                        )
                        return res if isinstance(res, str) else str(res)

                    if len(simple_tcs) > 1:
                        logger.info(f"[SUB-AGENT] Parallel-executing {len(simple_tcs)} simple tools: {[tc['name'] for tc in simple_tcs]}")
                        simple_results = await asyncio.gather(
                            *[_run_simple(tc) for tc in simple_tcs]
                        )
                    else:
                        simple_results = [await _run_simple(simple_tcs[0])]

                    for tc, tool_result in zip(simple_tcs, simple_results):
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc["id"],
                            "content": tool_result,
                        })
                        yield {
                            "type": "tool_call_complete",
                            "sub_agent_id": sub_agent_id,
                            "tool_name": tc["name"],
                            "result": tool_result[:500],
                        }

                # --- Execute generator tools sequentially ---
                for tc in generator_tcs:
                    tool_call_dict = {
                        "name": tc["name"],
                        "arguments": tc["arguments"],
                        "_thread_id": thread_id,
                    }
                    alias_start = len(citation_context.aliases) if citation_context is not None else 0
                    result = await execute_tool_call(
                        tool_call_dict, user_id,
                        redaction_svc=redaction_svc,
                        thread_id=thread_id,
                        tools=sub_tools,
                        citation_context=citation_context,
                        sub_agent_depth=sub_agent_depth,
                    )

                    # Handle nested async generators (e.g. analyze_document)
                    # TODO: Nested sub-agent events are consumed silently here.
                    # Consider forwarding them with a nesting indicator for UI
                    # visibility (requires frontend coordination).
                    if hasattr(result, "__anext__"):
                        nested_text = ""
                        async for nested_event in result:
                            if nested_event.get("type") in (
                                "sub_agent_complete",
                                "explorer_complete",
                            ):
                                nested_text = nested_event.get(
                                    "result", nested_event.get("findings", "")
                                )
                        if citation_context is not None:
                            new_aliases = citation_context.aliases[alias_start:]
                            owned_numbers = {a.display_number for a in new_aliases}
                            nested_text = sanitize_unowned_aliases(nested_text, owned_numbers)
                            used_numbers = set(citation_context.parse_aliases(nested_text)) & owned_numbers
                            evidence_block = (
                                format_evidence_block_for_alias_numbers(citation_context, used_numbers)
                                if used_numbers
                                else format_evidence_block_for_new_aliases(citation_context, alias_start)
                            )
                            if evidence_block:
                                nested_text = f"{evidence_block}\n\n---\n\n{nested_text}"
                        result = nested_text

                    tool_result = result if isinstance(result, str) else str(result)

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": tool_result,
                    })

                    yield {
                        "type": "tool_call_complete",
                        "sub_agent_id": sub_agent_id,
                        "tool_name": tc["name"],
                        "result": tool_result[:500],
                    }

                # Record any text the LLM produced alongside tool calls
                if full_response:
                    last_assistant_text = full_response

                continue  # Next round

            # Unexpected finish_reason (length, content_filter, None, etc.)
            # Save partial text and stop to avoid infinite loops resending
            # identical messages that will hit the same limit again.
            if full_response:
                last_assistant_text = full_response
            logger.warning(
                f"Sub-agent unexpected finish_reason={finish_reason!r}, "
                f"stopping after round {round_num}"
            )
            break

        else:
            # Loop exhaustion — force summarization
            messages.append({
                "role": "user",
                "content": (
                    "You have reached your iteration limit. "
                    "Summarize your progress and provide your results now."
                ),
            })

            final_stream = await client.chat.completions.create(
                model=llm_settings["model"],
                messages=messages,
                stream=True,
            )

            summary_text = ""
            async for chunk in final_stream:
                delta = chunk.choices[0].delta if chunk.choices else None
                if delta and delta.content:
                    summary_text += delta.content
                    yield {
                        "type": "text_delta",
                        "sub_agent_id": sub_agent_id,
                        "content": delta.content,
                    }

            last_assistant_text = summary_text

    except Exception as e:
        logger.error(f"Sub-agent error: {e}")
        error_msg = (
            f"Sub-agent failed: {e}. You may retry with a different approach "
            "or ask the user for guidance."
        )
        yield {
            "type": "error",
            "sub_agent_id": sub_agent_id,
            "error": str(e),
        }
        yield {
            "type": "sub_agent_complete",
            "sub_agent_id": sub_agent_id,
            "result": error_msg,
        }
        return

    # De-anonymize before the result leaves the sub-agent: it ran in surrogate space
    # (input was anonymized above), so map surrogates back to real values for the parent
    # loop / display — mirroring run_sub_agent and explorer_agent_service.
    if redaction_svc and last_assistant_text:
        last_assistant_text = await redaction_svc.deanonymize_llm_response(last_assistant_text)

    yield {
        "type": "sub_agent_complete",
        "sub_agent_id": sub_agent_id,
        "result": last_assistant_text,
    }
