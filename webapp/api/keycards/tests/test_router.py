"""Tests for the Keycard router endpoints."""
from __future__ import annotations

import pytest
import yaml
from fastapi.testclient import TestClient

from ...main import app
from ...keycards.models import KeycardSpec, Node, Position, Windows

pytestmark = [pytest.mark.usefixtures("fake_stores"), pytest.mark.usefixtures("_authenticated")]


def _sample_spec(name: str = "Sample") -> KeycardSpec:
    return KeycardSpec(
        name=name,
        description="A test keycard",
        tags=["test"],
        nodes=[
            Node(id="store-1", type="data_store", position=Position(x=0, y=0),
                 config={"store": "us"}),
            Node(id="univ-1", type="universe", position=Position(x=0, y=100),
                 config={"universe": "top500", "benchmark": "SPY"}),
            Node(id="hand-1", type="handler", position=Position(x=0, y=200),
                 config={"handler": "Alpha158"}),
            Node(id="model-1", type="model", position=Position(x=0, y=300),
                 config={"model": "lightgbm"}),
            Node(id="port-1", type="portfolio", position=Position(x=0, y=400),
                 config={"strategy": "TopkDropoutStrategy", "topk": 50, "n_drop": 5}),
            Node(id="costs-1", type="costs", position=Position(x=0, y=500),
                 config={"open_cost": 0.0005, "close_cost": 0.0015, "min_cost": 5.0,
                         "account": 100_000_000}),
            Node(id="rec-1", type="records", position=Position(x=0, y=600), config={}),
        ],
        edges=[
            {"id": "e1", "source": "store-1", "source_port": "data",
             "target": "univ-1", "target_port": "data"},
            {"id": "e2", "source": "univ-1", "source_port": "data",
             "target": "hand-1", "target_port": "data"},
            {"id": "e3", "source": "hand-1", "source_port": "features",
             "target": "model-1", "target_port": "features"},
            {"id": "e4", "source": "model-1", "source_port": "signal",
             "target": "port-1", "target_port": "signal"},
            {"id": "e5", "source": "port-1", "source_port": "trades",
             "target": "costs-1", "target_port": "trades"},
            {"id": "e6", "source": "costs-1", "source_port": "trades",
             "target": "rec-1", "target_port": "trades"},
        ],
        windows=Windows(),
    )


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_node_types_endpoint(client):
    body = client.get("/api/keycards/node-types").json()
    assert "node_types" in body
    ids = {item["id"] for cat in body["node_types"] for item in cat["items"]}
    assert {"data_store", "universe", "handler", "model", "portfolio", "costs", "records"} <= ids


@pytest.mark.usefixtures("needs_db")
def test_create_list_get_delete(client):
    spec = _sample_spec("Router create")
    resp = client.post("/api/keycards", json=spec.model_dump())
    assert resp.status_code == 200, resp.text
    stored = resp.json()
    keycard_id = stored["id"]
    assert stored["name"] == "Router create"

    listed = client.get("/api/keycards").json()["keycards"]
    assert any(k["id"] == keycard_id for k in listed)

    fetched = client.get(f"/api/keycards/{keycard_id}").json()
    assert fetched["id"] == keycard_id

    assert client.delete(f"/api/keycards/{keycard_id}").status_code == 204
    assert client.get(f"/api/keycards/{keycard_id}").status_code == 404


@pytest.mark.usefixtures("needs_db")
def test_create_rejects_blocking_defects(client):
    spec = _sample_spec("Bad").model_copy(deep=True)
    # Introduce a cycle.
    spec.edges.append(spec.edges[-1].model_copy(update={
        "id": "ecycle",
        "source": "rec-1",
        "source_port": "trades",
        "target": "store-1",
        "target_port": "data",
    }))
    resp = client.post("/api/keycards", json=spec.model_dump())
    assert resp.status_code == 400
    assert "cycle" in resp.text.lower()


def test_compile_endpoint(client):
    resp = client.post("/api/keycards/compile", json=_sample_spec("Compile").model_dump())
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["yaml"] is not None
    assert yaml.safe_load(body["yaml"])["qlib_init"]["provider_uri"].endswith("store-us")
    assert isinstance(body["defects"], list)
    assert isinstance(body["warnings"], list)


@pytest.mark.usefixtures("needs_db")
def test_fork_endpoint(client):
    created = client.post("/api/keycards", json=_sample_spec("Fork me").model_dump()).json()
    forked = client.post(f"/api/keycards/{created['id']}/fork").json()
    assert forked["id"] != created["id"]
    assert forked["name"] == "Fork me (copy)"


def test_import_endpoint(client):
    payload = _sample_spec("Import").model_dump()
    payload["unknown_field"] = 123
    resp = client.post("/api/keycards/import", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["spec"]["name"] == "Import"
    assert "unknown_field" in body["unknown_fields"]
    assert isinstance(body["defects"], list)


def test_import_yaml_string(client):
    text = yaml.safe_dump(_sample_spec("YAML import").model_dump())
    resp = client.post("/api/keycards/import", json=text)
    assert resp.status_code == 200, resp.text
    assert resp.json()["spec"]["name"] == "YAML import"
