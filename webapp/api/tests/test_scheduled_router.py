"""Tests for the scheduled-task router."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from webapp.api.main import app

pytestmark = [pytest.mark.usefixtures("needs_db")]

client = TestClient(app)


def _task(name: str = "Test task", kind: str = "macro_refresh", enabled: bool = True, **kwargs):
    return {
        "name": name,
        "kind": kind,
        "schedule": {"frequency": "weekdays", "time": "07:00"},
        "params": {"what": "all"},
        "enabled": enabled,
        **kwargs,
    }


def test_create_and_list():
    create = client.post("/api/scheduled/tasks", json=_task())
    assert create.status_code == 200
    data = create.json()
    assert data["name"] == "Test task"
    assert data["kind"] == "macro_refresh"
    assert data["enabled"] is True
    assert data["next_run"] is not None

    list_resp = client.get("/api/scheduled/tasks")
    assert list_resp.status_code == 200
    tasks = list_resp.json()["tasks"]
    assert any(t["id"] == data["id"] for t in tasks)


def test_get():
    created = client.post("/api/scheduled/tasks", json=_task()).json()
    get = client.get(f"/api/scheduled/tasks/{created['id']}")
    assert get.status_code == 200
    assert get.json()["id"] == created["id"]


def test_get_unknown_is_404():
    resp = client.get("/api/scheduled/tasks/notreal")
    assert resp.status_code == 404


def test_update_recomputes_next_run():
    created = client.post("/api/scheduled/tasks", json=_task()).json()
    first_next = created["next_run"]

    updated = client.put(
        f"/api/scheduled/tasks/{created['id']}",
        json=_task(schedule={"frequency": "daily", "time": "02:00"}),
    )
    assert updated.status_code == 200
    assert updated.json()["next_run"] != first_next


def test_delete():
    created = client.post("/api/scheduled/tasks", json=_task()).json()
    delete = client.delete(f"/api/scheduled/tasks/{created['id']}")
    assert delete.status_code == 204
    assert client.get(f"/api/scheduled/tasks/{created['id']}").status_code == 404


def test_toggle():
    created = client.post("/api/scheduled/tasks", json=_task()).json()
    assert created["enabled"] is True

    off = client.post(f"/api/scheduled/tasks/{created['id']}/toggle", json={"enabled": False})
    assert off.status_code == 200
    assert off.json()["enabled"] is False
    assert off.json()["next_run"] is None

    on = client.post(f"/api/scheduled/tasks/{created['id']}/toggle", json={"enabled": True})
    assert on.status_code == 200
    assert on.json()["enabled"] is True
    assert on.json()["next_run"] is not None


def test_admin_kinds_require_admin_override():
    # The autouse fixture overrides require_org_admin, so these succeed in tests.
    # The check itself is exercised by test_auth_required.py for the live routes.
    resp = client.post("/api/scheduled/tasks", json=_task(kind="data_refresh", params={"universe_size": 100, "mode": "update"}))
    assert resp.status_code == 200


def test_run_strategy_requires_strategy_id():
    resp = client.post("/api/scheduled/tasks", json=_task(kind="run_strategy", params={}))
    assert resp.status_code == 422


def test_invalid_schedule_rejected():
    resp = client.post(
        "/api/scheduled/tasks",
        json=_task(schedule={"frequency": "weekly", "time": "07:00"}),
    )
    assert resp.status_code == 422
