"""The Alpha158 expression vocabulary: 184 indicators, 158 of them in the handler.

``factorlab.indicators.build_library`` already does the hard part -- it asks
qlib for each family separately so the family is known by construction rather
than parsed off a name prefix, which is the thing that gets ``LOW`` wrong (that
key emits ``MIN5``..``MIN60``).

Two flags are carried through because losing either would make a row lie:

``in_handler`` -- matched on the *expression*, not the name, so it means "the
handler computes exactly this" rather than "a column with this name exists".
184 is the vocabulary; 158 is what a strategy trains on.

``constant`` -- ``CLOSE0`` is ``$close/$close`` and ``VOLUME0`` is
``$volume/($volume+1e-12)``. They have zero variance and an IC of NaN, and that
is worth being told before you spend a minute measuring one.

Store runnability is deliberately not indexed. Whether ``VWAP0`` can run here
depends on which store is mounted, and this index is machine-independent by
construction -- the Indicators sub-tab asks ``GET /api/indicators`` for that
judgement, exactly as it does today.
"""
from __future__ import annotations

from typing import Any, Iterable

from ..harvest import Harvester
from ..schema import Entity

_FAMILY_LABELS = {
    "kbar": "Candle",
    "price": "Price lags",
    "volume": "Volume lags",
    "rolling": "Rolling",
}


def fetch(settings: Any) -> Iterable[Entity]:
    from ...factorlab.indicators import build_library

    out: list[Entity] = []
    for indicator in build_library():
        tags = [indicator.family, indicator.group.lower()]
        if indicator.in_handler:
            tags.append("alpha158")
        if indicator.constant:
            tags.append("constant")
        if indicator.window is not None:
            tags.append(f"w{indicator.window}")

        out.append(
            Entity(
                kind="indicator",
                source="qlib",
                local_id=indicator.name,
                name=indicator.name,
                title=indicator.name,
                summary=indicator.description,
                family=indicator.family,
                tags=sorted(set(tags)),
                expression=indicator.expression,
                payload={
                    "family_label": _FAMILY_LABELS.get(indicator.family, indicator.family),
                    "group": indicator.group,
                    "window": indicator.window,
                    "fields": list(indicator.fields),
                    "in_handler": indicator.in_handler,
                    "constant": indicator.constant,
                },
            )
        )
    return out


HARVESTER = Harvester(
    name="indicators",
    kind="indicator",
    source="qlib",
    label="Alpha158 indicator vocabulary",
    fetch=fetch,
)
