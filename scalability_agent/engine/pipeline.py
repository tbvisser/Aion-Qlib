"""Job orchestration: parse uploads and run the ceiling analysis end-to-end.

Both entry points are called by the agent worker after it has claimed a job.
``db`` and ``storage`` are duck-typed (see ``scalability_agent/agent/db.py``
and ``storage.py``) so the engine pipeline stays testable with fakes — this
module must never import the agent service or the platform.

Failures propagate: the worker catches, records, and decides on retry. Job
rows carry the parameters in ``params`` jsonb; keys consumed here:

- ``upload_id`` (uuid str) — falls back to the job's ``upload_id`` column.
- ``aum_usd`` (number, optional) — fund's current AUM; sharpens turnover and
  eligibility. Without it both degrade to documented defaults.
- ``current_venue`` (text, optional, default ``"IBKR"``).
- ``catalog_version`` (int, optional) — defaults to the latest catalog version.
"""
from __future__ import annotations

from scalability_agent import ingest
from scalability_agent.engine import compare
from scalability_agent.engine.profile import build_profile

UPLOADS_BUCKET = "scalability-uploads"

_DISCLAIMER = (
    "Ceiling figures are v1 heuristic estimates with stated methodology and "
    "confidence bands; they are not investment advice."
)


def _job_upload_id(job: dict) -> str:
    upload_id = job.get("upload_id") or (job.get("params") or {}).get("upload_id")
    if not upload_id:
        raise ValueError(f"job {job.get('id')} has no upload_id")
    return upload_id


def _load_trades(db, storage, upload: dict) -> tuple[list, str]:
    data = storage.download_bytes(UPLOADS_BUCKET, upload["storage_path"])
    return ingest.parse_trades(upload.get("filename") or "upload.csv", data)


def _summarize(trades: list, parser: str) -> dict:
    """The "what we understood" preview the fund confirms before analysis."""
    per_symbol: dict[str, dict] = {}
    for trade in trades:
        entry = per_symbol.setdefault(trade.symbol, {"trades": 0, "notional_usd": 0.0})
        entry["trades"] += 1
        entry["notional_usd"] += trade.notional
    start = min(t.timestamp for t in trades)
    end = max(t.timestamp for t in trades)
    return {
        "parser": parser,
        "n_trades": len(trades),
        "n_symbols": len(per_symbol),
        "symbols": sorted(per_symbol),
        "total_notional_usd": sum(t.notional for t in trades),
        "date_range": {"start": start.isoformat(), "end": end.isoformat()},
        "per_symbol": per_symbol,
    }


def parse_upload(job: dict, db, storage) -> None:
    """Parse the uploaded trade file and record the derived summary.

    On success: upload row -> 'parsed', job -> 'succeeded'. Any exception
    leaves status handling to the worker's retry logic; the upload row is
    marked 'failed' only when the file itself is unparseable.
    """
    upload = db.get_upload(_job_upload_id(job))
    try:
        trades, parser = _load_trades(db, storage, upload)
    except Exception as exc:
        db.set_upload_failed(upload["id"], str(exc))
        raise
    db.set_upload_parsed(upload["id"], _summarize(trades, parser))
    db.complete_job(job["id"])


def analyze(job: dict, db, storage) -> str:
    """Run the ceiling engine for one upload and persist the report.

    Reads the raw file again rather than the summary — the summary is a
    fund-facing preview, the engine needs the trades themselves. Returns the
    new report id.
    """
    params = job.get("params") or {}
    upload_id = job.get("upload_id") or params.get("upload_id")
    upload = db.get_upload(upload_id) if upload_id else db.latest_parsed_upload(job["user_id"])
    if upload is None:
        raise ValueError(f"job {job.get('id')}: no parsed upload available")
    trades, _parser = _load_trades(db, storage, upload)

    aum_usd = params.get("aum_usd")
    current_venue = params.get("current_venue", "IBKR")
    venue_rows = db.get_venue_profiles(params.get("catalog_version"))
    catalog_version = max(row.get("version") or 0 for row in venue_rows)

    profile = build_profile(trades, aum_usd=aum_usd)
    comparison = compare.compare_venues(venue_rows, current_venue, profile, aum_usd)
    result = {
        "engine_version": "v1-heuristic",
        "catalog_version": catalog_version,
        "current_venue": comparison["current_venue"],
        "aum_usd": aum_usd,
        "strategy": profile.to_dict(),
        "comparison": comparison,
        "disclaimer": _DISCLAIMER,
    }

    # Imported lazily: the report renderer is a separate module (and a
    # separate deliverable) — the engine must not depend on it at import time.
    from scalability_agent.report.render import render_html

    artifact_path = f"reports/{job['org_id']}/{job['id']}.html"
    storage.upload_bytes(
        UPLOADS_BUCKET, artifact_path, render_html(result).encode("utf-8"), "text/html"
    )
    report_id = db.insert_report(
        user_id=job["user_id"],
        org_id=job["org_id"],
        job_id=job["id"],
        upload_id=upload["id"],
        catalog_version=catalog_version,
        current_venue=comparison["current_venue"],
        result=result,
        artifact_path=artifact_path,
    )
    db.complete_job(job["id"], report_id=report_id)
    return report_id
