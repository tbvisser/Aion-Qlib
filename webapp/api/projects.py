"""Projects as JSON records on disk.

A structural copy of ``PortfolioStore``, which is itself a copy of
``StrategyStore``: uuid ids, the same ``_path`` guard against ids arriving off a
URL, corrupt files skipped by ``list()`` rather than breaking it,
``updated_at``-descending order, and ``upsert`` for idempotent seeding.

A project is the loosest container in the app: a name, a sentence, and lists of
ids pointing at work that already exists elsewhere. Nothing is owned — a
strategy in a project is still the same strategy, still reachable from the
builder, still deletable without asking the project.

**Membership is deliberately unvalidated.** The ids are stored as given and
resolved lazily by whoever reads them. Checking a strategy exists at write time
would mean this module importing ``StrategyStore`` and ``PortfolioStore``, and
it would turn a project holding one deleted strategy into a project that can no
longer be saved at all. A dangling id should degrade — the card shows one fewer
member — not 500.

Deliberately free of qlib and of ``marketdata``, for the same reason
``portfolios.py`` is: the store and its models must import on a machine with no
data store built.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)


class ProjectSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=80)
    description: str = Field("", max_length=2000)
    #: Members, as ids into the stores that own them. See the module docstring
    #: on why none of these are checked here.
    strategy_ids: list[str] = Field(default_factory=list, max_length=64)
    portfolio_ids: list[str] = Field(default_factory=list, max_length=64)
    #: Supabase thread and document uuids. This service never talks to Supabase
    #: — the browser resolves these against the RAG client it already holds.
    thread_ids: list[str] = Field(default_factory=list, max_length=200)
    document_ids: list[str] = Field(default_factory=list, max_length=200)


class StoredProject(ProjectSpec):
    id: str
    created_at: str
    updated_at: str
    #: See StoredStrategy -- ownership and sharing carry the same meaning here.
    user_id: str = ""
    visibility: str = "private"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ProjectStore:
    """Projects as JSON files on disk — inspectable and diffable."""

    def __init__(self, directory: Path):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, project_id: str) -> Path:
        # Defend the path join: ids come off the URL.
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", project_id):
            raise ValueError(f"Invalid project id: {project_id!r}")
        return self.dir / f"{project_id}.json"

    def list(self) -> list[StoredProject]:
        out: list[StoredProject] = []
        for path in sorted(self.dir.glob("*.json")):
            try:
                out.append(StoredProject(**json.loads(path.read_text())))
            except Exception:  # a hand-edited file should not break the list
                logger.warning("skipping unreadable project %s", path)
                continue
        return sorted(out, key=lambda p: p.updated_at, reverse=True)

    def get(self, project_id: str) -> StoredProject | None:
        path = self._path(project_id)
        if not path.exists():
            return None
        return StoredProject(**json.loads(path.read_text()))

    def _write(self, stored: StoredProject) -> StoredProject:
        self._path(stored.id).write_text(json.dumps(stored.model_dump(), indent=2))
        return stored

    def create(self, spec: ProjectSpec) -> StoredProject:
        now = _now()
        return self._write(StoredProject(
            **spec.model_dump(), id=uuid.uuid4().hex[:12], created_at=now, updated_at=now
        ))

    def update(self, project_id: str, spec: ProjectSpec) -> StoredProject | None:
        existing = self.get(project_id)
        if existing is None:
            return None
        return self._write(StoredProject(
            **spec.model_dump(), id=existing.id,
            created_at=existing.created_at, updated_at=_now(),
        ))

    def upsert(self, project_id: str, spec: ProjectSpec) -> StoredProject:
        """Write at a caller-chosen id. The seeder's idempotency contract."""
        existing = self.get(project_id)
        now = _now()
        return self._write(StoredProject(
            **spec.model_dump(), id=project_id,
            created_at=existing.created_at if existing else now, updated_at=now,
        ))

    def delete(self, project_id: str) -> bool:
        path = self._path(project_id)
        if not path.exists():
            return False
        path.unlink()
        return True
