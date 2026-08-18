"""Skills that live in this repo as files: 3, and nothing read them until now.

Two are `SKILL.md` files under `rag/.agents/skills/` -- worktree provisioning
and teardown, dev-environment automation rather than product capability. The
third is `rag/backend/skills/skill-creator.yaml`, the seed skill
`scripts/sync_skills.py` upserts into Supabase as a global row.

They are indexed together and marked with what they are, because a roster that
lists `worktree-dev-env` beside `factor-research` without saying which is a dev
chore is a roster that misleads. `family` carries the distinction and `scope`
records where each one actually applies.

This provider is a file scan with no network, so it degrades only if the repo is
unreadable. A file that fails to parse is skipped with its reason kept -- one
malformed frontmatter should cost one row, not the collection.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Iterable

import yaml

from ...catalog.schema import Entity
from ..aggregate import Provider

logger = logging.getLogger(__name__)

_FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.S)

#: Cap on a file we will read whole. These are documentation, not data; the
#: seed skill is the biggest at ~10 KB.
_MAX_BYTES = 200_000


def _repo_paths(settings: Any) -> list[tuple[Path, str, str]]:
    """(path, family, scope) for every file-based skill in the repo."""
    root = settings.repo_root
    found: list[tuple[Path, str, str]] = []

    for path in sorted((root / "rag" / ".agents" / "skills").glob("*/SKILL.md")):
        found.append((path, "dev workflow", "coding agents working in rag/"))

    for path in sorted((root / "rag" / "backend" / "skills").glob("*.yaml")):
        found.append((path, "seed skill", "seeded into Supabase as a global skill"))

    return found


def _parse(path: Path) -> dict[str, Any] | None:
    """Name, description and body, whichever of the two shapes the file is."""
    if path.stat().st_size > _MAX_BYTES:
        raise ValueError(f"{path.name}: {path.stat().st_size}B exceeds {_MAX_BYTES}B cap")

    text = path.read_text(encoding="utf-8")

    if path.suffix == ".yaml":
        raw = yaml.safe_load(text)
        if not isinstance(raw, dict):
            raise ValueError(f"{path.name}: expected a mapping")
        return {
            "name": raw.get("name") or path.stem,
            "description": (raw.get("description") or "").strip(),
            "body": (raw.get("instructions") or "").strip(),
        }

    match = _FRONTMATTER.match(text)
    if not match:
        raise ValueError(f"{path.name}: no YAML frontmatter")
    meta = yaml.safe_load(match.group(1)) or {}
    if not isinstance(meta, dict):
        raise ValueError(f"{path.name}: frontmatter is not a mapping")
    return {
        # The directory name is the skill's identity when frontmatter omits it,
        # which is the convention the RAG loader already follows.
        "name": meta.get("name") or path.parent.name,
        "description": (meta.get("description") or "").strip(),
        "body": match.group(2).strip(),
    }


def fetch(settings: Any) -> Iterable[Entity]:
    out: list[Entity] = []
    for path, family, scope in _repo_paths(settings):
        try:
            parsed = _parse(path)
        except Exception as exc:  # noqa: BLE001 - one bad file costs one row
            logger.warning("repo skill %s could not be read: %s", path, exc)
            continue
        if parsed is None:
            continue

        out.append(
            Entity(
                kind="skill",
                source="aion",
                local_id=parsed["name"],
                name=parsed["name"],
                title=parsed["name"],
                summary=parsed["description"].split("\n", 1)[0].strip(),
                family=family,
                tags=[],
                payload={
                    "description": parsed["description"],
                    # Unlike the sidecar's, these bodies are readable -- the
                    # files are right here. The detail rail renders them.
                    "body": parsed["body"],
                    "body_available": True,
                    "scope": scope,
                    "path": str(path.relative_to(settings.repo_root)).replace("\\", "/"),
                },
            )
        )
    return out


PROVIDER = Provider(
    name="repo_skills",
    kind="skill",
    source="aion",
    label="Repo file skills",
    fetch=fetch,
)
