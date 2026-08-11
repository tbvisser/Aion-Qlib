"""Resolve a remote skill source (skills.sh / GitHub) and fetch it from GitHub.

skills.sh distributes skills as folders inside GitHub repositories. Rather than
running its Node ``npx skills`` CLI, we parse whatever the user pastes down to
``owner / repo / skill / ref`` and pull the repo tarball straight from GitHub,
then hand the matching skill folder to the existing SKILL.md ingestion pipeline.

Accepted source strings (see ``parse_skill_source``):
  - skills.sh URL           https://www.skills.sh/anthropics/skills/docx
  - GitHub tree/blob URL    https://github.com/anthropics/skills/tree/main/document-skills/docx
  - GitHub repo URL         https://github.com/anthropics/skills
  - npx install command     npx skills add https://github.com/anthropics/skills --skill docx
  - shorthand               anthropics/skills/docx   (or  anthropics/skills)
"""
import asyncio
import gzip
import io
import posixpath
import re
import tarfile
from dataclasses import dataclass

import httpx

from app.config import get_settings
from app.services.skill_format import parse_skill_md, SkillFormatError


class SkillSourceError(Exception):
    """Raised when a remote skill source cannot be parsed or fetched."""
    pass


# owner / repo / skill names: GitHub + skills.sh segment charset.
_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
# git refs may contain slashes (e.g. "feature/foo").
_REF_RE = re.compile(r"^[A-Za-z0-9._/-]+$")

# Size guards (mirror the .zip importer's 50 MB / 10 MB caps).
_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024        # compressed archive
_MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024   # total extracted (tar-bomb guard)
_MAX_MEMBERS = 2000                           # member-count guard
_MAX_FILE_BYTES = 10 * 1024 * 1024            # per attached file
_GUNZIP_CHUNK = 1024 * 1024                   # decompression read size


@dataclass
class SkillSource:
    """A parsed reference to a skill living in a GitHub repo."""
    owner: str
    repo: str
    skill: str | None = None
    ref: str | None = None


# ----------------------------------------------------------------------------
# Parsing
# ----------------------------------------------------------------------------

def parse_skill_source(raw: str) -> SkillSource:
    """Parse a user-supplied source string into a :class:`SkillSource`.

    Raises :class:`SkillSourceError` for anything it can't recognize.
    """
    if not raw or not raw.strip():
        raise SkillSourceError("Source is empty")
    text = raw.strip()

    # An explicit "--skill <name>" flag (npx form) overrides any path-derived skill.
    skill_flag = None
    m = re.search(r"--skill[=\s]+([A-Za-z0-9._-]+)", text)
    if m:
        skill_flag = m.group(1)

    src: SkillSource | None = None

    # 1. A github.com URL/host anywhere in the string (covers the npx command too).
    m = re.search(r"(?:https?://)?(?:www\.)?github\.com/([^\s'\"]+)", text)
    if m:
        src = _parse_github_path(m.group(1))
    else:
        # 2. A skills.sh URL/host.
        m = re.search(r"(?:https?://)?(?:www\.)?skills\.sh/([^\s'\"]+)", text)
        if m:
            src = _parse_registry_path(m.group(1))
        # 3. Bare shorthand: a single "owner/repo[/skill]" token, no scheme/spaces.
        elif " " not in text and "://" not in text and "/" in text:
            src = _parse_registry_path(text)

    if src is None:
        raise SkillSourceError(
            "Could not recognize a GitHub or skills.sh skill source. Paste a "
            "skills.sh URL, a GitHub URL, the npx command, or owner/repo/skill."
        )

    if skill_flag:
        _validate_name(skill_flag, "skill")
        src.skill = skill_flag
    return src


def _parse_github_path(path: str) -> SkillSource:
    """Parse the path portion of a github.com URL."""
    segs = _clean_segments(path)
    if len(segs) < 2:
        raise SkillSourceError("GitHub URL must include an owner and repository")
    owner, repo = segs[0], _strip_git(segs[1])
    _validate_name(owner, "owner")
    _validate_name(repo, "repository")

    skill: str | None = None
    ref: str | None = None
    # owner/repo/(tree|blob)/<ref>/<subpath...>
    if len(segs) >= 3 and segs[2] in ("tree", "blob"):
        if len(segs) >= 4:
            ref = segs[3]
        subpath = segs[4:]
        if subpath:
            skill = subpath[-1]
            _validate_name(skill, "skill")
    return SkillSource(owner=owner, repo=repo, skill=skill, ref=ref)


def _parse_registry_path(path: str) -> SkillSource:
    """Parse a skills.sh path or bare ``owner/repo[/skill]`` shorthand."""
    segs = _clean_segments(path)
    if len(segs) < 2:
        raise SkillSourceError("Source must be owner/repo or owner/repo/skill")
    owner, repo = segs[0], _strip_git(segs[1])
    _validate_name(owner, "owner")
    _validate_name(repo, "repository")
    skill = segs[2] if len(segs) >= 3 else None
    if skill is not None:
        _validate_name(skill, "skill")
    return SkillSource(owner=owner, repo=repo, skill=skill, ref=None)


def _clean_segments(path: str) -> list[str]:
    path = path.split("?", 1)[0].split("#", 1)[0]
    return [s for s in path.split("/") if s]


def _strip_git(repo: str) -> str:
    return repo[:-4] if repo.endswith(".git") else repo


def _validate_name(value: str, label: str) -> None:
    if not _NAME_RE.match(value):
        raise SkillSourceError(f"Invalid {label} name: {value!r}")


# ----------------------------------------------------------------------------
# Fetching
# ----------------------------------------------------------------------------

async def fetch_skill_from_github(src: SkillSource) -> tuple[dict, list[tuple[str, bytes]], str]:
    """Download ``src`` from GitHub and locate the matching skill folder.

    Returns ``(parsed_skill_md, files, canonical_source_url)`` where ``files`` is
    a list of ``(relative_path, bytes)`` ready for the ingestion pipeline.

    We always construct the outbound URL ourselves from the validated
    owner/repo/ref — the user never controls the request host — so this is not an
    SSRF vector. httpx follows GitHub's redirect to codeload.github.com.
    """
    settings = get_settings()
    url = f"https://api.github.com/repos/{src.owner}/{src.repo}/tarball"
    if src.ref:
        if not _REF_RE.match(src.ref):
            raise SkillSourceError(f"Invalid git ref: {src.ref!r}")
        url += f"/{src.ref}"

    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "agentic-rag-app",
    }
    token = (settings.github_token or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
            async with client.stream("GET", url, headers=headers) as resp:
                if resp.status_code == 404:
                    raise SkillSourceError(
                        f"Repository or ref not found: {src.owner}/{src.repo}"
                    )
                if resp.status_code in (401, 403):
                    raise SkillSourceError(
                        "GitHub denied the request (rate limit or private repo). "
                        "Set GITHUB_TOKEN to raise the limit or access private repos."
                    )
                if resp.status_code >= 400:
                    raise SkillSourceError(f"GitHub returned status {resp.status_code}")

                total = 0
                chunks: list[bytes] = []
                async for chunk in resp.aiter_bytes():
                    total += len(chunk)
                    if total > _MAX_DOWNLOAD_BYTES:
                        raise SkillSourceError("Repository archive exceeds the 50 MB limit")
                    chunks.append(chunk)
                data = b"".join(chunks)
    except httpx.HTTPError as e:
        raise SkillSourceError(f"Failed to download from GitHub: {e}")

    # gzip decompression + tar parsing are CPU-bound: never run them on the
    # event loop, or one large/bomb archive freezes every concurrent request.
    return await asyncio.to_thread(_extract_skill_from_tar, data, src)


def _gunzip_bounded(data: bytes, limit: int) -> bytes:
    """Decompress a gzip stream, aborting once output exceeds ``limit`` bytes.

    Guards against gzip/tar bombs: the compressed-download cap says nothing about
    decompressed size, so we inflate in chunks and stop the moment we cross the
    limit, rather than letting tarfile inflate the whole stream (or trusting
    per-member header sizes after the fact).
    """
    out = bytearray()
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(data), mode="rb") as gz:
            while True:
                chunk = gz.read(_GUNZIP_CHUNK)
                if not chunk:
                    break
                out.extend(chunk)
                if len(out) > limit:
                    raise SkillSourceError("Archive is too large when decompressed")
    except SkillSourceError:
        raise
    except OSError as e:
        raise SkillSourceError(f"Invalid archive: {e}")
    return bytes(out)


def _extract_skill_from_tar(
    data: bytes, src: SkillSource
) -> tuple[dict, list[tuple[str, bytes]], str]:
    """Extract the matching skill folder from a GitHub repo tarball.

    Runs off the event loop (callers use ``asyncio.to_thread``): gzip
    decompression and tar parsing are CPU-bound and would otherwise block every
    other request on the single worker.
    """
    # Bound the *decompressed* size up front. The 50 MB download cap says nothing
    # about expanded size, and tarfile.getmembers() would otherwise inflate the
    # whole gzip stream (a gzip bomb) just to enumerate members.
    decompressed = _gunzip_bounded(data, _MAX_DECOMPRESSED_BYTES)
    try:
        tar = tarfile.open(fileobj=io.BytesIO(decompressed), mode="r:")
    except tarfile.TarError as e:
        raise SkillSourceError(f"Invalid archive: {e}")

    with tar:
        members = tar.getmembers()
        if len(members) > _MAX_MEMBERS:
            raise SkillSourceError("Archive contains too many files")

        # GitHub tarballs nest everything under one top dir ("owner-repo-<sha>/").
        # Build a repo-relative map of regular files only.
        file_members: dict[str, tarfile.TarInfo] = {}
        total_size = 0
        for m in members:
            if not m.isfile():
                continue  # skip dirs, symlinks, hardlinks, devices
            norm = _safe_member_path(m.name)
            if norm is None:
                continue  # path traversal / absolute — skip
            rel = _strip_top_dir(norm)
            if not rel:
                continue
            total_size += m.size
            if total_size > _MAX_DECOMPRESSED_BYTES:
                raise SkillSourceError("Archive is too large when decompressed")
            file_members[rel] = m

        skill_md_paths = [
            p for p in file_members if p == "SKILL.md" or p.endswith("/SKILL.md")
        ]
        if not skill_md_paths:
            raise SkillSourceError("No SKILL.md found in the repository")

        # Parse every SKILL.md so we can match by name or folder basename.
        candidates: list[tuple[str, str, dict]] = []  # (skill_dir, basename, parsed)
        for p in skill_md_paths:
            skill_dir = p[: -len("SKILL.md")].rstrip("/")  # "" when at repo root
            extracted = tar.extractfile(file_members[p])
            if extracted is None:
                continue
            try:
                content = extracted.read().decode("utf-8")
                parsed = parse_skill_md(content)
            except (SkillFormatError, UnicodeDecodeError):
                continue
            basename = skill_dir.rsplit("/", 1)[-1] if skill_dir else parsed["name"]
            candidates.append((skill_dir, basename, parsed))

        if not candidates:
            raise SkillSourceError("No valid SKILL.md found in the repository")

        skill_dir, parsed = _resolve_candidate(candidates, src.skill)

        # Collect sibling files under the chosen skill dir (everything but SKILL.md),
        # stripping the standard scripts/|references/|assets/ prefixes for flat
        # storage — matching the .zip importer.
        prefix = f"{skill_dir}/" if skill_dir else ""
        skill_md_rel = f"{prefix}SKILL.md"
        files: list[tuple[str, bytes]] = []
        for rel, m in file_members.items():
            if not rel.startswith(prefix) or rel == skill_md_rel:
                continue
            relative = rel[len(prefix):]
            for sp in ("scripts/", "references/", "assets/"):
                if relative.startswith(sp):
                    relative = relative[len(sp):]
                    break
            if not relative or m.size > _MAX_FILE_BYTES:
                continue
            extracted = tar.extractfile(m)
            if extracted is None:
                continue
            content = extracted.read()
            if content:
                files.append((relative, content))

    ref = src.ref or "HEAD"
    if skill_dir:
        source_url = f"https://github.com/{src.owner}/{src.repo}/tree/{ref}/{skill_dir}"
    else:
        source_url = f"https://github.com/{src.owner}/{src.repo}"
    return parsed, files, source_url


def _resolve_candidate(
    candidates: list[tuple[str, str, dict]], requested: str | None
) -> tuple[str, dict]:
    """Pick the target skill from the parsed SKILL.md candidates."""
    if requested:
        for skill_dir, basename, parsed in candidates:
            if parsed["name"] == requested or basename == requested:
                return skill_dir, parsed
        available = ", ".join(sorted({p["name"] for _, _, p in candidates}))
        raise SkillSourceError(f"Skill '{requested}' not found. Available: {available}")

    if len(candidates) == 1:
        skill_dir, _, parsed = candidates[0]
        return skill_dir, parsed

    available = ", ".join(sorted({p["name"] for _, _, p in candidates}))
    raise SkillSourceError(
        f"Repository has multiple skills; specify one of: {available}"
    )


def _safe_member_path(name: str) -> str | None:
    norm = posixpath.normpath(name)
    if norm.startswith("/") or norm == ".." or norm.startswith("../") or "/../" in norm:
        return None
    return norm


def _strip_top_dir(path: str) -> str | None:
    idx = path.find("/")
    if idx < 0:
        return None  # the top-level archive dir entry itself
    return path[idx + 1:]
