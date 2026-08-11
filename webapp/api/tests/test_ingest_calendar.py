"""The calendar must contain only real trading sessions.

dump_bin unions every date across every CSV, so one foreign-listed symbol that
prints a bar on Thanksgiving inserts a phantom trading day for the whole store.
That shifts every rolling window and lets a backtest trade on a closed market.
"""
from __future__ import annotations

import pandas as pd

from webapp.ingest.eodhd import prune_non_trading_days


def _write(csv_dir, symbol: str, rows: list[tuple[str, float | None]]) -> None:
    pd.DataFrame(
        {
            "symbol": symbol,
            "date": [d for d, _ in rows],
            "open": [c for _, c in rows],
            "high": [c for _, c in rows],
            "low": [c for _, c in rows],
            "close": [c for _, c in rows],
            "volume": [1000 if c is not None else None for _, c in rows],
            "factor": 1.0,
            "change": 0.0,
        }
    ).to_csv(csv_dir / f"{symbol}.csv", index=False)


def test_drops_a_date_only_one_outlier_symbol_reports(tmp_path):
    """The real case: 499 US names are shut, one foreign listing keeps trading."""
    sessions = ["2025-07-01", "2025-07-02", "2025-07-03", "2025-07-07"]
    holiday = "2025-07-04"

    for i in range(10):
        _write(tmp_path, f"US{i}", [(d, 10.0 + i) for d in sessions])
    # The outlier trades on the holiday too.
    _write(tmp_path, "FOREIGN", [(d, 20.0) for d in sorted(sessions + [holiday])])

    dropped = prune_non_trading_days(tmp_path)

    assert dropped == [holiday]
    remaining = pd.read_csv(tmp_path / "FOREIGN.csv")["date"].tolist()
    assert holiday not in remaining
    assert remaining == sessions


def test_keeps_sparse_early_history(tmp_path):
    """A date must not be dropped just because few symbols were listed yet.

    The quorum is measured against symbols listed at the time, so 2010 (when
    most of today's large caps did not exist) survives intact.
    """
    old = ["2010-01-04", "2010-01-05"]
    recent = ["2026-01-04", "2026-01-05"]

    _write(tmp_path, "OLD1", [(d, 5.0) for d in old + recent])
    _write(tmp_path, "OLD2", [(d, 6.0) for d in old + recent])
    for i in range(20):
        _write(tmp_path, f"NEW{i}", [(d, 7.0) for d in recent])

    dropped = prune_non_trading_days(tmp_path)

    assert dropped == []
    assert pd.read_csv(tmp_path / "OLD1.csv")["date"].tolist() == old + recent


def test_is_idempotent(tmp_path):
    sessions = ["2025-07-01", "2025-07-02"]
    for i in range(5):
        _write(tmp_path, f"S{i}", [(d, 10.0) for d in sessions])
    _write(tmp_path, "ODD", [(d, 1.0) for d in sessions + ["2025-07-04"]])

    assert prune_non_trading_days(tmp_path) == ["2025-07-04"]
    assert prune_non_trading_days(tmp_path) == []


def test_empty_dir_is_not_an_error(tmp_path):
    assert prune_non_trading_days(tmp_path) == []
