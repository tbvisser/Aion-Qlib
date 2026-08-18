"""Column-mapped generic CSV parser with flexible header aliases (PRD M1).

Funds upload whatever their broker exports; we cannot dictate column names,
so headers are matched case-insensitively against an alias table. Rows that
fail to parse are skipped rather than aborting the whole file — partial data
still yields a useful profile, and the summary records the trade count so the
"what we understood" preview can surface gaps.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime

from scalability_agent.ingest.models import NormalizedTrade

COLUMN_ALIASES: dict[str, tuple[str, ...]] = {
    "symbol": ("symbol", "ticker", "instrument", "code", "underlying"),
    "side": ("side", "direction", "buy/sell", "buysell", "action", "type"),
    "quantity": ("quantity", "qty", "shares", "size", "amount", "contracts", "volume"),
    "price": ("price", "trade_price", "tradeprice", "exec_price", "fill_price", "t. price"),
    "timestamp": ("timestamp", "datetime", "date_time", "date/time", "time", "trade_date", "tradedate", "date"),
    "fee": ("fee", "fees", "commission", "comm", "comm/fee", "commission_fee"),
    "currency": ("currency", "ccy", "curr"),
}

_BUY_TOKENS = {"buy", "b", "long", "bot", "1"}
_SELL_TOKENS = {"sell", "s", "short", "sld", "-1", "ss"}

_TIMESTAMP_FORMATS = (
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d, %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y",
    "%Y%m%d",
)


def _parse_timestamp(raw: str) -> datetime:
    raw = raw.strip().rstrip("Z")
    for fmt in _TIMESTAMP_FORMATS:
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    # Last resort: ISO with fractional seconds / offsets.
    return datetime.fromisoformat(raw)


def _parse_side(raw: str, quantity: float) -> str:
    token = raw.strip().lower()
    if token in _BUY_TOKENS:
        return "buy"
    if token in _SELL_TOKENS:
        return "sell"
    # Many exports omit a side column and sign the quantity instead.
    return "buy" if quantity >= 0 else "sell"


def _match_columns(header: list[str]) -> dict[str, int]:
    """Map canonical field -> column index; first alias wins per column."""
    normalized = [h.strip().lower().replace(" ", "_").replace("-", "_") for h in header]
    mapping: dict[str, int] = {}
    for field, aliases in COLUMN_ALIASES.items():
        for idx, col in enumerate(normalized):
            if col in aliases:
                mapping[field] = idx
                break
    return mapping


def parse_generic_csv(text: str) -> list[NormalizedTrade]:
    """Parse a CSV with a header row into normalized trades.

    Requires at minimum symbol, quantity and price columns; side falls back
    to quantity sign and timestamp to the file epoch day when absent — but a
    missing timestamp makes day-level profiling meaningless, so it is
    required here and the file is rejected otherwise.
    """
    reader = csv.reader(io.StringIO(text))
    rows = [r for r in reader if any(cell.strip() for cell in r)]
    if not rows:
        return []
    mapping = _match_columns(rows[0])
    required = {"symbol", "quantity", "price", "timestamp"}
    if not required.issubset(mapping):
        return []

    trades: list[NormalizedTrade] = []
    for row in rows[1:]:
        try:
            quantity = float(row[mapping["quantity"]].replace(",", ""))
            price = float(row[mapping["price"]].replace(",", ""))
            symbol = row[mapping["symbol"]].strip()
            if not symbol or price <= 0 or quantity == 0:
                continue
            side_raw = row[mapping["side"]] if "side" in mapping else ""
            fee = 0.0
            if "fee" in mapping and row[mapping["fee"]].strip():
                fee = abs(float(row[mapping["fee"]].replace(",", "")))
            currency = row[mapping["currency"]].strip() or None if "currency" in mapping else None
            trades.append(
                NormalizedTrade(
                    symbol=symbol,
                    side=_parse_side(side_raw, quantity),
                    quantity=abs(quantity),
                    price=price,
                    timestamp=_parse_timestamp(row[mapping["timestamp"]]),
                    fee=fee,
                    currency=currency,
                )
            )
        except (ValueError, IndexError):
            continue
    return trades
