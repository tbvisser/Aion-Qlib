"""The Vibe-Trading alpha zoo: 462 cross-sectional factors, over the network.

Five zoos -- Kakushadze's 101 formulaic alphas, Guotai Junan's 191, Qlib's 158
(154 of which load), 12 academic factors and 4 fundamental ones. Until now the
only way to see them was the Alpha Zoo page, which asks the sidecar on every
render; indexing them is what puts them in the same search box as the curated
library and qlib's own handler columns.

**A zoo alpha has no qlib expression.** These are pandas functions on a price
panel, not `Ref($close,20)/$close` -- they compute on the sidecar's own bench and
cannot be measured by `POST /api/factors/evaluate`. So `expression` is left null
rather than filled with the LaTeX, which would make the row look measurable
here. The detail rail keys off exactly that: no expression, no Evaluate button.

**One request, not 463.** The list endpoint returns every alpha's id, zoo,
nickname, themes and universes in a single call; the per-alpha endpoint adds
`formula_latex`, `notes` and the module's source, and fetching that for all 462
would turn a three-second reindex into a minute of round-trips. The detail rail
fetches it lazily for the one alpha you opened. The cost is that FTS searches
nicknames and themes but not formulae -- worth it, and stated here so the next
person does not conclude the search is broken.

This is the only harvester that crosses the network, so it is the one that makes
`include_remote=False` and the degraded-source path worth having: with the
sidecar down, a reindex still rebuilds everything else and the zoo keeps the rows
it had.

**No mojibake repair here, deliberately.** The Alpha Zoo page this replaces
carried a `normalizeMojibake` that rewrote `a-euro-"` back to an em dash, because
the *MCP* path (the `alpha_zoo` tool -> text content -> JSON) round-trips UTF-8
through Windows-1252 somewhere and mangles every nickname containing one. This
harvester takes the REST route instead, where httpx decodes by the response's own
charset and the text arrives intact -- verified across all 462 rows. If anyone
ever points this at the MCP tool, the repair has to come back with it.
"""
from __future__ import annotations

import logging
from typing import Any, Iterable

import httpx

from ..harvest import Harvester
from ..schema import Entity

logger = logging.getLogger(__name__)

#: Generous: the sidecar builds its registry by AST-scanning ~460 modules on the
#: first call, which is slow exactly once per sidecar process.
_TIMEOUT = httpx.Timeout(60.0, connect=5.0)

#: The registry caps `limit` at 1000 and there are 462 alphas. Asking for the
#: cap rather than paging keeps this one request; `truncated` is checked below
#: so a zoo that outgrows the cap fails loudly instead of silently indexing 1000.
_LIMIT = 1000

#: What each zoo is, for the row summary and the family label. Keys are the
#: sidecar's own `zoo` ids.
_ZOO_LABELS = {
    "alpha101": "Kakushadze 101",
    "gtja191": "Guotai Junan 191",
    "qlib158": "Qlib 158",
    "academic": "Academic factors",
    "fundamental": "Fundamental",
}


def _auth_headers(settings: Any) -> dict[str, str]:
    """Same header the proxy sends -- vibe rejects non-loopback callers without it.

    Duplicated from ``routers/vibe.py`` rather than imported: a harvester
    reaching into a router for a private helper is the wrong direction, and this
    is two lines. If the scheme ever changes, both sites change.
    """
    token = settings.vibe_api_token
    return {"Authorization": f"Bearer {token}"} if token else {}


def fetch(settings: Any) -> Iterable[Entity]:
    with httpx.Client(timeout=_TIMEOUT) as client:
        response = client.get(
            f"{settings.vibe_api_url}/alpha/list",
            params={"limit": _LIMIT},
            headers=_auth_headers(settings),
        )
        response.raise_for_status()
        payload = response.json()

    if payload.get("status") != "ok":
        raise RuntimeError(f"vibe /alpha/list returned status={payload.get('status')!r}")
    if payload.get("truncated"):
        raise RuntimeError(
            f"vibe zoo has more than {_LIMIT} alphas; this harvester would index only "
            f"the first page. Page the endpoint rather than shipping a silent subset.")

    out: list[Entity] = []
    for alpha in payload.get("alphas") or []:
        zoo = alpha.get("zoo") or "unknown"
        themes = list(alpha.get("theme") or [])
        universes = list(alpha.get("universe") or [])
        label = _ZOO_LABELS.get(zoo, zoo)

        out.append(
            Entity(
                kind="alpha",
                source="vibe",
                # The sidecar's own id, verbatim: `curated.py` parses this same
                # string out of a vibe-curated caveat to build a resolvable
                # `derived_from`, so the two must agree exactly.
                local_id=alpha["id"],
                name=alpha["id"],
                title=alpha.get("nickname") or alpha["id"],
                summary=_summary(alpha, label, themes),
                family=zoo,
                tags=sorted({*themes, *universes}),
                # Deliberately null -- see the module docstring.
                expression=None,
                payload={
                    "family_label": label,
                    "nickname": alpha.get("nickname"),
                    "theme": themes,
                    "universe": universes,
                    "decay_horizon": alpha.get("decay_horizon"),
                    "min_warmup_bars": alpha.get("min_warmup_bars"),
                    "requires_sector": bool(alpha.get("requires_sector", False)),
                    # Tells the detail rail to fetch formula/source from the
                    # sidecar and to offer its bench instead of the IC evaluator.
                    "runs_on": "vibe",
                },
            )
        )
    return out


def _summary(alpha: dict, label: str, themes: list[str]) -> str:
    """One line: what it is, and what it needs before it means anything."""
    parts = [label]
    if themes:
        parts.append(", ".join(themes))
    warmup = alpha.get("min_warmup_bars")
    if warmup:
        parts.append(f"{warmup}-bar warm-up")
    if alpha.get("requires_sector"):
        # The precondition that makes an alpha skip rather than run, and the one
        # a user would otherwise discover from an empty bench result.
        parts.append("needs sector tags")
    return " · ".join(parts)


HARVESTER = Harvester(
    name="vibe_zoo",
    kind="alpha",
    source="vibe",
    label="Vibe-Trading alpha zoo",
    fetch=fetch,
    remote=True,
)
