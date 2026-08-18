"""Rebuilding the index: run the harvesters, swap the rows, derive the links.

Three properties this has to have, and how each is bought:

**A failing source must not empty its collection.** The sidecar goes down, the
qlib store is not mounted yet, someone hand-edits a YAML into a syntax error. A
harvester that raises is caught, its error recorded in ``harvest_run``, and its
rows are simply not deleted -- so the collection keeps yesterday's contents and
reports itself degraded. This is the same posture ``runs.py`` already takes when
MLflow is gone and only the snapshot is left.

**A reindex must not be visible half-done.** Everything is collected in memory
first and written in one transaction, so a request landing mid-harvest sees the
whole previous index or the whole new one. That is affordable because the whole
catalog is ~12,000 short rows; if a source ever grows past what fits in memory
it wants its own paging harvester, not a streaming write into a live table.

**A user-set link must survive.** ``entity_link`` holds two kinds of edge:
derived ones this module recomputes from scratch every run, and the paper-to-
factor links a person made by hand, which exist nowhere else in the app. Only
the rels named in ``DERIVED_RELS`` are cleared.

Each harvester owns exactly one ``(kind, source)`` pair, which is what makes the
delete scope declarable rather than guessed -- ``DELETE FROM entity WHERE kind=?
AND source=?`` is the whole of it, and the orchestrator asserts every row a
harvester returns matches what it declared.
"""
from __future__ import annotations

import logging
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

from . import db
from .schema import DERIVED_RELS, INSERT_ENTITY, Entity

logger = logging.getLogger(__name__)

#: Whitespace is not semantic in a qlib expression -- `Ref($close,5)` and
#: `Ref($close, 5)` are the same factor, and strategies written by hand and by
#: the builder differ by exactly that. Matching on the stripped form is what
#: makes `strategy_uses_alpha` find anything at all.
_WS = re.compile(r"\s+")


def normalise_expression(expression: str | None) -> str | None:
    if not expression:
        return None
    return _WS.sub("", expression)


@dataclass(frozen=True)
class Harvester:
    """One source, and the single (kind, source) slice of the index it owns."""

    name: str
    kind: str
    source: str
    label: str
    fetch: Callable[[Any], Iterable[Entity]]
    #: True when the fetch crosses the network. The reindex endpoint can skip
    #: these for a fast local-only rebuild, and the UI can explain a degraded
    #: remote differently from a broken local file.
    remote: bool = False


@dataclass
class SourceResult:
    harvester: str
    source: str
    kind: str
    started_at: str
    finished_at: str
    count: int
    error: str | None
    entities: list[Entity]

    @property
    def ok(self) -> bool:
        return self.error is None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def collect(
    harvester: Harvester,
    settings: Any,
    on_progress: Callable[[str, str], None] | None = None,
) -> SourceResult:
    """Run one harvester, catching everything it can throw.

    Rows are validated here rather than inside each harvester, so a new source
    cannot introduce a uid the link table would fail to resolve, and cannot
    quietly file its rows under a kind it does not own.
    """
    started = _now()
    if on_progress:
        on_progress(harvester.name, "running")

    try:
        entities = list(harvester.fetch(settings))
        for entity in entities:
            entity.validate_shape()
            if entity.kind != harvester.kind or entity.source != harvester.source:
                raise ValueError(
                    f"{harvester.name} declares ({harvester.kind}, {harvester.source}) but "
                    f"returned {entity.uid} -- the declaration is the delete scope, so a row "
                    f"outside it would never be cleaned up")
        seen: set[str] = set()
        for entity in entities:
            if entity.uid in seen:
                raise ValueError(f"{harvester.name}: duplicate uid {entity.uid}")
            seen.add(entity.uid)
    except Exception as exc:  # noqa: BLE001 -- one bad source must not stop the rest
        logger.exception("catalog harvester %s failed", harvester.name)
        return SourceResult(
            harvester=harvester.name,
            source=harvester.source,
            kind=harvester.kind,
            started_at=started,
            finished_at=_now(),
            count=0,
            error=f"{type(exc).__name__}: {exc}",
            entities=[],
        )

    return SourceResult(
        harvester=harvester.name,
        source=harvester.source,
        kind=harvester.kind,
        started_at=started,
        finished_at=_now(),
        count=len(entities),
        error=None,
        entities=entities,
    )


def write(conn: sqlite3.Connection, results: list[SourceResult]) -> None:
    """Swap in every successful harvester's rows, in one transaction."""
    successes = [r for r in results if r.ok]

    with conn:  # BEGIN ... COMMIT, or ROLLBACK on any exception
        for result in successes:
            conn.execute(
                "DELETE FROM entity WHERE kind = ? AND source = ?",
                (result.kind, result.source),
            )
            conn.executemany(
                INSERT_ENTITY.format(p=""),
                [e.row() for e in result.entities],
            )

        # External-content FTS: rebuilt wholesale rather than maintained by
        # triggers, because the harvest writes thousands of rows at once and
        # per-row trigger cost dominates the run.
        conn.execute("INSERT INTO entity_fts(entity_fts) VALUES('rebuild')")

        for result in results:
            conn.execute(
                "INSERT OR REPLACE INTO harvest_run "
                "(harvester, source, started_at, finished_at, count, error) "
                "VALUES (?,?,?,?,?,?)",
                (
                    result.harvester,
                    result.source,
                    result.started_at,
                    result.finished_at,
                    result.count,
                    result.error,
                ),
            )


def derive_links(conn: sqlite3.Connection) -> int:
    """Recompute every derived edge from the rows now in the index.

    Runs after any harvest, whatever subset ran, because the edges are a pure
    function of the entity table's current contents. User-set rels are untouched.
    """
    placeholders = ",".join("?" for _ in DERIVED_RELS)

    # expression -> the uids that compute it. A list, not a single uid: the same
    # expression legitimately appears as both a curated alpha and an Alpha158
    # indicator, and a strategy using it is using both.
    by_expression: dict[str, list[str]] = {}
    for uid, expression in conn.execute(
        "SELECT uid, expression FROM entity WHERE expression IS NOT NULL "
        "AND kind IN ('alpha','indicator')"
    ):
        key = normalise_expression(expression)
        if key:
            by_expression.setdefault(key, []).append(uid)

    edges: list[tuple[str, str, str, str | None]] = []

    # Provenance: a curated factor that names the zoo entry it was adapted from.
    # Carried in the payload by the curated harvester, promoted to an edge here
    # so the upstream entry can say it was adapted, not only the copy.
    for uid, payload in conn.execute(
        "SELECT uid, payload FROM entity WHERE kind = 'alpha' AND source = 'curated'"
    ):
        import json

        upstream = json.loads(payload or "{}").get("derived_from")
        if upstream:
            edges.append((uid, upstream, "adapted_from", None))

    for uid, kind, payload in conn.execute(
        "SELECT uid, kind, payload FROM entity WHERE kind IN "
        "('strategy','template','backtest','portfolio')"
    ):
        import json

        data = json.loads(payload or "{}")

        if kind in ("strategy", "template"):
            rel = "strategy_uses_alpha" if kind == "strategy" else "template_uses_alpha"
            for feature in data.get("features") or []:
                key = normalise_expression(feature.get("expression"))
                for dst in by_expression.get(key or "", []):
                    edges.append((uid, dst, rel, feature.get("name")))

        elif kind == "backtest":
            strategy_id = data.get("strategy_id")
            if strategy_id:
                edges.append((uid, f"strategy:aion:{strategy_id}", "backtest_of_strategy", None))

        elif kind == "portfolio":
            for strategy_id in data.get("strategy_ids") or []:
                edges.append(
                    (uid, f"strategy:aion:{strategy_id}", "portfolio_holds_strategy", None)
                )

    with conn:
        conn.execute(f"DELETE FROM entity_link WHERE rel IN ({placeholders})", DERIVED_RELS)
        conn.executemany(
            "INSERT OR REPLACE INTO entity_link (src_uid, dst_uid, rel, note, created_at) "
            "VALUES (?,?,?,?,?)",
            [(s, d, r, n, _now()) for s, d, r, n in edges],
        )
    return len(edges)


def run(
    conn: sqlite3.Connection,
    settings: Any,
    *,
    only: Iterable[str] | None = None,
    include_remote: bool = True,
    on_progress: Callable[[str, str], None] | None = None,
) -> dict[str, Any]:
    """Harvest, swap, derive. Returns what the reindex endpoint reports.

    ``only`` names harvesters to run; everything else keeps the rows it already
    has, which is the same mechanism a failure uses.
    """
    from .harvesters import HARVESTERS

    wanted = [
        h for h in HARVESTERS
        if (only is None or h.name in set(only))
        and (include_remote or not h.remote)
    ]

    results = [collect(h, settings, on_progress) for h in wanted]
    write(conn, results)
    link_count = derive_links(conn)

    failed = [r for r in results if not r.ok]
    return {
        "harvesters": [
            {
                "name": r.harvester,
                "kind": r.kind,
                "source": r.source,
                "count": r.count,
                "error": r.error,
            }
            for r in results
        ],
        "indexed": sum(r.count for r in results if r.ok),
        "links": link_count,
        "failed": [r.harvester for r in failed],
        "finished_at": _now(),
    }


def open_and_init(path) -> sqlite3.Connection:
    """The one-liner every caller wants: a connection with the tables present."""
    conn = db.connect(path)
    db.init(conn)
    return conn
