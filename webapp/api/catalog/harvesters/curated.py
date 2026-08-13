"""The curated factor library: 121 named, documented expressions across 7 families.

Loaded through ``factorlab.curated.all_factors`` rather than by re-reading the
YAML, so the index inherits the four load-time checks that make a curated factor
safe to offer -- it compiles, it has no lookahead defect, its name is unique, and
it does not shadow a handler column. A file that fails any of them raises here,
and the orchestrator keeps the collection's previous rows rather than serving a
library that quietly shrank.

``back_days`` is carried into the payload because it is the number that
distinguishes two factors nothing else does: qlib's rolling uses
``min_periods=1``, so ``Std($change, 60)`` returns a confident value from two
observations while ``Ref($close, 252)`` is honestly NaN for a year, and both can
sit in the same feature set.

Provenance is a real field here. The ``vibe-curated`` family's caveats carry the
upstream id they were adapted from ("Adapted from Vibe-Trading (MIT), id
academic_carhart_mom"), which is the only machine-readable link between this
library and the zoo -- so it is parsed out into ``payload.derived_from`` and
becomes a resolvable uid rather than a sentence.
"""
from __future__ import annotations

import re
from typing import Any, Iterable

from ..harvest import Harvester
from ..schema import Entity

#: "Adapted from Vibe-Trading (MIT), id academic_carhart_mom" -> the alpha id.
_UPSTREAM_ID = re.compile(r"\bid\s+([a-z][a-z0-9]+_[a-z0-9_]+)")


def fetch(settings: Any) -> Iterable[Entity]:
    from ...factorlab.curated import all_factors, back_days, fields_of, load_families

    labels = {family.family: family.label for family in load_families()}

    out: list[Entity] = []
    for family, factor in all_factors():
        payload: dict[str, Any] = {
            "family_label": labels.get(family.family, family.family),
            "fields": fields_of(factor.expression),
            "window": factor.window,
            "back_days": back_days(factor.expression),
        }
        if factor.caveat:
            payload["caveat"] = factor.caveat
            match = _UPSTREAM_ID.search(factor.caveat)
            if match:
                # Resolvable rather than prose: this is a uid the detail drawer
                # can link straight to the zoo entry it was adapted from.
                payload["derived_from"] = f"alpha:vibe:{match.group(1)}"

        out.append(
            Entity(
                kind="alpha",
                source="curated",
                local_id=factor.name,
                name=factor.name,
                title=factor.name,
                summary=factor.summary,
                family=family.family,
                tags=list(factor.tags),
                expression=factor.expression,
                payload=payload,
            )
        )
    return out


HARVESTER = Harvester(
    name="curated",
    kind="alpha",
    source="curated",
    label="Curated factor library",
    fetch=fetch,
)
