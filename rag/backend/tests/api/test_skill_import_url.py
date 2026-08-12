"""API tests for POST /skills/import-from-url (remote skill import).

The success path hits real GitHub, so it is marked ``slow`` and skips gracefully
when GitHub is unavailable (rate limit / network). The validation path needs only
the running backend.
"""
import pytest

pytestmark = pytest.mark.api


async def _delete_skill_named(api1, name: str) -> None:
    """Remove any of the user's own skills with the given name (idempotent setup)."""
    resp = await api1.get("/skills")
    if resp.status_code != 200:
        return
    for s in resp.json():
        if s["name"] == name and s.get("user_id"):
            await api1.delete(f"/skills/{s['id']}")


async def test_import_from_url_rejects_unparseable_source(api1):
    resp = await api1.post(
        "/skills/import-from-url", json={"source": "not a valid skill source"}
    )
    assert resp.status_code == 400


async def test_import_from_url_requires_auth(api):
    resp = await api.post(
        "/skills/import-from-url", json={"source": "anthropics/skills/docx"}
    )
    assert resp.status_code in (401, 403)


@pytest.mark.slow
async def test_import_docx_skill_from_skills_sh(api1):
    await _delete_skill_named(api1, "docx")

    resp = await api1.post(
        "/skills/import-from-url",
        json={"source": "https://www.skills.sh/anthropics/skills/docx"},
        timeout=120.0,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    if body["imported"] == 0:
        err = (body["results"][0] or {}).get("error", "") if body["results"] else ""
        if any(k in err.lower() for k in ("rate limit", "denied", "download", "github")):
            pytest.skip(f"GitHub unavailable: {err}")
        pytest.fail(f"Import failed unexpectedly: {body}")

    assert body["imported"] == 1, body
    skill_id = body["results"][0]["skill_id"]
    try:
        got = await api1.get(f"/skills/{skill_id}")
        assert got.status_code == 200
        data = got.json()
        assert data["name"] == "docx"
        assert data["source_url"] and "github.com/anthropics/skills" in data["source_url"]
    finally:
        await api1.delete(f"/skills/{skill_id}")
