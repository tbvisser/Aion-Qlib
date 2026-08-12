"""API tests for thread CRUD and data isolation."""

import httpx
import pytest

pytestmark = pytest.mark.api


async def test_create_thread_default_title(api1: httpx.AsyncClient):
    resp = await api1.post("/threads", json={})
    assert resp.status_code == 201
    data = resp.json()
    assert data["title"] == "New Chat"
    assert "id" in data
    assert "user_id" in data


async def test_create_thread_custom_title(api1: httpx.AsyncClient):
    resp = await api1.post("/threads", json={"title": "Test Thread"})
    assert resp.status_code == 201
    assert resp.json()["title"] == "Test Thread"


async def test_list_threads_returns_envelope(api1: httpx.AsyncClient):
    resp = await api1.get("/threads")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, dict)
    assert isinstance(data["threads"], list)
    assert isinstance(data["total_count"], int)
    assert isinstance(data["has_more"], bool)


async def test_list_threads_pagination(api1: httpx.AsyncClient):
    for i in range(3):
        await api1.post("/threads", json={"title": f"Page Thread {i}"})

    page1 = await api1.get("/threads?limit=2&offset=0")
    assert page1.status_code == 200
    d1 = page1.json()
    assert len(d1["threads"]) <= 2
    assert d1["total_count"] >= 3
    assert d1["has_more"] is True

    page2 = await api1.get("/threads?limit=2&offset=2")
    d2 = page2.json()
    ids1 = {t["id"] for t in d1["threads"]}
    ids2 = {t["id"] for t in d2["threads"]}
    assert ids1.isdisjoint(ids2)


async def test_list_threads_search_filters_by_title(api1: httpx.AsyncClient):
    await api1.post("/threads", json={"title": "Invoice questions Q3"})
    await api1.post("/threads", json={"title": "Random recipe ideas"})

    resp = await api1.get("/threads?search=invoice")
    assert resp.status_code == 200
    titles = [t["title"] for t in resp.json()["threads"]]
    assert any("Invoice" in t for t in titles)
    assert all("recipe" not in t.lower() for t in titles)


async def test_list_threads_search_is_case_insensitive(api1: httpx.AsyncClient):
    await api1.post("/threads", json={"title": "CamelCase Title Here"})
    resp = await api1.get("/threads?search=camelcase")
    assert resp.status_code == 200
    assert any("CamelCase" in t["title"] for t in resp.json()["threads"])


async def test_list_threads_search_escapes_percent_literal(api1: httpx.AsyncClient):
    # `%` is an ILIKE wildcard; user-supplied `%` must be matched literally,
    # not expanded to match every title.
    await api1.post("/threads", json={"title": "Discount 100% off"})
    await api1.post("/threads", json={"title": "No special chars here"})
    resp = await api1.get("/threads", params={"search": "100%"})
    assert resp.status_code == 200
    titles = [t["title"] for t in resp.json()["threads"]]
    assert any("100%" in t for t in titles)
    assert not any("No special chars" in t for t in titles)


async def test_list_threads_search_escapes_underscore_literal(api1: httpx.AsyncClient):
    # `_` is the ILIKE single-char wildcard; user-supplied `_` must be literal.
    await api1.post("/threads", json={"title": "build_log.txt"})
    await api1.post("/threads", json={"title": "buildxlog file"})
    resp = await api1.get("/threads", params={"search": "build_log"})
    assert resp.status_code == 200
    titles = [t["title"] for t in resp.json()["threads"]]
    assert any("build_log" in t for t in titles)
    assert not any("buildxlog" in t for t in titles)


async def test_list_threads_search_escapes_backslash_literal(api1: httpx.AsyncClient):
    # `\` is the SQL ESCAPE character used to neutralize the % / _ wildcards;
    # user-supplied `\` must therefore be escaped first (replacement order).
    await api1.post("/threads", json={"title": r"path\to\file"})
    resp = await api1.get("/threads", params={"search": r"path\to"})
    assert resp.status_code == 200
    titles = [t["title"] for t in resp.json()["threads"]]
    assert any(r"path\to" in t for t in titles)


async def test_list_threads_limit_clamped(api1: httpx.AsyncClient):
    resp = await api1.get("/threads?limit=5000")
    assert resp.status_code == 200
    assert len(resp.json()["threads"]) <= 200


async def test_get_thread_by_id(api1: httpx.AsyncClient):
    # Create then fetch
    create = await api1.post("/threads", json={"title": "Fetch Me"})
    thread_id = create.json()["id"]

    resp = await api1.get(f"/threads/{thread_id}")
    assert resp.status_code == 200
    assert resp.json()["title"] == "Fetch Me"


async def test_update_thread_title(api1: httpx.AsyncClient):
    create = await api1.post("/threads", json={"title": "Before"})
    thread_id = create.json()["id"]

    resp = await api1.patch(f"/threads/{thread_id}", json={"title": "After"})
    assert resp.status_code == 200
    assert resp.json()["title"] == "After"


async def test_delete_thread(api1: httpx.AsyncClient):
    create = await api1.post("/threads", json={"title": "Delete Me"})
    thread_id = create.json()["id"]

    resp = await api1.delete(f"/threads/{thread_id}")
    assert resp.status_code == 204


@pytest.mark.isolation
async def test_user2_cannot_see_user1_thread(
    api1: httpx.AsyncClient, api2: httpx.AsyncClient
):
    create = await api1.post("/threads", json={"title": "User1 Only"})
    thread_id = create.json()["id"]

    resp = await api2.get(f"/threads/{thread_id}")
    assert resp.status_code == 404


@pytest.mark.isolation
async def test_user2_cannot_delete_user1_thread(
    api1: httpx.AsyncClient, api2: httpx.AsyncClient
):
    create = await api1.post("/threads", json={"title": "No Touch"})
    thread_id = create.json()["id"]

    resp = await api2.delete(f"/threads/{thread_id}")
    assert resp.status_code == 404


async def test_nonexistent_thread_returns_404(api1: httpx.AsyncClient):
    resp = await api1.get("/threads/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404
