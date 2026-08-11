"""Token counting utility using tiktoken."""
import json

import tiktoken


# Per-message overhead constants from the OpenAI cookbook recipe.
TOKENS_PER_MESSAGE = 3
TOKENS_PER_NAME = 1
TOKENS_REPLY_PRIMING = 3


def estimate_tokens(text: str, model: str = "gpt-4o") -> int:
    """
    Estimate the number of tokens in a text string.

    Args:
        text: The text to count tokens for
        model: The model name to use for tokenization (default: gpt-4o)

    Returns:
        Estimated token count
    """
    try:
        # Try to get encoding for the specific model
        encoding = tiktoken.encoding_for_model(model)
    except KeyError:
        # Fall back to cl100k_base for unknown models (used by GPT-4, GPT-3.5-turbo)
        encoding = tiktoken.get_encoding("cl100k_base")

    return len(encoding.encode(text))


def can_fit_in_context(text: str, max_tokens: int = 100000, model: str = "gpt-4o") -> bool:
    """
    Check if text fits within a context window.

    Args:
        text: The text to check
        max_tokens: Maximum allowed tokens (default: 100000)
        model: The model name for tokenization

    Returns:
        True if text fits within max_tokens, False otherwise
    """
    return estimate_tokens(text, model) <= max_tokens


def count_messages_tokens(messages: list[dict], model: str = "gpt-4o") -> int:
    """
    Count tokens for a full OpenAI-format message list, accounting for per-message
    overhead, role tokens, and JSON-serialized tool_calls.

    Recipe source: OpenAI cookbook `num_tokens_from_messages`. The total includes:
      - TOKENS_PER_MESSAGE per message (role + delimiters)
      - Encoded length of each string value (content, role, etc.)
      - JSON-encoded length of tool_calls (assistant messages with tool calls)
      - TOKENS_PER_NAME extra when a `name` field is present
      - TOKENS_REPLY_PRIMING added once at the end (assistant priming)

    Args:
        messages: list of OpenAI-format dicts (role/content/tool_calls/tool_call_id/name).
        model: model name for tokenizer selection.

    Returns:
        Approximate token count of the message list as it would be sent to OpenAI.
    """
    try:
        enc = tiktoken.encoding_for_model(model)
    except KeyError:
        enc = tiktoken.get_encoding("cl100k_base")

    total = 0
    for msg in messages:
        total += TOKENS_PER_MESSAGE
        for key, value in msg.items():
            if value is None:
                continue
            if key == "tool_calls":
                # tool_calls is a list of dicts; the wire format is JSON.
                total += len(enc.encode(json.dumps(value)))
            elif isinstance(value, str):
                total += len(enc.encode(value))
            if key == "name":
                total += TOKENS_PER_NAME
    total += TOKENS_REPLY_PRIMING
    return total
