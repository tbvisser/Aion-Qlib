"""Vibe's skill library: 89 scenario guides the agent loads on demand.

Each is a `SKILL.md` -- a methodology the agent reads when a question calls for
it, from `chanlun` and `elliott-wave` through `factor-research` and
`options-payoff` to data-source guides like `tushare` and `ccxt`.

**Two fields, and no category.** The sidecar's own handler projects to
`{name, description}` before serving, dropping the `category:` frontmatter that
groups these into data-source / strategy / analysis / asset-class / crypto /
flow / tool upstream. That is an upstream projection, not our proxy's allowlist,
so no change on this side recovers it -- the collection facets on source and
leans on search instead.

**Bodies are not reachable either.** There is no `/skills/{name}` route, and the
`load_skill` MCP tool that would return one is deliberately outside the proxy's
allowlist. A skill row is its name and its one-line description.
"""
from __future__ import annotations

from typing import Any, Iterable

from ...catalog.schema import Entity
from ..aggregate import Provider
from . import _vibe


def _unquote(text: str) -> str:
    """Strip the quotes 17 of the 89 descriptions arrive wrapped in.

    The sidecar parses SKILL.md frontmatter with a hand-rolled line splitter
    rather than a YAML parser, so `description: "..."` keeps its quotes through
    to the API. Stripping them is a display fix for an upstream wart -- balanced
    pairs only, so a description that legitimately opens with a quote is left
    alone rather than losing a character.
    """
    text = text.strip()
    for quote in ('"', "'"):
        if len(text) > 1 and text.startswith(quote) and text.endswith(quote):
            return text[1:-1].strip()
    return text


def fetch(settings: Any) -> Iterable[Entity]:
    skills = _vibe.get_json(settings, "skills")
    if not isinstance(skills, list):
        raise RuntimeError(f"vibe /skills returned {type(skills).__name__}, expected a list")

    out: list[Entity] = []
    for skill in skills:
        description = _unquote(skill.get("description") or "")
        out.append(
            Entity(
                kind="skill",
                source="vibe",
                local_id=skill["name"],
                name=skill["name"],
                title=skill["name"],
                summary=description,
                # Every vibe skill lands in one family because the sidecar does
                # not serve the category. Stated rather than left null so the
                # facet rail shows one honest bucket instead of 89 blanks.
                family="sidecar",
                tags=[],
                payload={
                    "description": description,
                    "loaded_by": "load_skill",
                    # Read by the detail rail, for the same reason the swarm
                    # provider carries `members_available`.
                    "body_available": False,
                    "category_available": False,
                },
            )
        )
    return out


PROVIDER = Provider(
    name="vibe_skills",
    kind="skill",
    source="vibe",
    label="Vibe skill library",
    fetch=fetch,
    remote=True,
)
