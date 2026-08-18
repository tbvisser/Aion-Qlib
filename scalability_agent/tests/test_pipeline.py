"""Pipeline tests with duck-typed fakes — no database, no network, and a
stubbed report renderer so the engine half never depends on the report half.
"""
from __future__ import annotations

import sys
import types

import pytest

from scalability_agent.engine import pipeline
from scalability_agent.tests.conftest import GENERIC_CSV, IBKR_ROW, UBS_ROW

ORG = "11111111-1111-1111-1111-111111111111"
USER = "22222222-2222-2222-2222-222222222222"
UPLOAD = "33333333-3333-3333-3333-333333333333"
JOB = "44444444-4444-4444-4444-444444444444"


class FakeStorage:
    def __init__(self, files: dict):
        self.files = dict(files)

    def download_bytes(self, bucket: str, path: str) -> bytes:
        return self.files[(bucket, path)]

    def upload_bytes(self, bucket: str, path: str, data: bytes, content_type: str = "application/octet-stream"):
        self.files[(bucket, path)] = data


class FakeDb:
    def __init__(self):
        self.upload = {
            "id": UPLOAD,
            "user_id": USER,
            "org_id": ORG,
            "filename": "trades.csv",
            "storage_path": f"{ORG}/trades.csv",
            "status": "pending",
        }
        self.summary = None
        self.completed: list[tuple] = []
        self.reports: list[dict] = []

    def get_upload(self, upload_id):
        assert upload_id == UPLOAD
        return self.upload

    def latest_parsed_upload(self, user_id):
        assert user_id == USER
        return self.upload

    def set_upload_parsed(self, upload_id, summary):
        self.upload["status"] = "parsed"
        self.summary = summary

    def set_upload_failed(self, upload_id, error):
        self.upload["status"] = "failed"
        self.upload["error"] = error

    def complete_job(self, job_id, report_id=None):
        self.completed.append((job_id, report_id))

    def get_venue_profiles(self, version=None):
        return [IBKR_ROW, UBS_ROW]

    def insert_report(self, user_id, org_id, job_id, upload_id, catalog_version, current_venue, result, artifact_path):
        self.reports.append(locals() | {"self": None})
        return "report-1"


@pytest.fixture
def stub_render(monkeypatch):
    """analyze() imports the renderer lazily; stub it so the engine tests
    never depend on the report module's availability."""
    module = types.ModuleType("scalability_agent.report.render")
    module.render_html = lambda result: f"<html>{result['current_venue']}</html>"
    package = types.ModuleType("scalability_agent.report")
    package.render = module
    monkeypatch.setitem(sys.modules, "scalability_agent.report", package)
    monkeypatch.setitem(sys.modules, "scalability_agent.report.render", module)


def _job(kind: str, **params) -> dict:
    return {
        "id": JOB,
        "kind": kind,
        "user_id": USER,
        "org_id": ORG,
        "upload_id": UPLOAD,
        "params": params,
    }


def test_parse_upload_writes_summary_and_completes():
    db = FakeDb()
    storage = FakeStorage({(pipeline.UPLOADS_BUCKET, f"{ORG}/trades.csv"): GENERIC_CSV.encode()})
    pipeline.parse_upload(_job("parse_upload"), db, storage)
    assert db.upload["status"] == "parsed"
    assert db.summary["n_trades"] == 3
    assert db.summary["parser"] == "generic_csv"
    assert db.summary["symbols"] == ["AAPL", "MSFT"]
    assert db.completed == [(JOB, None)]


def test_parse_upload_marks_failed_on_unparseable_file():
    db = FakeDb()
    storage = FakeStorage({(pipeline.UPLOADS_BUCKET, f"{ORG}/trades.csv"): b"garbage\n1,2,3"})
    with pytest.raises(ValueError):
        pipeline.parse_upload(_job("parse_upload"), db, storage)
    assert db.upload["status"] == "failed"


def test_analyze_end_to_end(stub_render):
    db = FakeDb()
    storage = FakeStorage({(pipeline.UPLOADS_BUCKET, f"{ORG}/trades.csv"): GENERIC_CSV.encode()})
    job = _job("analyze", aum_usd=25_000_000, current_venue="IBKR")
    report_id = pipeline.analyze(job, db, storage)
    assert report_id == "report-1"
    assert db.completed == [(JOB, "report-1")]

    report = db.reports[0]
    assert report["catalog_version"] == 1
    assert report["current_venue"] == "IBKR"
    assert report["artifact_path"] == f"reports/{ORG}/{JOB}.html"
    result = report["result"]
    assert result["engine_version"] == "v1-heuristic"
    best = result["comparison"]["best_alternative"]
    assert best["venue"] == "UBS"
    # Artifact landed in the same bucket as uploads, as HTML.
    artifact = storage.files[(pipeline.UPLOADS_BUCKET, report["artifact_path"])]
    assert b"<html>" in artifact
