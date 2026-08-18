"""Canonical trade model every ingest parser normalizes into (PRD M1)."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class NormalizedTrade:
    """One executed trade, normalized across broker export formats.

    ``side`` is always ``"buy"`` or ``"sell"`` regardless of how the source
    format encodes direction. ``fee`` is a positive number (source formats
    often report commissions as negative cash flows).
    """

    symbol: str
    side: str
    quantity: float
    price: float
    timestamp: datetime
    fee: float = 0.0
    currency: str | None = None

    @property
    def notional(self) -> float:
        """Absolute trade value; the engine reasons in notional, not shares."""
        return abs(self.quantity) * self.price
