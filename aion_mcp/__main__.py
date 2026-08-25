"""Run the Aion MCP server: ``python -m aion_mcp``."""
from __future__ import annotations

import os

import uvicorn

from .server import create_app


def main() -> None:
    port = int(os.environ.get("AION_MCP_PORT", "8910"))
    uvicorn.run(create_app(), host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
