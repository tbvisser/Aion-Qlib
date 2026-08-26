# Aion MCP server

Streamable-HTTP [Model Context Protocol](https://modelcontextprotocol.io) server exposing a **read-only allowlist** of qlib chat tools. Intended for [Hermes Agent](https://github.com/nousresearch/hermes-agent) and other MCP hosts — not for browser clients.

## Quick start

```bash
# Optional compose overlay (does not start with plain `docker compose up`)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d aion-mcp
curl http://127.0.0.1:8910/health
```

Native dev:

```bash
cp webapp/.env.example webapp/.env   # fill keys as needed
AION_MCP_TOKEN=dev-secret python -m aion_mcp
```

## Authentication

| Mode | Behavior |
|---|---|
| `AION_MCP_TOKEN` unset | Loopback (`127.0.0.1`, `::1`) only |
| `AION_MCP_TOKEN` set | Shared service token **or** user token from `POST /api/hermes/mcp-token` |

User tokens are HMAC-signed, expire in 1 hour, and run DB tools under that user's RLS context.

Hermes (docker network) must set the token — it is not loopback from the server's perspective.

## Service user

Tools that read Postgres (`list_runs`, `get_run_status`, `get_scalability_report`) require:

```bash
AION_MCP_SERVICE_USER_ID=<uuid>
# optional override:
AION_MCP_SERVICE_ORG_ID=<uuid>
```

Qlib-only tools (`get_data_status`, `search_instruments`, …) work without a service user.

## Allowlisted tools

See `webapp/api/mcp_allowlist.py` — the single source of truth.

| Tier | Tools | Behavior |
|---|---|---|
| Read | `get_data_status`, `search_instruments`, … | Execute immediately |
| Confirm | `run_backtest`, `start_scalability_analysis` | Return `needs_confirmation`; approve in Aion UI |
| Blocked | `book_venue_consultation`, `propose_*`, … | Not exposed via MCP |

## Smoke test

```bash
./scripts/smoke-aion-mcp.sh
# Windows:
powershell -ExecutionPolicy Bypass -File scripts/smoke-aion-mcp.ps1
```

## Hermes configuration (local)

Point Hermes at `http://127.0.0.1:8910/mcp` with the Bearer token. For the full
sidecar (gateway + messaging), see [`hermes/README.md`](../hermes/README.md).
