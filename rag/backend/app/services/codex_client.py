"""Chat-Completions-shaped adapter over the Codex (ChatGPT subscription) backend.

The whole app calls ``client.chat.completions.create(...)`` (streaming, with
OpenAI function-calling tools). The Codex subscription, however, only speaks the
**Responses API** at ``{base}/responses``. This adapter exposes the
``chat.completions.create`` interface the app already uses, but internally:

  1. translates the Chat-Completions request (messages/tools/response_format)
     into a Responses request (instructions/input/tools/text.format),
  2. calls ``responses.create`` against the Codex backend with the per-request
     access token + ChatGPT-Account-ID header (refreshing/retrying once on 401),
  3. re-shapes the streamed Responses events back into the exact streaming chunk
     objects the app's loops consume (``chunk.choices[0].delta.content`` /
     ``.tool_calls[i].index/.id/.function.name/.function.arguments`` /
     ``.finish_reason`` and a terminal ``chunk.usage``).

Because the chunk shape matches the OpenAI SDK, none of the agent/primary
streaming loops need to change. All Codex-specific quirks live here and in
``codex_auth``; flip ``LLM_PROVIDER`` to disable instantly.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator

from openai import APIStatusError, AuthenticationError

from app.config import get_settings
from app.services.codex_auth import CodexAuth, get_codex_auth

logger = logging.getLogger(__name__)

# The Codex backend appears to require non-empty instructions.
_DEFAULT_INSTRUCTIONS = "You are a helpful assistant."


# ===========================================================================
# Synthetic objects mirroring the subset of the OpenAI SDK shape consumed by
# the app's streaming loops. Attribute access (not dict access) is what the
# loops use, so these must be objects, not dicts.
# ===========================================================================
@dataclass
class _Fn:
    name: str | None = None
    arguments: str | None = None


@dataclass
class _ToolCallDelta:
    index: int
    id: str | None = None
    type: str = "function"
    function: _Fn = field(default_factory=_Fn)


@dataclass
class _Delta:
    content: str | None = None
    tool_calls: list[_ToolCallDelta] | None = None
    role: str | None = None


@dataclass
class _Choice:
    delta: _Delta
    finish_reason: str | None = None
    index: int = 0


@dataclass
class _Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


@dataclass
class _Chunk:
    choices: list[_Choice]
    usage: _Usage | None = None


def _text_chunk(text: str) -> _Chunk:
    return _Chunk(choices=[_Choice(delta=_Delta(content=text))])


def _tool_call_chunk(index: int, call_id: str | None, name: str | None, args: str | None) -> _Chunk:
    return _Chunk(
        choices=[
            _Choice(
                delta=_Delta(
                    tool_calls=[
                        _ToolCallDelta(
                            index=index,
                            id=call_id,
                            function=_Fn(name=name, arguments=(args or None)),
                        )
                    ]
                )
            )
        ]
    )


def _final_chunk(finish_reason: str, usage: _Usage | None) -> _Chunk:
    return _Chunk(choices=[_Choice(delta=_Delta(), finish_reason=finish_reason)], usage=usage)


# -- non-streaming shapes (best-effort; no routed caller uses these yet) -----
@dataclass
class _Message:
    role: str = "assistant"
    content: str | None = None
    tool_calls: list | None = None


@dataclass
class _NSChoice:
    message: _Message
    finish_reason: str | None = None
    index: int = 0


@dataclass
class _ChatCompletion:
    choices: list[_NSChoice]
    usage: _Usage | None = None


# ===========================================================================
# helpers
# ===========================================================================
def _get(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if isinstance(p, dict) and p.get("text"):
                parts.append(p["text"])
            elif isinstance(p, str):
                parts.append(p)
        return "".join(parts)
    return str(content)


def _content_to_responses_input_parts(content: Any) -> list[dict[str, Any]]:
    if content is None:
        return [{"type": "input_text", "text": ""}]
    if isinstance(content, str):
        return [{"type": "input_text", "text": content}]
    if not isinstance(content, list):
        return [{"type": "input_text", "text": str(content)}]

    parts: list[dict[str, Any]] = []
    for part in content:
        if isinstance(part, str):
            parts.append({"type": "input_text", "text": part})
            continue
        if not isinstance(part, dict):
            parts.append({"type": "input_text", "text": str(part)})
            continue

        ptype = part.get("type")
        if ptype == "text":
            parts.append({"type": "input_text", "text": part.get("text") or ""})
        elif ptype == "image_url":
            image_url = part.get("image_url")
            if isinstance(image_url, dict):
                image_url = image_url.get("url")
            if image_url:
                parts.append({"type": "input_image", "image_url": image_url})

    return parts or [{"type": "input_text", "text": ""}]


def _map_usage(u: Any) -> _Usage | None:
    if u is None:
        return None
    inp = _get(u, "input_tokens", 0) or 0
    out = _get(u, "output_tokens", 0) or 0
    tot = _get(u, "total_tokens", None)
    if tot is None:
        tot = inp + out
    return _Usage(prompt_tokens=inp, completion_tokens=out, total_tokens=tot)


# ===========================================================================
# adapter
# ===========================================================================
class CodexChatClient:
    """Quacks like ``AsyncOpenAI`` for ``chat.completions.create`` over Codex."""

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        reasoning_effort: str | None = None,
        reasoning_summary: str | None = None,
        auth: CodexAuth | None = None,
    ) -> None:
        self._model = model
        self._base_url = base_url
        self._reasoning_effort = reasoning_effort or None
        self._reasoning_summary = reasoning_summary or None
        self._auth = auth or get_codex_auth()
        self.chat = _Chat(self)

    # -- inner client + headers --------------------------------------------
    def _build_inner(self, token: str):
        # Reuse the traced client factory so LangSmith/Langfuse instrument the
        # underlying responses.create call. base_url points at the Codex backend;
        # responses.create posts to "{base_url}/responses".
        from app.services.langsmith import get_traced_async_openai_client

        return get_traced_async_openai_client(base_url=self._base_url, api_key=token)

    def _extra_headers(self) -> dict[str, str]:
        headers = {
            "OpenAI-Beta": "responses=experimental",
            "originator": "codex_cli_rs",
        }
        account_id = self._auth.account_id()
        if account_id:
            headers["ChatGPT-Account-ID"] = account_id
        return headers

    # -- request translation -----------------------------------------------
    def _to_responses_kwargs(self, kwargs: dict[str, Any]) -> dict[str, Any]:
        messages = kwargs.get("messages") or []
        instructions_parts: list[str] = []
        input_items: list[dict[str, Any]] = []

        for m in messages:
            role = m.get("role")
            content = m.get("content")

            if role == "system":
                text = _content_to_text(content)
                if text:
                    instructions_parts.append(text)
                continue

            if role == "tool":
                input_items.append(
                    {
                        "type": "function_call_output",
                        "call_id": m.get("tool_call_id"),
                        "output": content if isinstance(content, str) else json.dumps(content),
                    }
                )
                continue

            if role == "assistant":
                for tc in m.get("tool_calls") or []:
                    fn = tc.get("function", {}) or {}
                    input_items.append(
                        {
                            "type": "function_call",
                            "call_id": tc.get("id"),
                            "name": fn.get("name"),
                            "arguments": fn.get("arguments") or "",
                        }
                    )
                text = _content_to_text(content)
                if text:
                    input_items.append(
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": text}],
                        }
                    )
                continue

            # user / everything else -> input message, preserving multimodal
            # content such as image_url parts.
            input_items.append(
                {
                    "type": "message",
                    "role": role or "user",
                    "content": _content_to_responses_input_parts(content),
                }
            )

        rk: dict[str, Any] = {
            "model": kwargs.get("model") or self._model,
            "instructions": "\n\n".join(instructions_parts) or _DEFAULT_INSTRUCTIONS,
            "input": input_items,
            # Codex is a zero-data-retention path; do not persist responses.
            "store": False,
        }

        tools = kwargs.get("tools")
        if tools:
            rk["tools"] = [self._translate_tool(t) for t in tools]

        tool_choice = kwargs.get("tool_choice")
        if tool_choice is not None:
            rk["tool_choice"] = tool_choice

        text_format = self._translate_response_format(kwargs.get("response_format"))
        if text_format is not None:
            rk["text"] = text_format

        if self._reasoning_effort:
            reasoning = {"effort": self._reasoning_effort}
            # Request a reasoning summary so the UI can render a "Thought process"
            # (the gpt-5 family returns summaries, not raw chain-of-thought).
            if self._reasoning_summary:
                reasoning["summary"] = self._reasoning_summary
            rk["reasoning"] = reasoning

        max_out = kwargs.get("max_output_tokens") or kwargs.get("max_tokens")
        if max_out:
            rk["max_output_tokens"] = max_out

        # NOTE: temperature/top_p are intentionally dropped — the gpt-5 reasoning
        # family rejects them on the Responses API.
        return rk

    @staticmethod
    def _translate_tool(tool: dict[str, Any]) -> dict[str, Any]:
        # Chat Completions: {"type":"function","function":{name,description,parameters}}
        # Responses:        {"type":"function","name","description","parameters"}
        if tool.get("type") == "function" and isinstance(tool.get("function"), dict):
            fn = tool["function"]
            translated = {
                "type": "function",
                "name": fn.get("name"),
                "description": fn.get("description"),
                "parameters": fn.get("parameters"),
            }
            return {k: v for k, v in translated.items() if v is not None}
        return tool  # already Responses-shaped or a non-function tool

    @staticmethod
    def _translate_response_format(response_format: Any) -> dict[str, Any] | None:
        if not response_format:
            return None
        rf_type = response_format.get("type")
        if rf_type == "json_schema":
            js = response_format.get("json_schema", {}) or {}
            fmt: dict[str, Any] = {
                "type": "json_schema",
                "name": js.get("name", "response"),
                "schema": js.get("schema", {}),
            }
            if "strict" in js:
                fmt["strict"] = js["strict"]
            return {"format": fmt}
        if rf_type == "json_object":
            return {"format": {"type": "json_object"}}
        return None

    # -- streaming ----------------------------------------------------------
    async def _create_responses_stream(self, base_rk: dict[str, Any]):
        """Open the Responses stream, refreshing + retrying once on a 401."""
        attempt = 0
        while True:
            token = await self._auth.get_access_token(force_refresh=attempt > 0)
            inner = self._build_inner(token)
            try:
                return await inner.responses.create(
                    **base_rk, stream=True, extra_headers=self._extra_headers()
                )
            except AuthenticationError:
                if attempt == 0:
                    logger.info("Codex 401 — refreshing token and retrying once")
                    attempt += 1
                    continue
                raise
            except APIStatusError as e:
                if getattr(e, "status_code", None) == 401 and attempt == 0:
                    attempt += 1
                    continue
                raise

    async def stream(self, **kwargs) -> AsyncGenerator[_Chunk, None]:
        base_rk = self._to_responses_kwargs(kwargs)
        stream = await self._create_responses_stream(base_rk)
        try:
            async for chunk in self._translate_events(stream):
                yield chunk
        finally:
            close = getattr(stream, "close", None)
            if close:
                try:
                    await close()
                except Exception:
                    pass

    async def _translate_events(self, stream) -> AsyncGenerator[_Chunk, None]:
        # Map Responses output_index -> contiguous chat tool-call index.
        tool_index_by_output: dict[int, int] = {}
        next_tool_index = 0
        saw_tool_call = False
        think_open = False  # streaming a <think>...</think> reasoning summary

        async for event in stream:
            etype = _get(event, "type", "")

            # Reasoning summary: surface as a <think> block so the chat's existing
            # "Thought process" panel renders it. gpt-5 returns summaries (not raw
            # chain-of-thought) only when reasoning.summary was requested.
            if etype == "response.reasoning_summary_text.delta":
                delta = _get(event, "delta", "") or ""
                if delta:
                    if not think_open:
                        think_open = True
                        yield _text_chunk("<think>")
                    yield _text_chunk(delta)
                continue

            if etype == "response.output_text.delta":
                delta = _get(event, "delta", "") or ""
                if delta:
                    if think_open:
                        think_open = False
                        yield _text_chunk("</think>")
                    yield _text_chunk(delta)

            elif etype == "response.output_item.added":
                item = _get(event, "item", None)
                if _get(item, "type") == "function_call":
                    if think_open:
                        think_open = False
                        yield _text_chunk("</think>")
                    output_index = _get(event, "output_index", next_tool_index)
                    idx = next_tool_index
                    next_tool_index += 1
                    tool_index_by_output[output_index] = idx
                    saw_tool_call = True
                    call_id = _get(item, "call_id") or _get(item, "id")
                    yield _tool_call_chunk(
                        idx, call_id, _get(item, "name"), _get(item, "arguments") or ""
                    )

            elif etype == "response.function_call_arguments.delta":
                output_index = _get(event, "output_index", None)
                idx = tool_index_by_output.get(output_index)
                if idx is None:
                    # 'added' wasn't seen (shouldn't happen) — assign on the fly.
                    idx = next_tool_index
                    next_tool_index += 1
                    tool_index_by_output[output_index] = idx
                    saw_tool_call = True
                delta = _get(event, "delta", "") or ""
                if delta:
                    yield _tool_call_chunk(idx, None, None, delta)

            elif etype == "response.completed":
                if think_open:
                    think_open = False
                    yield _text_chunk("</think>")
                resp = _get(event, "response", None)
                usage = _map_usage(_get(resp, "usage", None))
                yield _final_chunk("tool_calls" if saw_tool_call else "stop", usage)
                return

            elif etype in ("response.failed", "response.incomplete", "error"):
                resp = _get(event, "response", None)
                err = _get(event, "message", None) or _get(_get(resp, "error", None), "message", None)
                raise RuntimeError(f"Codex responses stream {etype}: {err or 'unknown error'}")

            # all other events (response.created, .in_progress, content_part.*,
            # output_item.done, reasoning_summary_text.done, output_text.done, ...)
            # are ignored.

    # -- non-streaming (best-effort) ---------------------------------------
    async def non_stream(self, **kwargs) -> _ChatCompletion:
        base_rk = self._to_responses_kwargs(kwargs)
        attempt = 0
        while True:
            token = await self._auth.get_access_token(force_refresh=attempt > 0)
            inner = self._build_inner(token)
            try:
                resp = await inner.responses.create(
                    **base_rk, stream=False, extra_headers=self._extra_headers()
                )
                break
            except AuthenticationError:
                if attempt == 0:
                    attempt += 1
                    continue
                raise

        tool_calls = []
        for item in _get(resp, "output", []) or []:
            if _get(item, "type") == "function_call":
                tool_calls.append(
                    {
                        "id": _get(item, "call_id") or _get(item, "id"),
                        "type": "function",
                        "function": _Fn(name=_get(item, "name"), arguments=_get(item, "arguments") or ""),
                    }
                )
        message = _Message(
            role="assistant",
            content=_get(resp, "output_text", None),
            tool_calls=tool_calls or None,
        )
        return _ChatCompletion(
            choices=[_NSChoice(message=message, finish_reason="tool_calls" if tool_calls else "stop")],
            usage=_map_usage(_get(resp, "usage", None)),
        )


class _Chat:
    def __init__(self, parent: CodexChatClient) -> None:
        self.completions = _Completions(parent)


class _Completions:
    def __init__(self, parent: CodexChatClient) -> None:
        self._parent = parent

    async def create(self, **kwargs):
        # Mirrors AsyncOpenAI: streaming returns an async iterator of chunks;
        # non-streaming returns a completion-like object.
        if kwargs.get("stream"):
            return self._parent.stream(**kwargs)
        return await self._parent.non_stream(**kwargs)


def build_codex_chat_client(
    model: str | None = None, reasoning_effort: str | None = None
) -> CodexChatClient:
    """Construct a Codex chat client from settings.

    ``model`` and ``reasoning_effort`` are overridable per call (e.g. from the
    composer's model picker / thinking toggle); both fall back to the CODEX_*
    env settings when not given.
    """
    settings = get_settings()
    return CodexChatClient(
        model=model or settings.codex_model,
        base_url=settings.codex_base_url,
        reasoning_effort=reasoning_effort or settings.codex_reasoning_effort or None,
        reasoning_summary=getattr(settings, "codex_reasoning_summary", "auto") or None,
    )
