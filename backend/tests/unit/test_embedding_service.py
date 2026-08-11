from types import SimpleNamespace

import pytest

from app.services import embedding_service


@pytest.mark.asyncio
async def test_get_embeddings_requests_float_and_splits_empty_data_batches(monkeypatch):
    calls = []

    class FakeEmbeddings:
        async def create(self, **kwargs):
            calls.append(kwargs)
            texts = kwargs["input"]
            if len(texts) > 1:
                raise ValueError("No embedding data received")
            return SimpleNamespace(
                data=[SimpleNamespace(embedding=[float(len(texts[0]))])]
            )

    class FakeClient:
        embeddings = FakeEmbeddings()

    async def no_sleep(_delay):
        return None

    monkeypatch.setattr(
        embedding_service,
        "get_global_embedding_settings",
        lambda: {
            "model": "qwen/qwen3-embedding-8b",
            "base_url": "https://openrouter.ai/api/v1",
            "api_key": "test-key",
            "dimensions": 1536,
        },
    )
    monkeypatch.setattr(
        embedding_service,
        "get_traced_async_openai_client",
        lambda **_kwargs: FakeClient(),
    )
    monkeypatch.setattr(embedding_service.asyncio, "sleep", no_sleep)

    embeddings = await embedding_service.get_embeddings(["a", "abcd"])

    assert embeddings == [[1.0], [4.0]]
    assert calls[0]["encoding_format"] == "float"
    assert calls[0]["dimensions"] == 1536
    # Original batch gets the normal 3 attempts, then falls back to individual calls.
    assert [call["input"] for call in calls] == [
        ["a", "abcd"],
        ["a", "abcd"],
        ["a", "abcd"],
        ["a"],
        ["abcd"],
    ]
