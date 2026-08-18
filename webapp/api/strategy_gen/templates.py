"""Curated strategies to start from.

A template is a **partial draft**, never a finished spec. That distinction is the
whole design: a template that stated every field would hard-code dates that go
stale, and it would produce zero `assumed` rows -- throwing away the one honest
artifact this pipeline makes. So each template states only the handful of fields
it is actually about, and `lower_draft` fills the rest and says so.

Templates live in the repo rather than in `strategies_dir`, because `webapp/data/`
is gitignored: a seeded template would be per-machine, editable, deletable, and
would appear in `GET /api/strategies` beside the user's own work. `StrategyStore`
also skips files it cannot parse, so a broken seeded template would simply
vanish -- the exact failure mode a shipped promise must not have.

Honesty is structural here, not conventional. `extra="forbid"` makes a stray
`expected_return:` key a load error, and a template must declare what it is *bad*
at before it can load at all.
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal, get_args

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..keycards.adapter import keycard_to_strategy
from ..keycards.repo import KeycardRepo
from .draft import DraftError, StrategyDraft, lower_draft

TEMPLATE_DIR = Path(__file__).parent / "templates"

#: Gallery order. Baselines first, then the axes you would vary one at a time.
#:
#: One list, not two. These were a hand-written tuple beside a hand-written
#: Literal, and the two ways of disagreeing both fail badly: a family in the
#: tuple but not the Literal rejects every template that uses it at load, and a
#: family in the Literal but not the tuple raises `ValueError: tuple.index(x)`
#: inside the sort key below -- taking `GET /templates`, `GET /templates/{id}`
#: and the chat tool down together.
Family = Literal[
    "baseline", "model-comparison", "factors", "shape", "cost", "universe", "horizon",
]
FAMILIES: tuple[str, ...] = get_args(Family)

#: What each family is for, in the gallery's own words.
FAMILY_LABELS: dict[str, str] = {
    "baseline": "Baselines",
    "model-comparison": "Model comparison",
    "factors": "Custom factor sets",
    "shape": "Portfolio shape",
    "cost": "Trading costs",
    "universe": "Universes & calendars",
    "horizon": "Training horizon",
}


class StrategyTemplate(BaseModel):
    """One curated starting point, as it is written on disk."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")
    title: str = Field(..., min_length=1, max_length=80)
    family: Family
    tags: list[str] = Field(default_factory=list)
    #: Why this shape, in plain language. Never a performance claim.
    rationale: str = Field(..., min_length=1)
    good_for: list[str] = Field(..., min_length=1)
    bad_for: list[str] = Field(..., min_length=1)
    draft: StrategyDraft

    @field_validator("good_for", "bad_for")
    @classmethod
    def _no_empty_lines(cls, v: list[str]) -> list[str]:
        if any(not line.strip() for line in v):
            raise ValueError("entries must not be blank")
        return v


class TemplateError(ValueError):
    """A template file that cannot be loaded. Never silently skipped."""


def load_templates() -> list[StrategyTemplate]:
    """Every shipped template, in gallery order.

    Deliberately not cached and deliberately not fault-tolerant: a template that
    fails to parse raises, because a curated set that quietly shrinks is worse
    than one that fails loudly at startup.
    """
    out: list[StrategyTemplate] = []
    for path in sorted(TEMPLATE_DIR.glob("*.yaml")):
        try:
            raw = yaml.safe_load(path.read_text())
        except yaml.YAMLError as exc:
            raise TemplateError(f"{path.name}: {exc}") from exc
        if not isinstance(raw, dict):
            raise TemplateError(f"{path.name}: expected a mapping")
        try:
            out.append(StrategyTemplate.model_validate(raw))
        except Exception as exc:  # noqa: BLE001 — pydantic detail is the message
            raise TemplateError(f"{path.name}: {exc}") from exc

    ids = [t.id for t in out]
    duplicates = {i for i in ids if ids.count(i) > 1}
    if duplicates:
        raise TemplateError(f"duplicate template ids: {', '.join(sorted(duplicates))}")

    return sorted(out, key=lambda t: (FAMILIES.index(t.family), t.title))


def get_template(template_id: str) -> StrategyTemplate | None:
    return next((t for t in load_templates() if t.id == template_id), None)


def materialise(template: StrategyTemplate) -> dict:
    """Template -> the same shape `POST /strategies/from-draft` returns.

    A template that cannot be lowered on this machine is reported as
    ``runnable: false`` with the reasons attached, never omitted. The same
    argument as `available_models()`: say why it is unavailable rather than
    quietly offering a shorter list.
    """
    meta = template.model_dump(exclude={"draft"})
    try:
        lowered = lower_draft(template.draft)
    except DraftError as exc:
        return {**meta, "runnable": False, "blocked_by": exc.errors}

    # `lower_draft` does not check feature expressions -- it resolves names,
    # dates and stores. Without this a template in the `factors` family whose
    # expression does not compile reports `runnable: true` here and then dies at
    # POST /runs, which is the one place a curated promise must not break.
    problems = lowered.spec.validate_features()
    if problems:
        return {
            **meta,
            "runnable": False,
            "blocked_by": [{"code": "bad_feature", "message": p, "path": "features"}
                           for p in problems],
        }

    return {
        **meta,
        "runnable": True,
        "blocked_by": [],
        "spec": lowered.spec.model_dump(),
        "assumed": [a.model_dump() for a in lowered.assumed],
        "warnings": lowered.warnings,
    }


def catalog() -> list[dict]:
    """Every template, lowered against this machine."""
    return [materialise(t) for t in load_templates()]


def load_templates_from_keycards(repo: KeycardRepo) -> list[dict]:
    """Keycard-stored templates formatted like :func:`catalog`.

    This is the migration target for curated templates: once they live in
    ``aion.keycards`` as ``is_template=true`` rows, the gallery can read them
    from the same store as user keycards instead of from disk.
    """
    out: list[dict] = []
    for keycard in repo.list_templates():
        spec = keycard_to_strategy(keycard)
        entry: dict = {
            "id": keycard.id,
            "title": keycard.name,
            "family": keycard.template_family,
            "tags": keycard.tags,
            "rationale": keycard.description,
            "good_for": [],
            "bad_for": [],
            "runnable": spec is not None,
            "blocked_by": [],
        }
        if spec is not None:
            entry["spec"] = spec.model_dump()
            entry["assumed"] = []
            entry["warnings"] = []
        out.append(entry)
    return out
