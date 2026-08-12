"""Unit tests for skill_source: parsing remote sources + GitHub tarball extraction."""
import io
import tarfile
from types import SimpleNamespace

import pytest

from app.services import skill_source
from app.services.skill_source import (
    SkillSource,
    SkillSourceError,
    parse_skill_source,
    fetch_skill_from_github,
    _safe_member_path,
    _strip_top_dir,
)

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# parse_skill_source
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "raw,owner,repo,skill,ref",
    [
        # skills.sh URL
        ("https://www.skills.sh/anthropics/skills/docx", "anthropics", "skills", "docx", None),
        # GitHub tree URL (nested skill path) — ref + basename
        (
            "https://github.com/anthropics/skills/tree/main/document-skills/docx",
            "anthropics", "skills", "docx", "main",
        ),
        # GitHub blob URL
        (
            "https://github.com/anthropics/skills/blob/v2/docx",
            "anthropics", "skills", "docx", "v2",
        ),
        # GitHub repo URL (no skill, no ref)
        ("https://github.com/anthropics/skills", "anthropics", "skills", None, None),
        # repo URL with trailing .git
        ("https://github.com/anthropics/skills.git", "anthropics", "skills", None, None),
        # npx install command — repo from URL, skill from --skill flag
        (
            "npx skills add https://github.com/anthropics/skills --skill docx",
            "anthropics", "skills", "docx", None,
        ),
        # npx with --skill=docx form
        (
            "npx skills add https://github.com/anthropics/skills --skill=docx",
            "anthropics", "skills", "docx", None,
        ),
        # bare shorthand owner/repo/skill
        ("anthropics/skills/docx", "anthropics", "skills", "docx", None),
        # bare shorthand owner/repo
        ("anthropics/skills", "anthropics", "skills", None, None),
        # schemeless github host
        (
            "github.com/anthropics/skills/tree/main/docx",
            "anthropics", "skills", "docx", "main",
        ),
        # --skill flag overrides the path-derived skill
        (
            "https://github.com/anthropics/skills/tree/main/pdf --skill docx",
            "anthropics", "skills", "docx", "main",
        ),
    ],
)
def test_parse_skill_source_valid(raw, owner, repo, skill, ref):
    src = parse_skill_source(raw)
    assert src == SkillSource(owner=owner, repo=repo, skill=skill, ref=ref)


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "not a real source",       # no slash, no recognizable host
        "http://evil.com/a/b",     # non-allowlisted host with scheme -> not matched
        "anthropics",              # only one segment
        "https://github.com/anthropics",  # owner only, no repo
    ],
)
def test_parse_skill_source_invalid(raw):
    with pytest.raises(SkillSourceError):
        parse_skill_source(raw)


# ---------------------------------------------------------------------------
# path-safety helpers
# ---------------------------------------------------------------------------

def test_safe_member_path_rejects_traversal_and_absolute():
    assert _safe_member_path("repo-main/docx/SKILL.md") == "repo-main/docx/SKILL.md"
    assert _safe_member_path("/etc/passwd") is None
    assert _safe_member_path("../../etc/passwd") is None
    assert _safe_member_path("repo-main/../../etc/passwd") is None


def test_strip_top_dir():
    assert _strip_top_dir("repo-main/docx/SKILL.md") == "docx/SKILL.md"
    assert _strip_top_dir("repo-main") is None  # top dir entry itself


# ---------------------------------------------------------------------------
# fetch_skill_from_github (mocked GitHub tarball)
# ---------------------------------------------------------------------------

def _skill_md(name: str, desc: str = "A useful skill for doing useful things in tests.") -> bytes:
    return f"---\nname: {name}\ndescription: {desc}\n---\n# {name}\n\nDo the thing.\n".encode()


def _make_tarball(files: dict[str, bytes], top: str = "anthropics-skills-abc123") -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for path, content in files.items():
            info = tarfile.TarInfo(name=f"{top}/{path}")
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
    return buf.getvalue()


class _FakeStreamResp:
    def __init__(self, status_code: int, data: bytes):
        self.status_code = status_code
        self._data = data

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def aiter_bytes(self):
        yield self._data


class _FakeAsyncClient:
    def __init__(self, status_code: int, data: bytes):
        self._status = status_code
        self._data = data

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def stream(self, method, url, headers=None):
        return _FakeStreamResp(self._status, self._data)


def _patch_github(monkeypatch, status_code: int, data: bytes):
    monkeypatch.setattr(skill_source, "get_settings", lambda: SimpleNamespace(github_token=""))
    monkeypatch.setattr(
        skill_source.httpx, "AsyncClient",
        lambda *a, **k: _FakeAsyncClient(status_code, data),
    )


@pytest.mark.asyncio
async def test_fetch_locates_nested_skill_and_strips_prefixes(monkeypatch):
    tarball = _make_tarball({
        "README.md": b"top-level readme",
        "document-skills/docx/SKILL.md": _skill_md("docx"),
        "document-skills/docx/scripts/run.py": b"print('hi')",
        "document-skills/docx/references/notes.md": b"# notes",
        "document-skills/pdf/SKILL.md": _skill_md("pdf"),
    })
    _patch_github(monkeypatch, 200, tarball)

    src = SkillSource(owner="anthropics", repo="skills", skill="docx", ref="main")
    parsed, files, source_url = await fetch_skill_from_github(src)

    assert parsed["name"] == "docx"
    file_map = dict(files)
    # scripts/ and references/ prefixes stripped for flat storage
    assert file_map["run.py"] == b"print('hi')"
    assert file_map["notes.md"] == b"# notes"
    # the other skill's files and the top-level README are not included
    assert "SKILL.md" not in file_map
    assert all("pdf" not in k for k in file_map)
    assert source_url == "https://github.com/anthropics/skills/tree/main/document-skills/docx"


@pytest.mark.asyncio
async def test_fetch_single_skill_no_filter(monkeypatch):
    tarball = _make_tarball({"docx/SKILL.md": _skill_md("docx")})
    _patch_github(monkeypatch, 200, tarball)
    src = SkillSource(owner="o", repo="r", skill=None, ref=None)
    parsed, files, source_url = await fetch_skill_from_github(src)
    assert parsed["name"] == "docx"
    assert source_url == "https://github.com/o/r/tree/HEAD/docx"


@pytest.mark.asyncio
async def test_fetch_multiple_skills_no_filter_errors(monkeypatch):
    tarball = _make_tarball({
        "docx/SKILL.md": _skill_md("docx"),
        "pdf/SKILL.md": _skill_md("pdf"),
    })
    _patch_github(monkeypatch, 200, tarball)
    src = SkillSource(owner="o", repo="r", skill=None, ref=None)
    with pytest.raises(SkillSourceError) as exc:
        await fetch_skill_from_github(src)
    assert "multiple skills" in str(exc.value).lower()
    assert "docx" in str(exc.value) and "pdf" in str(exc.value)


@pytest.mark.asyncio
async def test_fetch_skill_not_found_lists_available(monkeypatch):
    tarball = _make_tarball({"docx/SKILL.md": _skill_md("docx")})
    _patch_github(monkeypatch, 200, tarball)
    src = SkillSource(owner="o", repo="r", skill="nope", ref=None)
    with pytest.raises(SkillSourceError) as exc:
        await fetch_skill_from_github(src)
    assert "not found" in str(exc.value).lower()
    assert "docx" in str(exc.value)


@pytest.mark.asyncio
async def test_fetch_no_skill_md_errors(monkeypatch):
    tarball = _make_tarball({"README.md": b"nothing here"})
    _patch_github(monkeypatch, 200, tarball)
    src = SkillSource(owner="o", repo="r", skill=None, ref=None)
    with pytest.raises(SkillSourceError) as exc:
        await fetch_skill_from_github(src)
    assert "no skill.md" in str(exc.value).lower()


@pytest.mark.asyncio
async def test_fetch_http_404_maps_to_friendly_error(monkeypatch):
    _patch_github(monkeypatch, 404, b"")
    src = SkillSource(owner="o", repo="missing", skill=None, ref=None)
    with pytest.raises(SkillSourceError) as exc:
        await fetch_skill_from_github(src)
    assert "not found" in str(exc.value).lower()


@pytest.mark.asyncio
async def test_fetch_http_403_mentions_token(monkeypatch):
    _patch_github(monkeypatch, 403, b"")
    src = SkillSource(owner="o", repo="r", skill=None, ref=None)
    with pytest.raises(SkillSourceError) as exc:
        await fetch_skill_from_github(src)
    assert "github_token" in str(exc.value).lower()
