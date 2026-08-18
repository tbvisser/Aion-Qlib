"""Reading the catalog: connection, search, facets, links.

Everything here takes an explicit ``sqlite3.Connection``. There is no module-level
singleton, because the harvest worker runs on its own thread and sqlite
connections are not shareable across threads by default -- a global would either
need ``check_same_thread=False`` (and then a lock around every read) or would
break the first time a reindex overlapped a request.

The one piece with real subtlety is ``_match_query``. FTS5's query language
treats ``-``, ``*``, ``(``, ``:`` and ``"`` as syntax, so a user typing
``MOM_12_1`` or ``Ref($close, 20)`` into the search box would otherwise produce
``fts5: syntax error``. Every token is quoted and the last one gets a prefix
star, which is what makes the box feel like search-as-you-type rather than
search-on-enter.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .schema import ENTITY_DDL, FTS_DDL, HARVEST_DDL, LINK_DDL

#: How a caller may order a result page. `relevance` is only meaningful with a
#: query; without one it falls back to name, because ranking a set that matched
#: nothing is ranking by an undefined number.
SORTS: dict[str, str] = {
    "relevance": "rank",
    "name": "e.name COLLATE NOCASE ASC",
    "-name": "e.name COLLATE NOCASE DESC",
    "metric": "e.metric IS NULL, e.metric ASC",
    "-metric": "e.metric IS NULL, e.metric DESC",
    "updated": "e.updated_at IS NULL, e.updated_at ASC",
    "-updated": "e.updated_at IS NULL, e.updated_at DESC",
}

MAX_LIMIT = 500

_TOKEN = re.compile(r"[A-Za-z0-9_$.]+")


def connect(path: Path) -> sqlite3.Connection:
    """Open (and create) the catalog, with the pragmas a read-heavy index wants."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    # WAL so a reindex on the worker thread does not block reads on the request
    # threads; NORMAL because losing the tail of a derived index on a power cut
    # costs one `POST /catalog/reindex`.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init(conn: sqlite3.Connection, prefix: str = "") -> None:
    """Create the tables if they are not there. Safe to call on every open."""
    conn.executescript(ENTITY_DDL.format(p=prefix))
    conn.executescript(FTS_DDL.format(p=prefix))
    if not prefix:
        conn.executescript(LINK_DDL)
        conn.executescript(HARVEST_DDL)
    conn.commit()


def _match_query(q: str) -> str | None:
    """Turn a raw search box into an FTS5 MATCH expression, or None if empty.

    Tokens are quoted so nothing the user types is read as syntax, and the final
    token gets a prefix star so a half-typed word still matches. Tokens are
    ANDed, which is what people expect from two words.
    """
    tokens = _TOKEN.findall(q or "")
    if not tokens:
        return None
    quoted = [f'"{t}"' for t in tokens[:-1]]
    # Prefix search on the last token only. `"foo"*` is valid FTS5; `"fo o"*`
    # would not be, which is why the tokenizer above split on punctuation first.
    quoted.append(f'"{tokens[-1]}"*')
    return " AND ".join(quoted)


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    out = dict(row)
    out["tags"] = json.loads(out.get("tags") or "[]")
    out["payload"] = json.loads(out.get("payload") or "{}")
    out.pop("rank", None)
    return out


def search(
    conn: sqlite3.Connection,
    *,
    q: str | None = None,
    kind: str | None = None,
    source: str | None = None,
    family: str | None = None,
    tag: str | None = None,
    sort: str = "relevance",
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """One page of the catalog, plus the total the filters matched."""
    limit = max(1, min(limit, MAX_LIMIT))
    offset = max(0, offset)

    match = _match_query(q) if q else None
    where: list[str] = []
    params: list[Any] = []

    if match:
        joins = "JOIN entity_fts f ON f.rowid = e.rowid"
        where.append("entity_fts MATCH ?")
        params.append(match)
    else:
        joins = ""

    if kind:
        where.append("e.kind = ?")
        params.append(kind)
    if source:
        where.append("e.source = ?")
        params.append(source)
    if family:
        where.append("e.family = ?")
        params.append(family)
    if tag:
        # tags is a JSON array; the LIKE is on the serialised form, which is
        # exact enough because every tag is quoted in it.
        where.append("e.tags LIKE ?")
        params.append(f'%"{tag}"%')

    clause = f"WHERE {' AND '.join(where)}" if where else ""

    total = conn.execute(
        f"SELECT COUNT(*) FROM entity e {joins} {clause}", params
    ).fetchone()[0]

    order = SORTS.get(sort, SORTS["relevance"])
    if order == "rank" and not match:
        order = SORTS["name"]

    rows = conn.execute(
        f"SELECT e.* FROM entity e {joins} {clause} ORDER BY {order} LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    return {
        "results": [_row_to_dict(r) for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
        "returned": len(rows),
    }


def facets(conn: sqlite3.Connection, kind: str | None = None) -> dict[str, Any]:
    """Value counts for the filter rail, scoped to one collection.

    Tags are counted in Python: they are a JSON array per row, and the
    alternative -- a json_each join -- costs more than iterating 12,000 short
    lists once, and would need SQLite compiled with JSON1 to be relied on.
    """
    clause = "WHERE kind = ?" if kind else ""
    params: list[Any] = [kind] if kind else []

    def counted(column: str) -> list[dict[str, Any]]:
        rows = conn.execute(
            f"SELECT {column} AS value, COUNT(*) AS count FROM entity {clause} "
            f"GROUP BY {column} ORDER BY count DESC, value ASC",
            params,
        ).fetchall()
        return [dict(r) for r in rows if r["value"] is not None]

    tally: dict[str, int] = {}
    for (raw,) in conn.execute(f"SELECT tags FROM entity {clause}", params):
        for tag in json.loads(raw or "[]"):
            tally[tag] = tally.get(tag, 0) + 1

    return {
        "kind": kind,
        "source": counted("source"),
        "family": counted("family"),
        "tags": [
            {"value": t, "count": c}
            for t, c in sorted(tally.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
    }


def get(conn: sqlite3.Connection, uid: str) -> dict[str, Any] | None:
    """One entity with everything linked to it, in both directions.

    A link's other end is resolved to a name here rather than in the UI, so a
    link to a row a later harvest dropped renders as a dangling id with its rel
    intact instead of vanishing -- the same posture `ProjectSpec` takes with its
    opaque id lists.
    """
    row = conn.execute("SELECT * FROM entity WHERE uid = ?", (uid,)).fetchone()
    if row is None:
        return None

    entity = _row_to_dict(row)
    entity["links"] = {
        "out": _resolve_links(conn, uid, outgoing=True),
        "in": _resolve_links(conn, uid, outgoing=False),
    }
    return entity


def _resolve_links(conn: sqlite3.Connection, uid: str, *, outgoing: bool) -> list[dict[str, Any]]:
    mine, theirs = ("src_uid", "dst_uid") if outgoing else ("dst_uid", "src_uid")
    rows = conn.execute(
        f"SELECT l.rel, l.note, l.{theirs} AS uid, e.kind, e.name, e.title, e.source "
        f"FROM entity_link l LEFT JOIN entity e ON e.uid = l.{theirs} "
        f"WHERE l.{mine} = ? ORDER BY l.rel, l.{theirs}",
        (uid,),
    ).fetchall()
    return [dict(r) for r in rows]


def summary(conn: sqlite3.Connection) -> dict[str, Any]:
    """`GET /catalog/summary`: what is indexed, and how fresh each source is."""
    counts = conn.execute(
        "SELECT kind, source, COUNT(*) AS count FROM entity GROUP BY kind, source"
    ).fetchall()
    by_kind: dict[str, dict[str, Any]] = {}
    for row in counts:
        entry = by_kind.setdefault(row["kind"], {"kind": row["kind"], "count": 0, "sources": {}})
        entry["count"] += row["count"]
        entry["sources"][row["source"]] = row["count"]

    harvests = [
        dict(r)
        for r in conn.execute(
            "SELECT harvester, source, started_at, finished_at, count, error "
            "FROM harvest_run ORDER BY harvester"
        ).fetchall()
    ]
    total = conn.execute("SELECT COUNT(*) FROM entity").fetchone()[0]
    links = conn.execute("SELECT COUNT(*) FROM entity_link").fetchone()[0]

    return {
        "total": total,
        "links": links,
        "collections": sorted(by_kind.values(), key=lambda c: c["kind"]),
        "harvests": harvests,
        "degraded": [h["harvester"] for h in harvests if h["error"]],
    }


def add_link(
    conn: sqlite3.Connection, src_uid: str, dst_uid: str, rel: str, note: str | None = None
) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO entity_link (src_uid, dst_uid, rel, note, created_at) "
        "VALUES (?,?,?,?,?)",
        (src_uid, dst_uid, rel, note, datetime.now(timezone.utc).isoformat(timespec="seconds")),
    )
    conn.commit()


def remove_link(conn: sqlite3.Connection, src_uid: str, dst_uid: str, rel: str) -> bool:
    cur = conn.execute(
        "DELETE FROM entity_link WHERE src_uid = ? AND dst_uid = ? AND rel = ?",
        (src_uid, dst_uid, rel),
    )
    conn.commit()
    return cur.rowcount > 0
