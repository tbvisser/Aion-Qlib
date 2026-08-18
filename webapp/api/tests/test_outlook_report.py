"""Tests for the Aion-branded outlook PDF generator.

These tests never call the LLM or Supabase Storage; they exercise the PDF
layout and markdown conversion directly.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from webapp.api.auth import Principal
from webapp.api.main import app
from webapp.api.outlook_report import render_demo_outlook_pdf, render_outlook_pdf


@pytest.fixture
def client():
    return TestClient(app)


def _principal() -> Principal:
    return Principal(user_id="u1", email="test@example.com", org_id="o1", org_role="member")


def test_render_outlook_pdf_produces_pdf_bytes():
    summary = (
        "**Week outlook (2026-08-10 – 2026-08-16)**\n\n"
        "- The economic calendar is light this week.\n"
        "- *No headline releases* are scheduled.\n"
        "- One recent signal run finished with top picks."
    )
    context = {
        "calendar": {"available": True, "events": [{}, {}, {}]},
        "activity": {"runs": [{}, {}], "jobs": []},
        "rebalances": [{"events": [{}]}],
        "signals": [{}],
    }
    pdf_bytes, pages = render_outlook_pdf(
        summary,
        context,
        "week",
        "2026-08-10",
        _principal(),
    )
    assert pdf_bytes.startswith(b"%PDF")
    assert pages >= 1
    assert len(pdf_bytes) > 1000


def test_render_empty_context_still_produces_pdf():
    summary = "No releases scheduled."
    context = {
        "calendar": {"available": False, "events": []},
        "activity": {"runs": [], "jobs": []},
        "rebalances": [],
        "signals": [],
    }
    pdf_bytes, pages = render_outlook_pdf(
        summary,
        context,
        "day",
        "2026-08-10",
        _principal(),
    )
    assert pdf_bytes.startswith(b"%PDF")
    assert pages >= 1


def test_render_demo_outlook_pdf_produces_pdf_bytes():
    pdf_bytes, pages = render_demo_outlook_pdf(_principal())
    assert pdf_bytes.startswith(b"%PDF")
    assert pages >= 1
    assert len(pdf_bytes) > 1000


def test_demo_download_endpoint_returns_pdf(client):
    resp = client.get("/api/outlook-reports/demo/download")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.content.startswith(b"%PDF")
    assert resp.headers["content-disposition"].endswith("aion-demo-outlook.pdf")
