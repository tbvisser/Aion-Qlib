"""Turning a description of a strategy into one the engine can run.

The dependency runs one way only: this package imports ``strategies``, never the
reverse. ``strategies`` is on the run path -- ``routers/runs.py`` and
``chat_tools.py`` both import it to launch real backtests -- and keeping
generation out of it is what lets the engine be exercised with no generator in
the process at all.

``draft`` is the deterministic floor: no LLM, no network, and the only module
here that anything on the run path is allowed to depend on.
"""
