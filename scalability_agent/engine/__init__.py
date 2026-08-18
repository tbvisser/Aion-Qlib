"""Engine v1 — strategy fingerprint, venue liquidity, costs, ceiling, ranking.

The ceiling engine (PRD M2–M6) is deliberately pure Python with no platform,
database or qlib imports: Phase 0 validates the calculation from notebooks
against hand-built cases before anything ships, so every module here must run
standalone and deterministically.
"""
