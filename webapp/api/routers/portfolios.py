"""Portfolio CRUD, NAV, and the strategies attached to a book.

Mirrors the strategy endpoints in ``runs.py`` -- same status codes, same
module-level store singleton, same ``/validate`` -> ``/preview`` analogue.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Response

from .. import portfolio_nav
from ..config import get_settings
from ..portfolio_nav import NavError
from ..portfolios import PortfolioSpec, PortfolioStore, StoredPortfolio

logger = logging.getLogger(__name__)

router = APIRouter()

_settings = get_settings()
_store = PortfolioStore(_settings.portfolios_dir)


def _require(portfolio_id: str) -> StoredPortfolio:
    try:
        stored = _store.get(portfolio_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if stored is None:
        raise HTTPException(status_code=404, detail=f"Unknown portfolio '{portfolio_id}'")
    return stored


def _summary(stored: StoredPortfolio) -> dict:
    return {
        "id": stored.id,
        "name": stored.name,
        "base_ccy": stored.base_ccy,
        "benchmark": stored.benchmark,
        "n_holdings": len(stored.holdings),
        "rebalance": stored.rebalance,
        "inception": stored.inception,
        "strategy_ids": stored.strategy_ids,
        "created_at": stored.created_at,
        "updated_at": stored.updated_at,
    }


@router.get("/portfolios")
def list_portfolios() -> dict:
    portfolios = _store.list()
    return {
        "portfolios": [p.model_dump() for p in portfolios],
        "summaries": [_summary(p) for p in portfolios],
    }


@router.post("/portfolios")
def create_portfolio(spec: PortfolioSpec) -> dict:
    problems = spec.validate_holdings()
    if problems:
        raise HTTPException(status_code=400, detail=" ".join(problems))
    return _store.create(spec).model_dump()


@router.post("/portfolios/validate")
def validate_portfolio(spec: PortfolioSpec) -> dict:
    """Dry-run the pricing. The ``/strategies/preview`` analogue.

    Returns warnings and unpriceable symbols without computing a NAV, so the
    editor can tell the user what will happen before they save.
    """
    return portfolio_nav.resolve(spec)


@router.get("/portfolios/{portfolio_id}")
def get_portfolio(portfolio_id: str) -> dict:
    return _require(portfolio_id).model_dump()


@router.put("/portfolios/{portfolio_id}")
def update_portfolio(portfolio_id: str, spec: PortfolioSpec) -> dict:
    _require(portfolio_id)
    problems = spec.validate_holdings()
    if problems:
        raise HTTPException(status_code=400, detail=" ".join(problems))
    updated = _store.update(portfolio_id, spec)
    if updated is None:  # pragma: no cover - _require already 404s
        raise HTTPException(status_code=404, detail=f"Unknown portfolio '{portfolio_id}'")
    return updated.model_dump()


@router.delete("/portfolios/{portfolio_id}", status_code=204)
def delete_portfolio(portfolio_id: str) -> Response:
    _require(portfolio_id)
    _store.delete(portfolio_id)
    return Response(status_code=204)


@router.get("/portfolios/{portfolio_id}/nav")
def portfolio_nav_report(portfolio_id: str, start: str | None = None,
                         end: str | None = None) -> dict:
    stored = _require(portfolio_id)
    try:
        return portfolio_nav.build_nav(
            stored, start=start, end=end,
            portfolio_id=stored.id, updated_at=stored.updated_at,
        )
    except NavError as exc:
        # 409, matching run_report: the portfolio exists, it just cannot be
        # priced over this window.
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/portfolios/{portfolio_id}/strategies")
def portfolio_strategies(portfolio_id: str) -> dict:
    """The linked strategies, each with its latest run.

    Without the run status ``strategy_ids`` is just a list of names; with it
    the /book page can say "this one has never run" and link somewhere useful.
    """
    from ..strategies import StrategyStore
    # Reuse the runs router's RunManager; a second one would keep a divergent
    # in-memory cache of the same run records.
    from .runs import _runs as runs

    stored = _require(portfolio_id)
    strategies = StrategyStore(_settings.strategies_dir)
    # `list` already returns the run metadata dicts. The default limit of 100
    # would start hiding older runs once a few strategies have been iterated on.
    all_runs = runs.list(limit=1000)

    out = []
    for strategy_id in stored.strategy_ids:
        try:
            spec = strategies.get(strategy_id)
        except ValueError:
            spec = None
        mine = [m for m in all_runs if m.get("strategy_id") == strategy_id]
        latest = max(mine, key=lambda m: m.get("created_at") or "") if mine else None
        out.append({
            "strategy_id": strategy_id,
            "name": spec.name if spec else None,
            # True when the id is in `strategy_ids` but the strategy is gone --
            # a dangling link is worth showing, not hiding.
            "missing": spec is None,
            "model": spec.model if spec else None,
            "handler": spec.handler if spec else None,
            "universe": spec.universe if spec else None,
            "latest_run": (
                {"id": latest["id"], "status": latest.get("status"),
                 "created_at": latest.get("created_at")} if latest else None
            ),
            "run_count": len(mine),
        })
    return {"portfolio_id": stored.id, "strategies": out}
