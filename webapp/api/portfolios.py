"""Portfolios as JSON records on disk.

A structural copy of ``StrategyStore``: uuid ids, the same ``_path`` guard
against ids arriving off a URL, corrupt files skipped by ``list()`` rather than
breaking it, ``updated_at``-descending order.

Two deliberate differences:

* **JSON, not YAML.** A strategy is a config a human might hand-edit; a
  portfolio is a record. ``run.json`` sets the precedent.
* **``upsert``**, so the demo seeder gets stable ids and is idempotent.

Deliberately free of qlib and of ``marketdata``: the store and its models must
import on a machine with no data store built, so a test or a CLI can round-trip
a portfolio without one. Pricing lives in ``portfolio_nav.py``.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

logger = logging.getLogger(__name__)

AssetClass = Literal["equity", "etf", "index", "crypto", "fx"]
BaseCurrency = Literal["USD", "EUR", "GBP", "JPY", "CHF"]
Rebalance = Literal["none", "monthly", "quarterly", "annual"]


class Holding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    symbol: str = Field(..., min_length=1, max_length=32)
    asset_class: AssetClass = "equity"
    #: Target weight as a fraction of NAV. Shorts are allowed but capped, so a
    #: fat-fingered 20 becomes a validation error rather than a curve nobody
    #: questions.
    weight: float = Field(..., ge=-2.0, le=2.0)

    @field_validator("symbol")
    @classmethod
    def _upper(cls, value: str) -> str:
        return value.strip().upper()


class PortfolioSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=80)
    base_ccy: BaseCurrency = "USD"
    benchmark: str = "SPY"
    holdings: list[Holding] = Field(..., min_length=1, max_length=100)
    #: Strategies whose research feeds this book. Free-form association; the
    #: /book page resolves them and shows each one's latest run.
    strategy_ids: list[str] = Field(default_factory=list, max_length=32)
    inception: str = "2020-01-01"
    rebalance: Rebalance = "monthly"
    #: One-way cost charged on turnover at each rebalance.
    cost_bps: float = Field(10.0, ge=0, le=500)
    notes: str = Field("", max_length=2000)
    #: High-level investment objective (e.g. "Absolute return with vol < 10%").
    objective: str = Field("", max_length=500)
    #: Soft or hard constraints (e.g. "max 40% bonds, monthly rebalance").
    constraints: str = Field("", max_length=500)
    #: Searchable tags, e.g. ["macro", "multi-asset"].
    tags: list[str] = Field(default_factory=list, max_length=16)

    @field_validator("benchmark")
    @classmethod
    def _upper_benchmark(cls, value: str) -> str:
        return value.strip().upper()

    @field_validator("inception")
    @classmethod
    def _iso_date(cls, value: str) -> str:
        try:
            datetime.strptime(value, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError(f"inception must be YYYY-MM-DD, got {value!r}") from exc
        return value

    def validate_holdings(self) -> list[str]:
        """Hard errors: things that make the portfolio incoherent."""
        problems: list[str] = []
        seen: set[str] = set()
        for holding in self.holdings:
            if holding.symbol in seen:
                problems.append(
                    f"{holding.symbol} appears more than once — combine the weights "
                    "into a single holding"
                )
            seen.add(holding.symbol)
        return problems

    def validate_weights(self) -> list[str]:
        """Soft warnings: true but possibly unintended.

        Weights are never silently normalised. A book summing to 0.87 is a
        perfectly meaningful 13%-cash book, and quietly rescaling it to 1.0
        would report a return the user's actual allocation never earned.
        """
        warnings: list[str] = []
        total = sum(h.weight for h in self.holdings)
        if abs(total - 1.0) > 0.01:
            residual = 1.0 - total
            if residual > 0:
                warnings.append(
                    f"weights sum to {total:.2%}; the remaining {residual:.2%} is "
                    "held as cash earning 0%"
                )
            else:
                warnings.append(
                    f"weights sum to {total:.2%}, so this book is geared "
                    f"{-residual:.2%} — returns are scaled accordingly"
                )
        if any(h.weight < 0 for h in self.holdings):
            warnings.append(
                "this book has short positions; they are held at a constant weight "
                "with no borrow cost"
            )
        return warnings


class StoredPortfolio(PortfolioSpec):
    id: str
    created_at: str
    updated_at: str
    #: See StoredStrategy -- ownership and sharing carry the same meaning here.
    user_id: str = ""
    visibility: str = "private"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PortfolioStore:
    """Portfolios as JSON files on disk — inspectable and diffable."""

    def __init__(self, directory: Path):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, portfolio_id: str) -> Path:
        # Defend the path join: ids come off the URL.
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", portfolio_id):
            raise ValueError(f"Invalid portfolio id: {portfolio_id!r}")
        return self.dir / f"{portfolio_id}.json"

    def list(self) -> list[StoredPortfolio]:
        out: list[StoredPortfolio] = []
        for path in sorted(self.dir.glob("*.json")):
            try:
                out.append(StoredPortfolio(**json.loads(path.read_text())))
            except Exception:  # a hand-edited file should not break the list
                logger.warning("skipping unreadable portfolio %s", path)
                continue
        return sorted(out, key=lambda p: p.updated_at, reverse=True)

    def get(self, portfolio_id: str) -> StoredPortfolio | None:
        path = self._path(portfolio_id)
        if not path.exists():
            return None
        return StoredPortfolio(**json.loads(path.read_text()))

    def _write(self, stored: StoredPortfolio) -> StoredPortfolio:
        self._path(stored.id).write_text(json.dumps(stored.model_dump(), indent=2))
        return stored

    def create(self, spec: PortfolioSpec) -> StoredPortfolio:
        now = _now()
        return self._write(StoredPortfolio(
            **spec.model_dump(), id=uuid.uuid4().hex[:12], created_at=now, updated_at=now
        ))

    def update(self, portfolio_id: str, spec: PortfolioSpec) -> StoredPortfolio | None:
        existing = self.get(portfolio_id)
        if existing is None:
            return None
        return self._write(StoredPortfolio(
            **spec.model_dump(), id=existing.id,
            created_at=existing.created_at, updated_at=_now(),
        ))

    def upsert(self, portfolio_id: str, spec: PortfolioSpec) -> StoredPortfolio:
        """Write at a caller-chosen id. The seeder's idempotency contract."""
        existing = self.get(portfolio_id)
        now = _now()
        return self._write(StoredPortfolio(
            **spec.model_dump(), id=portfolio_id,
            created_at=existing.created_at if existing else now, updated_at=now,
        ))

    def delete(self, portfolio_id: str) -> bool:
        path = self._path(portfolio_id)
        if not path.exists():
            return False
        path.unlink()
        return True
