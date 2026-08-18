"""Synthetic trades shared across engine tests."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from scalability_agent.ingest.models import NormalizedTrade

GENERIC_CSV = """Ticker,Side,Qty,Trade Price,Trade Date,Commission,CCY
AAPL,BUY,100,150.25,2024-01-02 09:31:00,1.50,USD
AAPL,S,50,151.00,2024-01-02 10:05:00,0.75,USD
MSFT,Long,25,400.00,2024-01-03,-0.50,USD
"""

# Mirrors the seeded venue_catalog v1 rows (IBKR accessible/higher fees,
# UBS gated at $20M/deeper+lower fees) so tests exercise the real seed shape.
IBKR_ROW = {
    "venue": "IBKR",
    "version": 1,
    "profile": {
        "display_name": "Interactive Brokers",
        "min_aum": 0,
        "fee_bps_per_side": 5.0,
        "spread_bps": 10.0,
        "min_ticket_usd": 0,
        "liquidity_multiplier": 1.0,
        "booking_link": "https://example.com/book/ibkr",
    },
}
UBS_ROW = {
    "venue": "UBS",
    "version": 1,
    "profile": {
        "display_name": "UBS",
        "min_aum": 20_000_000,
        "fee_bps_per_side": 2.0,
        "spread_bps": 6.0,
        "min_ticket_usd": 0,
        "liquidity_multiplier": 1.4,
        "booking_link": "https://example.com/book/ubs",
    },
}


def make_trades(
    n_days: int = 20,
    trades_per_day: int = 10,
    symbols: tuple[str, ...] = ("AAPL", "MSFT"),
    clip_usd: float = 10_000.0,
    price: float = 100.0,
) -> list[NormalizedTrade]:
    """Deterministic synthetic trade tape: constant clips across symbols."""
    trades: list[NormalizedTrade] = []
    day0 = datetime(2024, 1, 2)
    for day in range(n_days):
        for i in range(trades_per_day):
            symbol = symbols[i % len(symbols)]
            side = "buy" if i % 2 == 0 else "sell"
            trades.append(
                NormalizedTrade(
                    symbol=symbol,
                    side=side,
                    quantity=clip_usd / price,
                    price=price,
                    timestamp=day0 + timedelta(days=day, hours=9 + i % 6),
                    fee=clip_usd * 0.0003,  # 3 bps observed commission
                    currency="USD",
                )
            )
    return trades


@pytest.fixture
def trades() -> list[NormalizedTrade]:
    return make_trades()
