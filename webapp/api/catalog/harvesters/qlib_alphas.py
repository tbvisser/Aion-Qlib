"""qlib's two shipped feature sets: Alpha158's 158 columns and Alpha360's 360.

Read out of qlib, never transcribed -- the same rule ``factorlab.indicators``
follows, and for the same reason: the config behind these numbers is exactly the
sort of thing that goes stale, and a hardcoded list stays correct right up until
the day it does not.

**Why Alpha158 appears here as well as in the Indicators collection.** They are
two different questions. The Indicators collection is the 184-expression
*vocabulary* the generator can emit, judged against a store, with ``in_handler``
saying which 158 a strategy would actually train on. This collection is the
handler's feature set as a thing you browse beside GTJA-191 and the curated
library -- "what alphas exist". The 158 rows overlap in content; they do not
overlap in uid, and each says which lens it is.

**Alpha360 is 360 rows of six shapes.** ``CLOSE0``..``CLOSE59`` are lagged
closes over today's close, and the same for open, high, low, vwap and volume.
Listing all 360 rather than six families is deliberate -- the collection is a
database, and ``family='alpha360'`` is one click in the facet rail for anyone who
wants them out of the way.
"""
from __future__ import annotations

import re
from typing import Any, Iterable

from ..harvest import Harvester
from ..schema import Entity

_FIELD = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)")

#: Prose per handler, so a row explains itself in the detail drawer without the
#: reader having to know what a "handler" is.
_ABOUT = {
    "Alpha158": (
        "One of the 158 feature columns the Alpha158 handler computes. It is the "
        "default handler for every model in the builder, so a strategy that does not "
        "override its features trains on exactly this set."
    ),
    "Alpha360": (
        "One of the 360 feature columns the Alpha360 handler computes: the last 60 "
        "days of a price or volume field, each divided by today's value. The handler "
        "hands the model raw normalised history rather than engineered signals."
    ),
}

_FAMILY = {"Alpha158": "alpha158", "Alpha360": "alpha360"}

#: What each Alpha360 name prefix is, for the row summary. The generator emits
#: `<FIELD><lag>`, so the prefix is the field and the digits are the lag.
_A360_PREFIX = re.compile(r"^([A-Z]+)(\d+)$")


def _summary(handler: str, name: str, expression: str) -> str:
    if handler == "Alpha360":
        match = _A360_PREFIX.match(name)
        if match:
            field, lag = match.group(1), int(match.group(2))
            when = "today" if lag == 0 else f"{lag} day{'s' if lag > 1 else ''} ago"
            base = "volume" if field == "VOLUME" else "close"
            return f"{field.title()} {when}, divided by today's {base}."
    return f"{handler} feature column {name}."


def fetch(settings: Any) -> Iterable[Entity]:
    # Imported here rather than at module scope: `contrib.data.handler` drags in
    # the whole DataHandlerLP processor stack, and this package must stay
    # importable on a machine with no store built.
    from ...factorlab.indicators import handler_columns

    out: list[Entity] = []
    for handler in ("Alpha158", "Alpha360"):
        family = _FAMILY[handler]
        for name, expression in handler_columns(handler).items():
            out.append(
                Entity(
                    kind="alpha",
                    source="qlib",
                    local_id=f"{family}.{name}",
                    name=name,
                    title=f"{name} ({handler})",
                    summary=_summary(handler, name, expression),
                    family=family,
                    tags=sorted({handler.lower(), "handler-column"}),
                    expression=expression,
                    payload={
                        "handler": handler,
                        "about": _ABOUT[handler],
                        "fields": sorted(set(_FIELD.findall(expression))),
                        # The claim that matters when reading this beside the
                        # Indicators collection: this expression is one the
                        # handler computes, matched on the expression itself.
                        "in_handler": True,
                    },
                )
            )
    return out


HARVESTER = Harvester(
    name="qlib_alphas",
    kind="alpha",
    source="qlib",
    label="qlib handler columns (Alpha158, Alpha360)",
    fetch=fetch,
)
