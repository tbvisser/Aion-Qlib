"""Trade-file parsers (PRD M1): broker exports -> canonical NormalizedTrade."""
from __future__ import annotations

from scalability_agent.ingest.generic_csv import parse_generic_csv
from scalability_agent.ingest.ibkr import looks_like_ibkr, parse_ibkr
from scalability_agent.ingest.models import NormalizedTrade

__all__ = [
    "NormalizedTrade",
    "parse_generic_csv",
    "parse_ibkr",
    "looks_like_ibkr",
    "parse_trades",
]


def parse_trades(filename: str, data: bytes) -> tuple[list[NormalizedTrade], str]:
    """Parse an uploaded file into normalized trades, picking the parser.

    Detection is content-based (IBKR activity statements have a recognizable
    ``Trades,Header,...`` row) so a mislabeled extension cannot silently route
    a file to the wrong parser. Returns ``(trades, parser_name)`` and raises
    ``ValueError`` when nothing parseable is found.
    """
    text = data.decode("utf-8-sig", errors="replace")
    if looks_like_ibkr(text):
        trades = parse_ibkr(text)
        if trades:
            return trades, "ibkr"
    trades = parse_generic_csv(text)
    if not trades:
        raise ValueError(f"no parseable trades found in {filename!r}")
    return trades, "generic_csv"
