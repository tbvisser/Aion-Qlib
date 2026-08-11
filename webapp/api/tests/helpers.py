"""Helpers shared by the test modules.

Kept out of `conftest.py` so they can be imported by name rather than injected:
these are plain functions, not fixtures, and a test reads better calling one
than declaring it as an argument.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def walk_schema(node, pointer="#"):
    """Every (keyword, json-pointer, value) in a JSON Schema.

    Objects report themselves as `__object__` so a caller can assert the
    strict-mode rules — `additionalProperties: false` and every property
    required — at every level rather than only the root.
    """
    found = []
    if isinstance(node, dict):
        if node.get("type") == "object" or "properties" in node:
            found.append(("__object__", pointer, node))
        for key, value in node.items():
            found.append((key, pointer, value))
            if key not in ("properties", "required", "enum"):
                found += walk_schema(value, f"{pointer}/{key}")
        for name, value in node.get("properties", {}).items():
            found += walk_schema(value, f"{pointer}/properties/{name}")
    elif isinstance(node, list):
        for i, value in enumerate(node):
            found += walk_schema(value, f"{pointer}/{i}")
    return found


def import_check(module: str, forbidden: str) -> subprocess.CompletedProcess:
    """Assert, in a fresh interpreter, that importing `module` does not reach
    `forbidden` (or any submodule of it).

    A subprocess rather than a `sys.modules` assertion because by the time a test
    runs, half the app has already been imported by some other test.
    """
    return subprocess.run(
        [sys.executable, "-c",
         f"import {module}, sys; "
         f"assert not [m for m in sys.modules if m == {forbidden!r} "
         f"or m.startswith({forbidden!r} + '.')], "
         f"'{module} pulled in {forbidden}'"],
        cwd=REPO_ROOT, capture_output=True, text=True)
