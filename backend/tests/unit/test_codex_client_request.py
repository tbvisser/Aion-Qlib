"""Unit tests for Codex request translation (Chat Completions -> Responses). Plan 12, task 3."""
from app.services.codex_client import CodexChatClient, _DEFAULT_INSTRUCTIONS


class _StubAuth:
    def account_id(self):
        return "acct-test"

    async def get_access_token(self, *, force_refresh=False):
        return "tok"


def _client(**kw):
    return CodexChatClient(model="gpt-5.5", base_url="http://x", auth=_StubAuth(), **kw)


def test_system_user_assistant_mapping():
    rk = _client()._to_responses_kwargs(
        {
            "messages": [
                {"role": "system", "content": "Be terse."},
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"},
            ]
        }
    )
    assert rk["instructions"] == "Be terse."
    assert rk["store"] is False
    assert rk["input"] == [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "hello"}]},
    ]


def test_default_instructions_when_no_system():
    rk = _client()._to_responses_kwargs({"messages": [{"role": "user", "content": "hi"}]})
    assert rk["instructions"] == _DEFAULT_INSTRUCTIONS


def test_tool_call_round_trip():
    rk = _client()._to_responses_kwargs(
        {
            "messages": [
                {"role": "user", "content": "search it"},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {"id": "call_1", "type": "function",
                         "function": {"name": "search", "arguments": '{"q":"x"}'}}
                    ],
                },
                {"role": "tool", "tool_call_id": "call_1", "content": "the result"},
            ]
        }
    )
    assert rk["input"] == [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "search it"}]},
        {"type": "function_call", "call_id": "call_1", "name": "search", "arguments": '{"q":"x"}'},
        {"type": "function_call_output", "call_id": "call_1", "output": "the result"},
    ]


def test_user_image_parts_translate_to_responses_input_image():
    rk = _client()._to_responses_kwargs(
        {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "What is in this screenshot?"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
                    ],
                },
            ],
        }
    )
    assert rk["input"] == [
        {
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "What is in this screenshot?"},
                {"type": "input_image", "image_url": "data:image/png;base64,abc"},
            ],
        },
    ]


def test_tools_flattened_to_responses_shape():
    rk = _client()._to_responses_kwargs(
        {
            "messages": [{"role": "user", "content": "x"}],
            "tools": [
                {"type": "function", "function": {
                    "name": "search", "description": "find", "parameters": {"type": "object"}}}
            ],
        }
    )
    assert rk["tools"] == [
        {"type": "function", "name": "search", "description": "find", "parameters": {"type": "object"}}
    ]


def test_response_format_json_schema_to_text_format():
    rk = _client()._to_responses_kwargs(
        {
            "messages": [{"role": "user", "content": "x"}],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "Out", "schema": {"type": "object"}, "strict": True},
            },
        }
    )
    assert rk["text"] == {
        "format": {"type": "json_schema", "name": "Out", "schema": {"type": "object"}, "strict": True}
    }


def test_reasoning_added_and_temperature_dropped():
    rk = _client(reasoning_effort="xhigh")._to_responses_kwargs(
        {"messages": [{"role": "user", "content": "x"}], "temperature": 0.7, "top_p": 0.9, "max_tokens": 256}
    )
    assert rk["reasoning"] == {"effort": "xhigh"}
    assert "temperature" not in rk
    assert "top_p" not in rk
    assert rk["max_output_tokens"] == 256


def test_extra_headers_include_account_id():
    headers = _client()._extra_headers()
    assert headers["ChatGPT-Account-ID"] == "acct-test"
    assert headers["OpenAI-Beta"] == "responses=experimental"
    assert headers["originator"] == "codex_cli_rs"
