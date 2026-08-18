"""Parser for IBKR activity-statement CSV exports (PRD M1, first broker).

Activity statements are multi-section CSVs: every row starts with a section
name and a row kind (``Header``/``Data``). We only read the ``Trades``
section, and only rows whose data discriminator is ``Order`` (actual
executions — the section also carries e.g. ``Closed Lot`` sub-rows that would
double-count). Column positions are taken from each ``Trades,Header`` row
rather than hard-coded, so the parser tolerates IBKR adding columns and the
header repeating after section breaks.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime

from scalability_agent.ingest.models import NormalizedTrade

# Map canonical fields to the header labels IBKR actually emits.
_IBKR_COLUMNS = {
    "symbol": "Symbol",
    "datetime": "Date/Time",
    "quantity": "Quantity",
    "price": "T. Price",
    "fee": "Comm/Fee",
    "currency": "Currency",
    "discriminator": "Data Discriminator",
}


def looks_like_ibkr(text: str) -> bool:
    """Cheap content sniff: IBKR statements have a ``Trades,Header,...`` row."""
    for line in text.splitlines():
        cells = [c.strip() for c in line.split(",")[:3]]
        if len(cells) >= 2 and cells[0] == "Trades" and cells[1] == "Header":
            return True
    return False


def _parse_ibkr_datetime(raw: str) -> datetime:
    raw = raw.strip()
    for fmt in ("%Y-%m-%d, %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y%m%d;%H%M%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    return datetime.fromisoformat(raw)


def parse_ibkr(text: str) -> list[NormalizedTrade]:
    """Extract executed trades from an IBKR activity-statement CSV."""
    trades: list[NormalizedTrade] = []
    columns: dict[str, int] | None = None
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        if len(row) < 2 or row[0].strip() != "Trades":
            continue
        kind = row[1].strip()
        if kind == "Header":
            header = [c.strip() for c in row]
            columns = {
                field: header.index(label)
                for field, label in _IBKR_COLUMNS.items()
                if label in header
            }
            continue
        if kind != "Data" or columns is None:
            continue
        try:
            if row[columns["discriminator"]].strip() != "Order":
                continue
            quantity = float(row[columns["quantity"]].replace(",", ""))
            price = float(row[columns["price"]].replace(",", ""))
            if quantity == 0 or price <= 0:
                continue
            fee = 0.0
            if "fee" in columns and row[columns["fee"]].strip():
                # IBKR reports commissions as negative cash flows.
                fee = abs(float(row[columns["fee"]].replace(",", "")))
            trades.append(
                NormalizedTrade(
                    symbol=row[columns["symbol"]].strip(),
                    side="buy" if quantity > 0 else "sell",
                    quantity=abs(quantity),
                    price=price,
                    timestamp=_parse_ibkr_datetime(row[columns["datetime"]]),
                    fee=fee,
                    currency=row[columns["currency"]].strip() or None,
                )
            )
        except (ValueError, IndexError, KeyError):
            continue
    return trades
