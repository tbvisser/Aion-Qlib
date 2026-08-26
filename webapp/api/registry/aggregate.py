"""Fan out to every provider, cache the result, then search it in process.

Three properties, and how each is bought:

**One slow provider must not make the page slow every time.** ``_CACHE`` holds
each provider's rows with a fetch timestamp; a request inside ``TTL_SECONDS``
serves them without touching the network. The search box therefore costs one
fan-out per two minutes, not one per keystroke.

**A failing provider must not empty its collection.** A provider that raises
keeps whatever rows it last returned and records the error. That is the
``harvest_run`` contract from the catalog, minus the database -- and it is what
makes the roster degrade to "qlib and RAG, sidecar unreachable" rather than to a
blank table.

**A cold failing provider is empty and says so.** The first fetch has no
previous rows to keep. The distinction between "no rows because it failed" and
"no rows because there are none" lives in ``ProviderResult.error``, and
``summary()`` surfaces it -- a silent zero is the one answer this must never
give.

Concurrency: providers are fetched serially under one lock. Serial because the
whole fan-out is ~300 ms and threading four HTTP calls to save 200 ms is not
worth the failure modes; locked because two concurrent cold requests would
otherwise both fan out.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

from ..catalog.schema import Entity

logger = logging.getLogger(__name__)

#: How long a provider's rows are served without re-fetching. Two minutes is
#: long enough that browsing the roster never re-hits the sidecar, and short
#: enough that restarting a service shows up without anyone pressing refresh.
TTL_SECONDS = 120

MAX_LIMIT = 500

SORTS = ("name", "-name", "source", "kind")

#: Same tokenizer as the catalog's FTS, so `get_market_data` and `$close`
#: survive as single terms rather than splitting into three.
_TOKEN = re.compile(r"[A-Za-z0-9_$.]+")


@dataclass(frozen=True)
class Provider:
    """One source, and the single (kind, source) slice of the roster it owns."""

    name: str
    kind: str
    source: str
    label: str
    fetch: Callable[[Any], Iterable[Entity]]
    #: True when the fetch crosses the network -- the ones that can be degraded.
    remote: bool = False


@dataclass
class ProviderResult:
    provider: str
    kind: str
    source: str
    fetched_at: str | None = None
    #: Monotonic clock, for the TTL. Separate from `fetched_at`, which is a wall
    #: clock for the UI and must not be used for timing.
    _monotonic: float = 0.0
    error: str | None = None
    entities: list[Entity] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.error is None

    @property
    def stale(self) -> bool:
        """Serving rows from a fetch that later failed."""
        return bool(self.error) and bool(self.entities)


_CACHE: dict[str, ProviderResult] = {}
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _providers() -> tuple[Provider, ...]:
    # Imported lazily: the provider modules import this one for `Provider`.
    from .providers import providers as registered

    return registered()


# Re-exported so callers can enumerate without reaching into `.providers`.
def PROVIDERS() -> tuple[Provider, ...]:  # noqa: N802 - reads as a constant at call sites
    return _providers()


def _fetch_one(provider: Provider, settings: Any) -> ProviderResult:
    """Run one provider, catching everything it can throw."""
    previous = _CACHE.get(provider.name)
    try:
        entities = list(provider.fetch(settings))
        seen: set[str] = set()
        for item in entities:
            item.validate_shape()
            if item.kind != provider.kind or item.source != provider.source:
                raise ValueError(
                    f"{provider.name} declares ({provider.kind}, {provider.source}) but "
                    f"returned {item.uid}")
            if item.uid in seen:
                raise ValueError(f"{provider.name}: duplicate uid {item.uid}")
            seen.add(item.uid)
    except Exception as exc:  # noqa: BLE001 - one bad provider must not take the page down
        logger.warning("registry provider %s failed: %s", provider.name, exc)
        return ProviderResult(
            provider=provider.name,
            kind=provider.kind,
            source=provider.source,
            # Keep the previous fetch's timestamp and rows: the collection is
            # showing older data, and pretending it was fetched just now would
            # be the lie this whole structure exists to avoid.
            fetched_at=previous.fetched_at if previous else None,
            _monotonic=time.monotonic(),
            error=f"{type(exc).__name__}: {exc}",
            entities=list(previous.entities) if previous else [],
        )

    return ProviderResult(
        provider=provider.name,
        kind=provider.kind,
        source=provider.source,
        fetched_at=_now(),
        _monotonic=time.monotonic(),
        error=None,
        entities=entities,
    )


def _ensure(settings: Any, force: bool = False) -> dict[str, ProviderResult]:
    """Every provider's rows, fetching the ones whose TTL has lapsed."""
    now = time.monotonic()
    with _lock:
        for provider in _providers():
            cached = _CACHE.get(provider.name)
            fresh = (
                cached is not None
                and not force
                # A failed fetch is retried on the next request rather than
                # cached for the full TTL: the usual cause is a service that is
                # still starting, and two minutes of stale is a long time to
                # wait for a container that came up one second later.
                and cached.ok
                and (now - cached._monotonic) < TTL_SECONDS
            )
            if not fresh:
                _CACHE[provider.name] = _fetch_one(provider, settings)
        return dict(_CACHE)


def refresh(settings: Any) -> dict[str, ProviderResult]:
    """Drop the TTL and re-fetch everything."""
    return _ensure(settings, force=True)


def rows(settings: Any) -> list[Entity]:
    """Every row, from every provider, in provider order."""
    results = _ensure(settings)
    out: list[Entity] = []
    for provider in _providers():
        result = results.get(provider.name)
        if result:
            out.extend(result.entities)
    return out


# ---------------------------------------------------------------------------
# Querying
# ---------------------------------------------------------------------------


def _haystack(item: Entity) -> str:
    parts = [item.name, item.title or "", item.summary or "", " ".join(item.tags),
             item.family or ""]
    return " ".join(parts).lower()


def _matches(item: Entity, tokens: list[str]) -> bool:
    """All tokens must appear. Substring, not prefix: a roster is small enough
    that `market` finding `get_market_data` is the behaviour people expect."""
    hay = _haystack(item)
    return all(token in hay for token in tokens)


def search(
    settings: Any,
    *,
    q: str | None = None,
    kind: str | None = None,
    source: str | None = None,
    family: str | None = None,
    tag: str | None = None,
    sort: str = "name",
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """One page, in the same envelope `/api/catalog/search` returns."""
    limit = max(1, min(limit, MAX_LIMIT))
    offset = max(0, offset)

    tokens = [t.lower() for t in _TOKEN.findall(q or "")]
    matched = [
        item for item in rows(settings)
        if (kind is None or item.kind == kind)
        and (source is None or item.source == source)
        and (family is None or item.family == family)
        and (tag is None or tag in item.tags)
        and (not tokens or _matches(item, tokens))
    ]

    reverse = sort.startswith("-")
    key = sort.lstrip("-")
    if key == "source":
        matched.sort(key=lambda e: (e.source, e.name.lower()), reverse=reverse)
    elif key == "kind":
        matched.sort(key=lambda e: (e.kind, e.name.lower()), reverse=reverse)
    else:
        matched.sort(key=lambda e: e.name.lower(), reverse=reverse)

    page = matched[offset:offset + limit]
    return {
        "results": [_wire(item) for item in page],
        "total": len(matched),
        "limit": limit,
        "offset": offset,
        "returned": len(page),
    }


def _wire(item: Entity) -> dict[str, Any]:
    """The catalog's row shape, so one browser component reads both pages."""
    return {
        "uid": item.uid,
        "kind": item.kind,
        "source": item.source,
        "local_id": item.local_id,
        "name": item.name,
        "title": item.title,
        "summary": item.summary,
        "family": item.family,
        "tags": list(item.tags),
        "expression": item.expression,
        "metric": item.metric,
        "updated_at": item.updated_at,
        "payload": item.payload,
    }


def facets(settings: Any, kind: str | None = None) -> dict[str, Any]:
    """Value counts for the filter rail, scoped to one collection."""
    scoped = [e for e in rows(settings) if kind is None or e.kind == kind]

    def tally(values: Iterable[str]) -> list[dict[str, Any]]:
        counts: dict[str, int] = {}
        for value in values:
            if value:
                counts[value] = counts.get(value, 0) + 1
        return [
            {"value": v, "count": c}
            for v, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        ]

    return {
        "kind": kind,
        "source": tally(e.source for e in scoped),
        "family": tally(e.family or "" for e in scoped),
        "tags": tally(t for e in scoped for t in e.tags),
    }


def entity(settings: Any, uid: str) -> dict[str, Any] | None:
    for item in rows(settings):
        if item.uid == uid:
            # `links` is empty rather than absent so the detail rail can read
            # both pages' payloads without branching. The roster has no link
            # table -- provenance here is the source badge.
            return {**_wire(item), "links": {"out": [], "in": []}}
    return None


def summary(settings: Any) -> dict[str, Any]:
    """What is reachable, how fresh it is, and what is degraded."""
    results = _ensure(settings)

    by_kind: dict[str, dict[str, Any]] = {}
    for provider in _providers():
        result = results.get(provider.name)
        if not result:
            continue
        entry = by_kind.setdefault(
            provider.kind, {"kind": provider.kind, "count": 0, "sources": {}})
        entry["count"] += len(result.entities)
        entry["sources"][provider.source] = (
            entry["sources"].get(provider.source, 0) + len(result.entities))

    providers = [
        {
            "name": p.name,
            "label": p.label,
            "kind": p.kind,
            "source": p.source,
            "remote": p.remote,
            "count": len(results[p.name].entities) if p.name in results else 0,
            "fetched_at": results[p.name].fetched_at if p.name in results else None,
            "error": results[p.name].error if p.name in results else None,
            # True when the rows on screen predate the last (failed) attempt.
            "stale": results[p.name].stale if p.name in results else False,
        }
        for p in _providers()
    ]

    return {
        "total": sum(len(r.entities) for r in results.values()),
        "collections": sorted(by_kind.values(), key=lambda c: c["kind"]),
        "providers": providers,
        "degraded": [p["name"] for p in providers if p["error"]],
        "ttl_seconds": TTL_SECONDS,
    }


def _reset_for_tests() -> None:
    """Drop the cache. Test hook; do not call in production."""
    with _lock:
        _CACHE.clear()
