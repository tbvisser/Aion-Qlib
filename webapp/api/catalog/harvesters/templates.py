"""Strategy templates: 31 curated starting points, shipped in the repo.

A template is a **partial draft**, never a finished spec -- it states only the
handful of fields it is actually about and ``lower_draft`` fills the rest. So the
indexed row describes the draft, not a strategy: ``family`` is the gallery family
(baseline, cost, universe, ...), and the fields the draft leaves unstated are
simply absent from the payload rather than filled with a default that would read
as a claim the template never made.

``bad_for`` is carried into the payload beside ``good_for``. A template cannot
load without declaring what it is bad at, and dropping that half on the way into
the index would turn an honest artifact into a sales pitch.

``load_templates`` is deliberately not fault-tolerant upstream -- a template that
fails to parse raises -- and that is inherited: the collection keeps its previous
rows rather than quietly shrinking.
"""
from __future__ import annotations

from typing import Any, Iterable

from ..harvest import Harvester
from ..schema import Entity


def fetch(settings: Any) -> Iterable[Entity]:
    from ...strategy_gen.templates import FAMILY_LABELS, load_templates

    out: list[Entity] = []
    for template in load_templates():
        draft = template.draft.model_dump(exclude_none=True)
        out.append(
            Entity(
                kind="template",
                source="aion",
                local_id=template.id,
                name=template.id,
                title=template.title,
                summary=template.rationale,
                family=template.family,
                tags=list(template.tags),
                payload={
                    "family_label": FAMILY_LABELS.get(template.family, template.family),
                    "good_for": list(template.good_for),
                    "bad_for": list(template.bad_for),
                    "draft": draft,
                    # Lifted to the top of the payload so `derive_links` finds it
                    # in the same place it looks for a strategy's.
                    "features": draft.get("features") or [],
                },
            )
        )
    return out


HARVESTER = Harvester(
    name="templates",
    kind="template",
    source="aion",
    label="Strategy templates",
    fetch=fetch,
)
