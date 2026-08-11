"""Data endpoints: instruments, calendar, bars, and expression evaluation.

Everything here goes through ``qlib.data.D`` -- the same accessor the notebooks
and benchmark configs use -- so the UI can never disagree with what a backtest
would see.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import marketdata, qlib_session

router = APIRouter()

# Guardrail: an unbounded expression query over `all` x 15 years would pin the
# event loop for minutes and return more JSON than a browser can chart.
MAX_INSTRUMENTS = 200
MAX_POINTS = 200_000


def _clean(value) -> float | None:
    """NaN/inf are not valid JSON; the wire format uses null."""
    if value is None:
        return None
    f = float(value)
    return f if math.isfinite(f) else None


@router.get("/universes")
def list_universes() -> dict:
    qlib_session.require_qlib()
    state = qlib_session.status()
    instruments_dir = Path(state["provider_uri"]).expanduser() / "instruments"
    names = sorted(p.stem for p in instruments_dir.glob("*.txt"))
    return {"universes": names, "default": "top500" if "top500" in names else (names[0] if names else None)}


@router.get("/data-stores")
def data_stores() -> dict:
    """The qlib stores a backtest can target, with their universes."""
    return {"stores": marketdata.data_stores()}


@router.get("/data-stores/{key}/universes")
def store_universes(key: str, sample: int = Query(12, le=50)) -> dict:
    """Every universe in one store, with how many names it holds and a few of them.

    One request rather than one per universe. The builder's dropdown offers
    eleven slugs — `top500`, `macro50`, `etf_top100` — and until now said nothing
    about any of them: not how many names, not which. Asking `/instruments` per
    row would be eleven round-trips to render a closed list.

    Both reads underneath are mtime-cached, so this is a handful of file reads
    cold and free afterwards.
    """
    store = marketdata.store_for(key)
    if store is None:
        raise HTTPException(status_code=404, detail=f"Unknown store '{key}'")

    universes = []
    for name in store.get("universes", []):
        symbols = marketdata.store_symbols(key, name)
        universes.append({
            "name": name,
            "count": len(symbols),
            "sample": symbols[:sample],
        })
    return {"store": key, "universes": universes}


@router.get("/asset-classes")
def asset_classes() -> dict:
    """Counts per class, so the UI can label its tabs honestly."""
    return {"classes": marketdata.class_counts(), "total": marketdata.load_catalog()["count"]}


@router.get("/instruments")
def list_instruments(
    universe: str = Query("", description="qlib universe; ignored when the catalog is used"),
    store: str = Query("", description="which store's universe file to read"),
    search: str = Query("", description="matches ticker and name"),
    asset_class: str = Query("", description="equity | etf | crypto | fx | index"),
    limit: int = Query(200, le=5000),
) -> dict:
    """Searchable instrument list.

    Served from the catalog, which is the only source that knows company names
    and asset classes -- the qlib store holds tickers alone. A ``universe``
    still forces a membership lookup, because Strategy Builder needs the exact
    contents of a universe file, not a name search.

    With ``store``, membership is read from that store's instrument file rather
    than through qlib. This matters: ``D.instruments`` resolves against whatever
    store *this process* mounted, so asking for `crypto_top100` while the `us`
    store is mounted quietly returns the US store's copy -- a different set of
    names, presented as the answer to a question about crypto.
    """
    if universe:
        if store:
            symbols = marketdata.store_symbols(store, universe)
            if not symbols:
                raise HTTPException(
                    status_code=404,
                    detail=f"Unknown universe '{universe}' in store '{store}'")
        else:
            qlib_session.require_qlib()
            from qlib.data import D

            try:
                symbols = D.list_instruments(D.instruments(universe), as_list=True)
            except Exception as exc:
                raise HTTPException(status_code=404, detail=f"Unknown universe '{universe}': {exc}") from exc

        symbols = sorted(str(s) for s in symbols)
        if search:
            needle = search.lower()
            symbols = [s for s in symbols if needle in s.lower()]
        catalog = marketdata.load_catalog()["by_symbol"]
        return {
            "universe": universe,
            "total": len(symbols),
            "instruments": [
                {
                    "symbol": s,
                    "name": catalog.get(s.upper(), {}).get("n", s),
                    "asset_class": catalog.get(s.upper(), {}).get("c", "equity"),
                    "exchange": catalog.get(s.upper(), {}).get("x", ""),
                    "store": "qlib",
                }
                for s in symbols[:limit]
            ],
        }

    result = marketdata.search(query=search, asset_class=asset_class, limit=limit)
    return {"universe": None, **result}


@router.get("/calendar")
def calendar(start: str | None = None, end: str | None = None) -> dict:
    qlib_session.require_qlib()
    from qlib.data import D

    days = D.calendar(start_time=start, end_time=end)
    return {
        "count": len(days),
        "start": str(days[0].date()) if len(days) else None,
        "end": str(days[-1].date()) if len(days) else None,
        "days": [str(d.date()) for d in days],
    }


@router.get("/bars/{symbol}")
def bars(
    symbol: str,
    start: str | None = None,
    end: str | None = None,
    adjusted: bool = Query(True, description="false returns the raw traded price ($close/$factor)"),
) -> dict:
    """OHLCV for one instrument, shaped for a candlestick chart.

    Dispatches on the catalog so the frontend never has to know which store
    backs a symbol. Market-store assets are stored as traded -- there is no
    adjustment to undo -- so ``adjusted`` is reported false whatever was asked.
    """
    if marketdata.has_bars(symbol):
        rows = marketdata.bars(symbol.upper(), start, end)
        return {"symbol": symbol.upper(), "adjusted": False, "count": len(rows), "bars": rows}

    qlib_session.require_qlib()
    from qlib.data import D

    # qlib stores back-adjusted, rebased prices; dividing by $factor recovers
    # the price actually traded that day, which is what a user recognises.
    div = "" if adjusted else "/$factor"
    fields = [f"$open{div}", f"$high{div}", f"$low{div}", f"$close{div}", "$volume", "$factor", "$change"]
    names = ["open", "high", "low", "close", "volume", "factor", "change"]

    try:
        df = D.features([symbol.upper()], fields, start_time=start, end_time=end)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Query failed: {exc}") from exc

    if df is None or df.empty:
        return {"symbol": symbol.upper(), "adjusted": adjusted, "count": 0, "bars": []}

    df = df.droplevel("instrument")
    df.columns = names
    out = [
        {
            "time": str(idx.date()),
            **{name: _clean(row[name]) for name in names},
        }
        for idx, row in df.iterrows()
    ]
    return {"symbol": symbol.upper(), "adjusted": adjusted, "count": len(out), "bars": out}


class FeatureQuery(BaseModel):
    instruments: list[str] | str = Field(
        default="top500",
        description="A universe name, or an explicit list of symbols.",
    )
    fields: list[str] = Field(..., description="qlib expressions, e.g. ['$close', 'Mean($close,5)']")
    start: str | None = None
    end: str | None = None


@router.post("/features")
def features(query: FeatureQuery) -> dict:
    """Evaluate arbitrary qlib expressions — the engine's real superpower."""
    qlib_session.require_qlib()
    from qlib.data import D

    if not query.fields:
        raise HTTPException(status_code=400, detail="At least one field expression is required")

    if isinstance(query.instruments, str):
        try:
            symbols = D.list_instruments(D.instruments(query.instruments), as_list=True)
        except Exception as exc:
            raise HTTPException(status_code=404, detail=f"Unknown universe: {exc}") from exc
    else:
        symbols = [s.upper() for s in query.instruments]

    if len(symbols) > MAX_INSTRUMENTS:
        raise HTTPException(
            status_code=400,
            detail=f"{len(symbols)} instruments exceeds the {MAX_INSTRUMENTS} limit for a direct query. "
                   "Narrow the universe, or run it as a strategy instead.",
        )

    try:
        df = D.features(sorted(symbols), query.fields, start_time=query.start, end_time=query.end)
    except Exception as exc:
        # Expression syntax errors land here; the message is the useful part.
        raise HTTPException(status_code=400, detail=f"Expression failed: {exc}") from exc

    if df is None or df.empty:
        return {"count": 0, "columns": query.fields, "rows": []}

    if df.size > MAX_POINTS:
        raise HTTPException(
            status_code=400,
            detail=f"Result has {df.size} values, over the {MAX_POINTS} limit. Shorten the date range.",
        )

    df = df.replace([np.inf, -np.inf], np.nan)
    rows = [
        {
            "instrument": str(inst),
            "date": str(pd.Timestamp(date).date()),
            "values": [_clean(v) for v in row.tolist()],
        }
        for (inst, date), row in df.iterrows()
    ]
    return {"count": len(rows), "columns": list(df.columns), "rows": rows}
