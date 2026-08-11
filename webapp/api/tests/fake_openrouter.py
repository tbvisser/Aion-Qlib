"""A scripted OpenRouter, so the SSE tool loop can be tested without a network.

The loop in ``chat.py`` is the most intricate code in the app -- streamed
tool-call deltas accumulated across chunks, a registry dispatch, a transcript
built for the next round -- and until now none of it had a test, because
exercising it appeared to need an API key and a live model.

It does not. The only thing the loop needs from OpenRouter is a stream of
``data:`` lines. A script says what the model would have done, this turns it into
those lines, and everything downstream is the real code.

Usage::

    fake = FakeOpenRouter([
        [("call", "get_data_status", {})],   # round 0
        [("text", "The data looks fine.")],  # round 1
    ])
    fake.install(monkeypatch)

``fake.bodies`` then holds every request body the loop posted, which is what makes
the "what did round 2 actually send?" assertions possible.
"""
from __future__ import annotations

import copy
import json
from typing import Any

import httpx

Step = tuple

#: Rounds, each a list of steps. A step is ("text", str) or ("call", name, args),
#: and a round may mix them -- a model often speaks before calling a tool.
Script = list[list[Step]]


def _chunk(delta: dict) -> str:
    return f"data: {json.dumps({'choices': [{'delta': delta}]})}"


def _lines(steps: list[Step], omit_ids: bool) -> list[str]:
    """One round, as the `data:` lines a provider would stream.

    Text is split across two chunks and tool-call arguments across three, because
    that is the part of the loop worth exercising: the accumulator has to
    reassemble a JSON string that arrives in fragments, and a test that sends it
    whole would pass against a much simpler implementation.
    """
    out: list[str] = []
    index = 0
    for step in steps:
        if step[0] == "text":
            text = step[1]
            middle = len(text) // 2
            out.append(_chunk({"content": text[:middle]}))
            out.append(_chunk({"content": text[middle:]}))
            continue

        _, name, args = step
        encoded = json.dumps(args)
        head = {"index": index, "function": {"name": name, "arguments": ""}}
        # A provider that never sends an id is a real case, and one the loop has
        # to survive -- an empty `tool_call_id` is a 400 on the next round.
        if not omit_ids:
            head["id"] = f"provider_call_{index}"
        out.append(_chunk({"tool_calls": [head]}))
        for piece in (encoded[:2], encoded[2:]):
            out.append(_chunk({"tool_calls": [
                {"index": index, "function": {"arguments": piece}}]}))
        index += 1

    out.append("data: [DONE]")
    return out


class _Response:
    def __init__(self, lines: list[str], status: int, error_body: str):
        self._lines = lines
        self.status_code = status
        self._error_body = error_body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def aread(self) -> bytes:
        return self._error_body.encode()

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class FakeOpenRouter:
    def __init__(self, script: Script, *, status: int = 200,
                 omit_ids: bool = False, error_body: str = "nope"):
        self.script = script
        self.status = status
        self.omit_ids = omit_ids
        self.error_body = error_body
        #: Every request body the loop posted, in order.
        self.bodies: list[dict[str, Any]] = []

    def install(self, monkeypatch) -> FakeOpenRouter:
        from webapp.api.routers import chat as chat_router

        fake = self

        class Client:
            def __init__(self, *a, **k):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            def stream(self, _method, _url, *, headers=None, json=None):
                # Deep-copied: the loop appends to one `conversation` list across
                # rounds, so storing the reference would make every recorded body
                # show the final state and quietly pass assertions about round 0.
                fake.bodies.append(copy.deepcopy(json))
                round_index = len(fake.bodies) - 1
                steps = (fake.script[round_index]
                         if round_index < len(fake.script) else [("text", "done")])
                return _Response(_lines(steps, fake.omit_ids),
                                 fake.status, fake.error_body)

        monkeypatch.setattr(chat_router.httpx, "AsyncClient", Client)
        return self


def read_events(text: str) -> list[tuple[str, dict]]:
    """Parse an SSE body into (event, payload) pairs.

    sse-starlette terminates lines with CRLF; normalising first is the same thing
    the browser reader has to do, and forgetting it makes every frame invisible.
    """
    events: list[tuple[str, dict]] = []
    for frame in text.replace("\r\n", "\n").split("\n\n"):
        name = "message"
        for line in frame.split("\n"):
            if line.startswith("event: "):
                name = line[7:].strip()
            elif line.startswith("data: "):
                events.append((name, json.loads(line[6:])))
    return events
