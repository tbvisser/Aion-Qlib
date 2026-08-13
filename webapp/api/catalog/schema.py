"""The one record shape every source is flattened into, and the DDL behind it.

A catalog row has to answer three questions for anything from a 191-alpha zoo to
a macro series: what is it called, what family is it in, and where did it come
from. Everything past that is kind-specific and lives in ``payload`` as JSON --
an alpha's ``caveat``, a backtest's metrics, an instrument's exchange. Promoting
any of those to a column would mean a migration every time a source grows a
field, and the index exists precisely so that nothing needs migrating.

Five columns are lifted out of the payload because the *list* view needs them
without parsing 10,000 JSON blobs: ``family`` and ``tags`` drive the facet rail,
``expression`` is what makes an alpha searchable by what it computes, ``metric``
is the one number a collection sorts by, and ``updated_at`` orders everything
else.

``uid`` is ``<kind>:<source>:<local_id>``. It has to be stable across rebuilds,
because ``entity_link`` references it and a user-set paper link must survive a
reindex -- so ``local_id`` is always the source's own identifier (a factor name,
a run id, a vibe ``alpha_id``), never a row number or a hash of the payload.
"""
from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

#: The collections. Each is one sub-tab of the Database or the Agents & Skills
#: page, and the value is what ``kind`` a harvester or provider stamps on its
#: rows.
#:
#: The last four are the roster's. They live here rather than in a second
#: taxonomy because they share this module's whole reason for existing: one uid
#: grammar, one shape guard, one set of source names. The roster federates live
#: instead of being indexed (see ``webapp/api/registry/``), but a
#: ``swarm:vibe:investment_committee`` has to parse exactly like an
#: ``alpha:vibe:gtja191_alpha_001`` or the shared browser cannot read both.
KINDS: tuple[str, ...] = (
    "alpha",
    "indicator",
    "operator",
    "strategy",
    "template",
    "backtest",
    "portfolio",
    "instrument",
    "universe",
    "macro_series",
    # Roster kinds -- federated, never indexed.
    "swarm",
    "agent",
    "skill",
    "tool",
)

KIND_LABELS: dict[str, str] = {
    "alpha": "Alphas",
    "indicator": "Indicators",
    "operator": "Operators",
    "strategy": "Strategies",
    "template": "Templates",
    "backtest": "Backtests",
    "portfolio": "Portfolios",
    "instrument": "Instruments",
    "universe": "Universes",
    "macro_series": "Macro series",
    "swarm": "Swarms",
    "agent": "Agents",
    "skill": "Skills",
    "tool": "Tools",
}

#: Kinds the catalog index holds. The reindex endpoint and the summary use this
#: rather than ``KINDS`` so a roster kind can never be reported as an empty
#: collection someone should press reindex to fill.
INDEXED_KINDS: tuple[str, ...] = tuple(
    k for k in KINDS if k not in ("swarm", "agent", "skill", "tool")
)

#: Where a row came from. `aion` is this app's own stores; the rest name an
#: upstream so provenance survives into the UI badge. `rag` is the vendored
#: Aion-RAG backend, which owns the harnesses, the sub-agents and the live tool
#: registry.
SOURCES: tuple[str, ...] = ("qlib", "curated", "vibe", "aion", "eodhd", "rag")

#: Links the harvest recomputes every run. Anything not in here is user-set and
#: is preserved across a rebuild -- see `harvest.swap`.
DERIVED_RELS: tuple[str, ...] = (
    "strategy_uses_alpha",
    "backtest_of_strategy",
    "portfolio_holds_strategy",
    "template_uses_alpha",
    # A curated factor adapted from a zoo entry. The provenance is prose in the
    # YAML caveat ("Adapted from Vibe-Trading (MIT), id academic_carhart_mom");
    # `curated.py` parses the id out, and this makes it navigable from the zoo
    # side too -- otherwise the upstream never learns it was adapted.
    "adapted_from",
)

_LOCAL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,127}$")


class Entity(BaseModel):
    """One catalog row, as a harvester produces it.

    ``uid`` is derived rather than passed, so no harvester can mint one that
    ``entity_link`` would fail to resolve.
    """

    model_config = ConfigDict(extra="forbid")

    kind: str
    source: str
    local_id: str
    name: str
    title: str | None = None
    summary: str | None = None
    family: str | None = None
    tags: list[str] = Field(default_factory=list)
    expression: str | None = None
    #: The one number this collection sorts by -- an alpha's IR, a backtest's
    #: annualised return. None when the source has no such number, which is
    #: most of them; the UI sorts by name instead rather than by a zero.
    metric: float | None = None
    updated_at: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)

    @property
    def uid(self) -> str:
        return f"{self.kind}:{self.source}:{self.local_id}"

    def row(self) -> tuple:
        """The tuple `INSERT_ENTITY` expects, in column order."""
        return (
            self.uid,
            self.kind,
            self.source,
            self.local_id,
            self.name,
            self.title,
            self.summary,
            self.family,
            json.dumps(self.tags),
            self.expression,
            self.metric,
            self.updated_at,
            json.dumps(self.payload, default=str),
        )

    def validate_shape(self) -> None:
        """Fail loudly on anything that would break a uid or a facet.

        Called by the orchestrator on every row rather than by pydantic, because
        the check is about the *uid* these three fields combine into and a
        field-level validator cannot see the other two.
        """
        if self.kind not in KINDS:
            raise ValueError(f"unknown kind {self.kind!r}; expected one of {', '.join(KINDS)}")
        if self.source not in SOURCES:
            raise ValueError(f"unknown source {self.source!r}; expected one of {', '.join(SOURCES)}")
        if not _LOCAL_ID.fullmatch(self.local_id):
            raise ValueError(
                f"local_id {self.local_id!r} must match {_LOCAL_ID.pattern} -- it is half of a "
                f"uid that entity_link references, so it cannot contain anything that would "
                f"make the uid ambiguous to parse")


#: Written against a fresh file, and against the temp tables the harvest builds
#: into. `{p}` is a table-name prefix -- empty for the live tables, `new_` while
#: a harvest is in flight.
ENTITY_DDL = """
CREATE TABLE IF NOT EXISTS {p}entity (
  uid        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  source     TEXT NOT NULL,
  local_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  title      TEXT,
  summary    TEXT,
  family     TEXT,
  tags       TEXT NOT NULL DEFAULT '[]',
  expression TEXT,
  metric     REAL,
  updated_at TEXT,
  payload    TEXT NOT NULL DEFAULT '{{}}'
);
CREATE INDEX IF NOT EXISTS {p}entity_kind ON {p}entity(kind);
CREATE INDEX IF NOT EXISTS {p}entity_kind_source ON {p}entity(kind, source);
CREATE INDEX IF NOT EXISTS {p}entity_kind_family ON {p}entity(kind, family);
"""

#: FTS5 over the five human-readable columns. `content=` makes it an external
#: content table -- the text is not stored twice, and the triggers below keep it
#: in step. `unicode61` with `remove_diacritics` so "Fama-French" and a query of
#: "fama french" find each other; `tokenchars` keeps `$close` and `MOM_12_1`
#: whole, which is the difference between an expression search working and not.
FTS_DDL = """
CREATE VIRTUAL TABLE IF NOT EXISTS {p}entity_fts USING fts5(
  name, title, summary, tags, expression,
  content='{p}entity',
  content_rowid='rowid',
  tokenize="unicode61 remove_diacritics 2 tokenchars '_$.'"
);
"""

#: Rebuilt wholesale after a bulk insert rather than maintained by triggers:
#: the harvest writes ~12,000 rows in one transaction, and per-row trigger
#: overhead on an external-content table is the slowest part of the run.
FTS_REBUILD = "INSERT INTO {p}entity_fts({p}entity_fts) VALUES('rebuild')"

LINK_DDL = """
CREATE TABLE IF NOT EXISTS entity_link (
  src_uid TEXT NOT NULL,
  dst_uid TEXT NOT NULL,
  rel     TEXT NOT NULL,
  note    TEXT,
  created_at TEXT,
  PRIMARY KEY (src_uid, dst_uid, rel)
);
CREATE INDEX IF NOT EXISTS entity_link_src ON entity_link(src_uid);
CREATE INDEX IF NOT EXISTS entity_link_dst ON entity_link(dst_uid);
"""

HARVEST_DDL = """
CREATE TABLE IF NOT EXISTS harvest_run (
  source      TEXT NOT NULL,
  harvester   TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  count       INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  PRIMARY KEY (harvester)
);
"""

INSERT_ENTITY = """
INSERT INTO {p}entity
  (uid, kind, source, local_id, name, title, summary, family, tags,
   expression, metric, updated_at, payload)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
"""
