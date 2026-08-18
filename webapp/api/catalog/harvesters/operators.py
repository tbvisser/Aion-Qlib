"""The expression vocabulary itself: 44 offered operators and the 6 refused ones.

The refused six are indexed alongside the offered ones, not dropped. "Why can't
I use ``Sum(x, 0)``?" is a question the catalog should be able to answer, and a
missing row answers it with silence -- so a refused operator carries
``payload.refused`` with the reason, and its ``family`` is ``refused`` so the
facet rail separates them at a glance.

``registry_payload`` is introspected from ``qlib.data.ops.OpsList`` rather than
transcribed, so a qlib version that adds an operator shows up here without a
code change.
"""
from __future__ import annotations

from typing import Any, Iterable

from ..harvest import Harvester
from ..schema import Entity


def fetch(settings: Any) -> Iterable[Entity]:
    from ...factorlab.operators import registry_payload

    payload = registry_payload()
    out: list[Entity] = []

    for name, op in payload["operators"].items():
        category = op.get("category") or "other"
        out.append(
            Entity(
                kind="operator",
                source="qlib",
                local_id=name,
                name=name,
                title=f"{name}()",
                summary=op.get("summary"),
                family=category,
                tags=sorted({category, "offered"}),
                payload={**op, "refused": None},
            )
        )

    for op in payload["refused"]:
        out.append(
            Entity(
                kind="operator",
                source="qlib",
                local_id=op["name"],
                name=op["name"],
                title=f"{op['name']}()",
                summary=op.get("summary"),
                family="refused",
                tags=["refused"],
                payload={**op, "refused": op.get("reason")},
            )
        )

    return out


HARVESTER = Harvester(
    name="operators",
    kind="operator",
    source="qlib",
    label="Expression operators",
    fetch=fetch,
)
