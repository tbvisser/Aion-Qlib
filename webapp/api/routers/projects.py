"""Project CRUD.

Mirrors ``portfolios.py`` -- same status codes, same ``_require`` helper turning
a bad id into a 400 and a missing one into a 404.

There is no ``/validate`` analogue and no member resolution here. A project's
ids are opaque to this service (see ``projects.py``); the browser already holds
clients for every store they point into, and resolving them server-side would
put a Supabase dependency in a router that has never needed one.

The store is a per-request dependency rather than a module singleton: a
repository carries the caller's identity, so there is no such thing as one
shared instance any more.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Body, Depends, HTTPException, Response

from ..auth import Principal, get_principal
from ..projects import ProjectSpec, StoredProject
from ..repositories import ProjectRepo

logger = logging.getLogger(__name__)

router = APIRouter()


def _repo(principal: Principal = Depends(get_principal)) -> ProjectRepo:
    return ProjectRepo(principal)


def _require(repo: ProjectRepo, project_id: str) -> StoredProject:
    try:
        stored = repo.get(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if stored is None:
        # Also the answer when the project exists but belongs to someone else.
        # Distinguishing the two would confirm the id is real to a stranger.
        raise HTTPException(status_code=404, detail=f"Unknown project '{project_id}'")
    return stored


@router.get("/projects")
def list_projects(repo: ProjectRepo = Depends(_repo)) -> dict:
    return {"projects": [p.model_dump() for p in repo.list()]}


@router.post("/projects")
def create_project(spec: ProjectSpec, repo: ProjectRepo = Depends(_repo)) -> dict:
    return repo.create(spec).model_dump()


@router.get("/projects/{project_id}")
def get_project(project_id: str, repo: ProjectRepo = Depends(_repo)) -> dict:
    return _require(repo, project_id).model_dump()


@router.put("/projects/{project_id}")
def update_project(
    project_id: str, spec: ProjectSpec, repo: ProjectRepo = Depends(_repo)
) -> dict:
    _require(repo, project_id)
    updated = repo.update(project_id, spec)
    if updated is None:
        # Readable but not writable: an org-shared project owned by a colleague.
        raise HTTPException(
            status_code=403,
            detail="This project belongs to someone else in your organisation.",
        )
    return updated.model_dump()


@router.put("/projects/{project_id}/visibility")
def set_project_visibility(
    project_id: str,
    visibility: str = Body(..., embed=True),
    repo: ProjectRepo = Depends(_repo),
) -> dict:
    _require(repo, project_id)
    try:
        updated = repo.set_visibility(project_id, visibility)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if updated is None:
        raise HTTPException(
            status_code=403,
            detail="Only the owner can change who this project is shared with.",
        )
    return updated.model_dump()


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str, repo: ProjectRepo = Depends(_repo)) -> Response:
    _require(repo, project_id)
    if not repo.delete(project_id):
        raise HTTPException(
            status_code=403,
            detail="This project belongs to someone else in your organisation.",
        )
    return Response(status_code=204)
