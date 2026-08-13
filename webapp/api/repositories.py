"""Per-user storage for strategies, portfolios and projects.

These three were three near-identical file stores -- ``StrategyStore`` writing
YAML, ``PortfolioStore`` and ``ProjectStore`` writing JSON, each with its own
copy of the same list/get/create/update/upsert/delete logic and its own path
guard against ids arriving off a URL. They are one class here, because the only
thing that ever actually differed between them was which pydantic model the
payload deserialises into.

The interface is unchanged on purpose, so the routers that call it barely move.
What changed is underneath: rows in Postgres instead of files, read and written
inside :func:`webapp.api.db.user_tx`. That transaction runs as ``authenticated``
with the caller's id published as a JWT claim, so the ``aion`` schema's row
level security decides what is visible. A query here that forgot to filter by
owner would still return only the caller's rows -- which is the point, because
the old file stores had no way to express ownership at all.

Ids stay caller-visible strings. ``_ID`` keeps the same character class the file
stores used, less because a bad id is dangerous now (it is a bound parameter,
not a path join) and more because ids leak into MLflow experiment names and URLs.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any, Generic, Sequence, TypeVar

from pydantic import BaseModel

from .auth import Principal
from .db import user_tx
from .portfolios import PortfolioSpec, StoredPortfolio
from .projects import ProjectSpec, StoredProject
from .strategies import StoredStrategy, StrategySpec

logger = logging.getLogger(__name__)

#: Same shape the file stores enforced. Ids reach MLflow experiment names and
#: /runs/:id URLs, so the constraint outlived the path join it was written for.
_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")

SpecT = TypeVar("SpecT", bound=BaseModel)
StoredT = TypeVar("StoredT", bound=BaseModel)


def new_id() -> str:
    return uuid.uuid4().hex[:12]


class RecordRepo(Generic[SpecT, StoredT]):
    """One user's view of one ``aion`` table."""

    #: Unqualified table name in the ``aion`` schema. Never interpolated from
    #: user input -- it is a class attribute set by the three subclasses below.
    table: str
    spec_model: type[SpecT]
    stored_model: type[StoredT]

    def __init__(self, principal: Principal):
        self.principal = principal

    # -- helpers ------------------------------------------------------------

    def _check_id(self, record_id: str) -> str:
        if not _ID.fullmatch(record_id or ""):
            raise ValueError(f"Invalid {self.table[:-1]} id: {record_id!r}")
        return record_id

    def _spec_fields(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Keep only keys the spec model still declares.

        Both directions of the round trip go through here. A field dropped from
        the model in a later release would otherwise make every row written
        before it unreadable -- ``extra="forbid"`` turns a stale key into a
        validation error, not a warning.
        """
        return {k: v for k, v in payload.items() if k in self.spec_model.model_fields}

    def _row_to_model(self, row: dict[str, Any]) -> StoredT:
        spec = self._spec_fields(row["spec"] or {})
        return self.stored_model(
            **spec,
            id=row["id"],
            user_id=str(row["user_id"]),
            visibility=row["visibility"],
            created_at=row["created_at"].isoformat(),
            updated_at=row["updated_at"].isoformat(),
        )

    def _select(self, cur, where: str = "", params: Sequence[Any] = ()) -> list[dict]:
        cur.execute(
            f"SELECT id, user_id, visibility, spec, created_at, updated_at "
            f"FROM aion.{self.table} {where} ORDER BY updated_at DESC",
            params,
        )
        return cur.fetchall()

    def _hydrate(self, rows: list[dict]) -> list[StoredT]:
        out: list[StoredT] = []
        for row in rows:
            try:
                out.append(self._row_to_model(row))
            except Exception:
                # A row whose spec no longer satisfies the model -- an older
                # schema, or a field since removed -- should cost one card in
                # the list, not the whole page. The file stores made the same
                # choice for a hand-edited YAML.
                logger.warning("skipping unreadable %s %s", self.table, row.get("id"))
        return out

    # -- reads --------------------------------------------------------------

    def list(self) -> list[StoredT]:
        """Everything this caller may see: their own, plus org-shared rows."""
        with user_tx(self.principal.user_id) as cur:
            return self._hydrate(self._select(cur))

    def get(self, record_id: str) -> StoredT | None:
        self._check_id(record_id)
        with user_tx(self.principal.user_id) as cur:
            rows = self._select(cur, "WHERE id = %s", (record_id,))
        if not rows:
            # Either it does not exist or it belongs to someone else. The caller
            # turns both into a 404: telling a stranger that an id is real but
            # forbidden is itself a disclosure.
            return None
        return self._row_to_model(rows[0])

    # -- writes -------------------------------------------------------------

    def _write(self, cur, record_id: str, spec: SpecT, *, keep_created: bool) -> dict:
        # Filtered, so callers may hand in a Stored* model (which carries id,
        # timestamps and ownership) without those leaking into the spec blob and
        # colliding on the way back out.
        payload = json.dumps(self._spec_fields(spec.model_dump(mode="json")))
        name = getattr(spec, "name", record_id)
        if keep_created:
            # ON CONFLICT rather than a read-then-write: two browser tabs saving
            # the same record would otherwise race between the SELECT and the
            # UPDATE. created_at is preserved by not being in the SET list.
            cur.execute(
                f"INSERT INTO aion.{self.table} "
                "  (id, org_id, user_id, name, spec) VALUES (%s, %s, %s, %s, %s) "
                "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "
                "  spec = EXCLUDED.spec, updated_at = NOW() "
                "RETURNING id, user_id, visibility, spec, created_at, updated_at",
                (record_id, self.principal.org_id, self.principal.user_id, name, payload),
            )
        else:
            cur.execute(
                f"INSERT INTO aion.{self.table} "
                "  (id, org_id, user_id, name, spec) VALUES (%s, %s, %s, %s, %s) "
                "RETURNING id, user_id, visibility, spec, created_at, updated_at",
                (record_id, self.principal.org_id, self.principal.user_id, name, payload),
            )
        return cur.fetchone()

    def create(self, spec: SpecT) -> StoredT:
        with user_tx(self.principal.user_id) as cur:
            row = self._write(cur, new_id(), spec, keep_created=False)
        return self._row_to_model(row)

    def update(self, record_id: str, spec: SpecT) -> StoredT | None:
        self._check_id(record_id)
        # Filtered, so callers may hand in a Stored* model (which carries id,
        # timestamps and ownership) without those leaking into the spec blob and
        # colliding on the way back out.
        payload = json.dumps(self._spec_fields(spec.model_dump(mode="json")))
        name = getattr(spec, "name", record_id)
        with user_tx(self.principal.user_id) as cur:
            cur.execute(
                f"UPDATE aion.{self.table} SET name = %s, spec = %s, updated_at = NOW() "
                "WHERE id = %s "
                "RETURNING id, user_id, visibility, spec, created_at, updated_at",
                (name, payload, record_id),
            )
            row = cur.fetchone()
        # No row means absent, or present but not writable by this caller -- the
        # UPDATE policy filtered it. Both are a 404 to the router.
        return self._row_to_model(row) if row else None

    def upsert(self, record_id: str, spec: SpecT) -> StoredT:
        """Write at a caller-chosen id, creating or replacing in place.

        ``create`` mints a uuid, which is right for the UI and useless to the
        demo seeder and the file-to-Postgres migration: both need a stable id so
        re-running them updates rather than duplicating.
        """
        self._check_id(record_id)
        with user_tx(self.principal.user_id) as cur:
            row = self._write(cur, record_id, spec, keep_created=True)
        return self._row_to_model(row)

    def delete(self, record_id: str) -> bool:
        self._check_id(record_id)
        with user_tx(self.principal.user_id) as cur:
            cur.execute(f"DELETE FROM aion.{self.table} WHERE id = %s", (record_id,))
            return cur.rowcount > 0

    def set_visibility(self, record_id: str, visibility: str) -> StoredT | None:
        """Share with the organisation, or take it back.

        Separate from ``update`` because sharing is not editing: the spec is
        untouched, and the two want different confirmation in the UI.
        """
        self._check_id(record_id)
        if visibility not in ("private", "org"):
            raise ValueError(f"Invalid visibility: {visibility!r}")
        with user_tx(self.principal.user_id) as cur:
            cur.execute(
                f"UPDATE aion.{self.table} SET visibility = %s, updated_at = NOW() "
                "WHERE id = %s "
                "RETURNING id, user_id, visibility, spec, created_at, updated_at",
                (visibility, record_id),
            )
            row = cur.fetchone()
        return self._row_to_model(row) if row else None


class StrategyRepo(RecordRepo[StrategySpec, StoredStrategy]):
    table = "strategies"
    spec_model = StrategySpec
    stored_model = StoredStrategy


class PortfolioRepo(RecordRepo[PortfolioSpec, StoredPortfolio]):
    table = "portfolios"
    spec_model = PortfolioSpec
    stored_model = StoredPortfolio


class ProjectRepo(RecordRepo[ProjectSpec, StoredProject]):
    table = "projects"
    spec_model = ProjectSpec
    stored_model = StoredProject


# --------------------------------------------------------------------------
# FastAPI dependencies
# --------------------------------------------------------------------------
# The routers used to build their stores as module-level singletons at import
# time, bound to one global Settings object. That was fine when there was one
# shared pile of files and is exactly wrong now: a repository has to carry the
# caller's identity, so it must be constructed per request.

def get_strategy_repo(principal: Principal) -> StrategyRepo:
    return StrategyRepo(principal)


def get_portfolio_repo(principal: Principal) -> PortfolioRepo:
    return PortfolioRepo(principal)


def get_project_repo(principal: Principal) -> ProjectRepo:
    return ProjectRepo(principal)
