"""Parser tests: header aliases, IBKR statement sections, detection."""
from __future__ import annotations

from scalability_agent.ingest import parse_trades
from scalability_agent.ingest.generic_csv import parse_generic_csv
from scalability_agent.ingest.ibkr import looks_like_ibkr, parse_ibkr
from scalability_agent.tests.conftest import GENERIC_CSV

# Realistic shape: statement header block, Trades section with a Header row,
# Order executions plus a Closed Lot row that must be ignored, then another
# section. Fees are negative cash flows in the IBKR format.
IBKR_CSV = """Statement,Header,Field Name,Field Value
Statement,Data,BrokerName,IBKR
Trades,Header,Data Discriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code
Trades,Data,Order,Stocks,USD,AAPL,"2024-01-02, 09:31:00",100,150.25,150.20,-15025.00,-1.50,15026.50,0,0,O
Trades,Data,Order,Stocks,USD,AAPL,"2024-01-02, 10:05:00",-100,151.00,150.90,15100.00,-1.55,15098.45,0,0,O
Trades,Data,Closed Lot,Stocks,USD,AAPL,"2024-01-02, 10:05:00",100,150.25,151.00,0,0,0,75.00,0,O
SubTrades,Header,whatever
Trades,Data,Order,Stocks,USD,MSFT,"2024-01-03, 11:00:00",25,400.00,399.50,-10000.00,-1.00,10001.00,0,0,O
"""


def test_generic_csv_header_aliases():
    trades = parse_generic_csv(GENERIC_CSV)
    assert len(trades) == 3
    aapl_buy = trades[0]
    assert aapl_buy.symbol == "AAPL"
    assert aapl_buy.side == "buy"
    assert aapl_buy.quantity == 100
    assert aapl_buy.price == 150.25
    assert aapl_buy.fee == 1.50
    assert aapl_buy.currency == "USD"
    assert trades[1].side == "sell"  # "S" alias
    assert trades[2].side == "buy"  # "Long" alias
    assert trades[2].fee == 0.50  # negative commission normalized to abs


def test_generic_csv_rejects_missing_required_columns():
    assert parse_generic_csv("a,b,c\n1,2,3\n") == []


def test_ibkr_parser_reads_only_order_rows():
    trades = parse_ibkr(IBKR_CSV)
    # 3 Order rows; the Closed Lot row and other sections are ignored.
    assert len(trades) == 3
    assert trades[0].side == "buy"  # positive quantity
    assert trades[1].side == "sell"  # negative quantity
    assert trades[0].fee == 1.50  # abs of -1.50
    assert trades[1].timestamp.year == 2024
    assert {t.symbol for t in trades} == {"AAPL", "MSFT"}


def test_ibkr_tolerates_garbage_rows():
    text = IBKR_CSV + 'Trades,Data,Order,Stocks,USD,BAD,not-a-date,xx,150.25,0,0,0,0,0,0,O\n'
    assert len(parse_ibkr(text)) == 3


def test_parse_trades_detects_ibkr_by_content():
    assert looks_like_ibkr(IBKR_CSV)
    assert not looks_like_ibkr(GENERIC_CSV)
    trades, parser = parse_trades("activity.csv", IBKR_CSV.encode())
    assert parser == "ibkr"
    assert len(trades) == 3
    trades, parser = parse_trades("trades.csv", GENERIC_CSV.encode())
    assert parser == "generic_csv"
    assert len(trades) == 3
