"""Streaming chat over OpenRouter, with tools that operate the app.

The tool loop runs server-side: the model asks for a tool, we execute it against
the real engine, feed the result back, and repeat until it answers. The browser
never sees the OpenRouter key, and tool results are streamed as their own events
so the UI can show what the assistant actually did rather than just its prose.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sse_starlette.sse import EventSourceResponse

from ..chat_tools import (
    PROFILES, BuilderContext, build_registry, render_context, system_prompt, tool_schemas,
)
from ..auth import Principal, get_principal
from ..config import get_settings
from .runs import _runs  # the live RunManager, so chat-started runs are real runs

logger = logging.getLogger(__name__)
router = APIRouter()

# A tool loop that never terminates would burn credit silently.
MAX_TOOL_ROUNDS = 6
_TIMEOUT = httpx.Timeout(180.0, connect=10.0)

# How much of a tool result the model is allowed to read back.
#
# Two tiers, because the turn being repaired and the turn from five minutes ago
# are worth different amounts. A `propose_strategy` result is 2-4 KB; replaying
# every one of them at full size on every turn is how a builder conversation
# runs out of context in ten exchanges. The most recent turn keeps the full
# budget -- that is the one a repair loop is reading -- and everything older
# keeps only enough to establish that it happened and roughly what it said.
TOOL_RESULT_LIMIT = 12000
OLDER_TURN_LIMIT = 2000


class ChatMessage(BaseModel):
    # `system` is deliberately absent. The server prepends its own system
    # messages, and a plain `str` role would let any caller inject one -- which
    # on the builder profile means talking the assistant out of the constraints
    # the profile exists to impose.
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant", "tool"]
    content: str | None = None
    # Carried so a repair loop survives across turns: without these, the model
    # never sees the tool call it made last turn or the errors that came back,
    # and re-proposes the same broken draft.
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None
    name: str | None = None


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    model: str | None = None
    profile: Literal["general", "builder"] = "general"
    #: What the Strategy Builder has on screen. Only meaningful for "builder".
    context: BuilderContext | None = None


def truncate(text: str, limit: int) -> str:
    """Cut a tool result to size, and say so.

    The bare ``[:12000]`` this replaces cut JSON mid-token, so the model read a
    malformed object and filled in the missing fields from imagination. A marker
    costs nothing and turns a confabulation into a known gap.
    """
    if len(text) <= limit:
        return text
    return f"{text[:limit]}… [truncated, {limit} of {len(text)} characters]"


def _wire(message: ChatMessage, tool_limit: int) -> dict[str, Any]:
    """One client message in the shape OpenRouter expects.

    Built explicitly rather than with ``model_dump(exclude_none=True)``, which
    drops ``content`` when it is None -- and an assistant message that only made
    tool calls has exactly that. The key must be *present and null*, which is
    what the loop below sends for its own transcript.
    """
    out: dict[str, Any] = {"role": message.role}
    if message.role == "assistant" or message.content is not None:
        out["content"] = message.content
    if message.role == "tool" and message.content is not None:
        out["content"] = truncate(message.content, tool_limit)
    if message.tool_calls:
        out["tool_calls"] = message.tool_calls
    if message.tool_call_id:
        out["tool_call_id"] = message.tool_call_id
    if message.name:
        out["name"] = message.name
    return out


def build_conversation(req: ChatRequest) -> list[dict[str, Any]]:
    """The full message list handed to the model, from the request alone.

    Pure and I/O-free on purpose: it is the seam that lets the transcript rules
    -- every tool row preceded by the call it answers, no client-injected system
    message, truncation applied at the right tier -- be tested without an
    OpenRouter key or a network.
    """
    conversation: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt(req.profile)}]
    # Rebuilt from the request every turn and never appended to the transcript,
    # so a superseded spec cannot reach the model out of history.
    rendered = render_context(req.context)
    if rendered:
        conversation.append({"role": "system", "content": rendered})

    # Everything from the last user message onward is the turn in progress.
    latest = 0
    for i in range(len(req.messages) - 1, -1, -1):
        if req.messages[i].role == "user":
            latest = i
            break

    conversation += [
        _wire(m, TOOL_RESULT_LIMIT if i >= latest else OLDER_TURN_LIMIT)
        for i, m in enumerate(req.messages)
    ]
    return conversation


@router.get("/chat/config")
def chat_config(profile: str = "general") -> dict:
    settings = get_settings()
    if profile not in PROFILES:
        raise HTTPException(status_code=404, detail=f"No such chat profile {profile!r}")
    return {
        "configured": bool(settings.openrouter_api_key),
        "model": settings.openrouter_model,
        "profile": profile,
        "tools": [t["function"]["name"] for t in tool_schemas(profile)],
    }


@router.post("/chat")
async def chat(req: ChatRequest,
               principal: Principal = Depends(get_principal)):
    settings = get_settings()
    if not settings.openrouter_api_key:
        raise HTTPException(status_code=503, detail="OPENROUTER_API_KEY is not set in webapp/.env")

    # Bound to the caller: a strategy the assistant saves is theirs, and it can
    # only see runs they could have seen themselves.
    registry = build_registry(_runs, principal, profile=req.profile, context=req.context)
    tools = tool_schemas(req.profile)
    model = req.model or settings.openrouter_model

    conversation = build_conversation(req)

    async def stream():
        headers = {
            "Authorization": f"Bearer {settings.openrouter_api_key}",
            "Content-Type": "application/json",
            # OpenRouter uses these for attribution on its dashboard.
            "HTTP-Referer": "http://localhost:5274",
            "X-Title": "AION",
        }

        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            for round_index in range(MAX_TOOL_ROUNDS):
                body = {
                    "model": model,
                    "messages": conversation,
                    "tools": tools,
                    "stream": True,
                }

                text_parts: list[str] = []
                tool_calls: dict[int, dict] = {}

                try:
                    async with client.stream(
                        "POST", f"{settings.openrouter_base_url}/chat/completions",
                        headers=headers, json=body,
                    ) as resp:
                        if resp.status_code >= 400:
                            detail = (await resp.aread()).decode()[:500]
                            yield {"event": "error", "data": json.dumps(
                                {"message": f"OpenRouter {resp.status_code}: {detail}"})}
                            return

                        async for line in resp.aiter_lines():
                            if not line.startswith("data: "):
                                continue
                            payload = line[6:].strip()
                            if payload == "[DONE]":
                                break
                            try:
                                chunk = json.loads(payload)
                            except json.JSONDecodeError:
                                continue

                            choice = (chunk.get("choices") or [{}])[0]
                            delta = choice.get("delta") or {}

                            piece = delta.get("content")
                            if piece:
                                text_parts.append(piece)
                                yield {"event": "token", "data": json.dumps({"text": piece})}

                            for call in delta.get("tool_calls") or []:
                                index = call.get("index", 0)
                                slot = tool_calls.setdefault(
                                    index,
                                    {"id": "", "type": "function",
                                     "function": {"name": "", "arguments": ""}},
                                )
                                if call.get("id"):
                                    slot["id"] = call["id"]
                                fn = call.get("function") or {}
                                if fn.get("name"):
                                    slot["function"]["name"] = fn["name"]
                                if fn.get("arguments"):
                                    slot["function"]["arguments"] += fn["arguments"]
                except httpx.HTTPError as exc:
                    yield {"event": "error", "data": json.dumps({"message": f"Network error: {exc}"})}
                    return

                assistant_text = "".join(text_parts)

                if not tool_calls:
                    conversation.append({"role": "assistant", "content": assistant_text})
                    yield {"event": "done", "data": json.dumps({"text": assistant_text})}
                    return

                calls = [tool_calls[i] for i in sorted(tool_calls)]
                for position, call in enumerate(calls):
                    if not call["id"]:
                        # Not every provider streams an id. The loop below posts
                        # it straight back as `tool_call_id`, and an empty one is
                        # a 400 on the next round -- so mint one rather than let
                        # it through. The browser is sent the same value, which
                        # is what lets it replay this turn later.
                        call["id"] = f"call_{round_index}_{position}"

                conversation.append({
                    "role": "assistant",
                    "content": assistant_text or None,
                    "tool_calls": calls,
                })

                for call in calls:
                    name = call["function"]["name"]
                    raw_args = call["function"]["arguments"] or "{}"
                    try:
                        args = json.loads(raw_args)
                    except json.JSONDecodeError:
                        args = {}

                    # `id` and `round` are what the browser needs to rebuild this
                    # turn's transcript next time. The id disambiguates two
                    # parallel calls to the same tool, which matching on name
                    # cannot; the round groups them into one assistant message
                    # rather than inventing a turn boundary between them.
                    yield {"event": "tool_call", "data": json.dumps(
                        {"id": call["id"], "round": round_index,
                         "name": name, "arguments": args})}

                    handler = registry.get(name)
                    if handler is None:
                        result: Any = {"error": f"Unknown tool {name}"}
                    else:
                        try:
                            result = handler(**args)
                        except Exception as exc:
                            logger.exception("tool %s failed", name)
                            # Hand the failure back to the model: it can often
                            # recover by adjusting the arguments.
                            result = {"error": f"{type(exc).__name__}: {exc}"}

                    yield {"event": "tool_result", "data": json.dumps(
                        {"id": call["id"], "round": round_index,
                         "name": name, "result": result}, default=str)}

                    conversation.append({
                        "role": "tool",
                        "tool_call_id": call["id"],
                        "content": truncate(
                            json.dumps(result, default=str), TOOL_RESULT_LIMIT),
                    })

            yield {"event": "error", "data": json.dumps(
                {"message": f"Stopped after {MAX_TOOL_ROUNDS} tool rounds without a final answer."})}

    return EventSourceResponse(stream())
