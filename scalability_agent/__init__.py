"""Standalone background service that computes fund scalability ceilings.

The platform (``webapp/api``) is the control plane: it stores uploads and
enqueues jobs in ``aion.scalability_jobs``. This package is the data plane:
it polls the jobs table, parses trade uploads (``ingest``), runs the ceiling
engine (``engine``) and writes reports back. The engine and ingest layers are
pure Python with no FastAPI/platform imports so they stay testable without a
database or network.
"""
