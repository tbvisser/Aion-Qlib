"""Portfolio CRUD, NAV, and the strategies attached to a book.

Mirrors the strategy endpoints in ``runs.py`` -- same status codes, same
``/validate`` -> ``/preview`` analogue.

The store is a per-request dependency rather than a module singleton: a
repository carries the caller's identity, so there is no such thing as one
shared instance any more.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Body, Depends, HTTPException, Response

from .. import portfolio_nav
from ..auth import Principal, get_principal
from ..portfolio_nav import NavError
from ..portfolios import PortfolioSpec, StoredPortfolio
from ..repositories import PortfolioRepo

logger = logging.getLogger(__name__)

router = APIRouter()


def _repo(principal: Principal = Depends(get_principal)) -> PortfolioRepo:
    return PortfolioRepo(principal)


def _require(repo: PortfolioRepo, portfolio_id: str) -> StoredPortfolio:
    try:
        stored = repo.get(portfolio_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if stored is None:
        # Also the answer when it exists but belongs to someone else -- saying
        # "forbidden" would confirm the id is real to a stranger.
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
def list_portfolios(repo: PortfolioRepo = Depends(_repo)) -> dict:
    portfolios = repo.list()
    return {
        "portfolios": [p.model_dump() for p in portfolios],
        "summaries": [_summary(p) for p in portfolios],
    }


@router.post("/portfolios")
def create_portfolio(
    spec: PortfolioSpec, repo: PortfolioRepo = Depends(_repo)
) -> dict:
    problems = spec.validate_holdings()
    if problems:
        raise HTTPException(status_code=400, detail=" ".join(problems))
    return repo.create(spec).model_dump()


@router.post("/portfolios/validate")
def validate_portfolio(spec: PortfolioSpec) -> dict:
    """Dry-run the pricing. The ``/strategies/preview`` analogue.

    Returns warnings and unpriceable symbols without computing a NAV, so the
    editor can tell the user what will happen before they save.
    """
    return portfolio_nav.resolve(spec)


@router.get("/portfolios/{portfolio_id}")
def get_portfolio(
    portfolio_id: str, repo: PortfolioRepo = Depends(_repo)
) -> dict:
    return _require(repo, portfolio_id).model_dump()


@router.put("/portfolios/{portfolio_id}")
def update_portfolio(
    portfolio_id: str, spec: PortfolioSpec, repo: PortfolioRepo = Depends(_repo)
) -> dict:
    _require(repo, portfolio_id)
    problems = spec.validate_holdings()
    if problems:
        raise HTTPException(status_code=400, detail=" ".join(problems))
    updated = repo.update(portfolio_id, spec)
    if updated is None:
        # Readable but not writable: an org-shared book owned by a colleague.
        raise HTTPException(
            status_code=403,
            detail="This portfolio belongs to someone else in your organisation.",
        )
    return updated.model_dump()


@router.put("/portfolios/{portfolio_id}/visibility")
def set_portfolio_visibility(
    portfolio_id: str,
    visibility: str = Body(..., embed=True),
    repo: PortfolioRepo = Depends(_repo),
) -> dict:
    _require(repo, portfolio_id)
    try:
        updated = repo.set_visibility(portfolio_id, visibility)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if updated is None:
        raise HTTPException(
            status_code=403,
            detail="Only the owner can change who this portfolio is shared with.",
        )
    return updated.model_dump()


@router.delete("/portfolios/{portfolio_id}", status_code=204)
def delete_portfolio(
    portfolio_id: str, repo: PortfolioRepo = Depends(_repo)
) -> Response:
    _require(repo, portfolio_id)
    if not repo.delete(portfolio_id):
        raise HTTPException(
            status_code=403,
            detail="This portfolio belongs to someone else in your organisation.",
        )
    return Response(status_code=204)


@router.get("/portfolios/{portfolio_id}/nav")
def portfolio_nav_report(portfolio_id: str, start: str | None = None,
                         end: str | None = None,
                         repo: PortfolioRepo = Depends(_repo)) -> dict:
    stored = _require(repo, portfolio_id)
    try:
        return portfolio_nav.build_nav(
            stored, start=start, end=end,
            portfolio_id=stored.id, updated_at=stored.updated_at,
        )
    except NavError as exc:
        # 409, matching run_report: the portfolio exists, it just cannot be
        # priced over this window.
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/portfolios/{portfolio_id}/rebalances")
def portfolio_rebalances(portfolio_id: str, limit: int = 10,
                         repo: PortfolioRepo = Depends(_repo)) -> dict:
    """The book's recent rebalance events, for the Inbox agenda.

    Unlike ``/nav``, an unpriceable book answers 200 with a reason rather than
    409 — this feeds an aggregate view, and one broken book must not poison
    the whole feed. ``build_nav`` caches by ``(id, updated_at)``, so after the
    first compute this is a dict slice.
    """
    stored = _require(repo, portfolio_id)
    limit = max(1, min(limit, 50))
    base = {"portfolio_id": stored.id, "name": stored.name,
            "rebalance": stored.rebalance}
    if stored.rebalance == "none":
        return {**base, "rebalances": []}
    try:
        report = portfolio_nav.build_nav(
            stored, portfolio_id=stored.id, updated_at=stored.updated_at,
        )
    except NavError as exc:
        return {**base, "rebalances": [], "reason": str(exc)}
    return {**base, "rebalances": report["rebalances"][-limit:]}


@router.get("/portfolios/{portfolio_id}/strategies")
def portfolio_strategies(
    portfolio_id: str,
    repo: PortfolioRepo = Depends(_repo),
    principal: Principal = Depends(get_principal),
) -> dict:
    """The linked strategies, each with its latest run.

    Without the run status ``strategy_ids`` is just a list of names; with it
    the /book page can say "this one has never run" and link somewhere useful.
    """
    from ..repositories import StrategyRepo
    # Reuse the runs router's RunManager; a second one would keep a divergent
    # in-memory cache of the same run records.
    from .runs import _runs as runs

    stored = _require(repo, portfolio_id)
    strategies = StrategyRepo(principal)
    # `list` already returns the run metadata dicts. The default limit of 100
    # would start hiding older runs once a few strategies have been iterated on.
    all_runs = runs.list(principal, limit=1000)

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
