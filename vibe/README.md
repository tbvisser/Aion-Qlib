# Vibe-Trading sidecar

This directory builds the [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)
sidecar used by AION (MIT license — see `THIRD_PARTY_NOTICES.md` at the repo
root). It is **not** a vendored copy of their code: the image pip-installs the
published `vibe-trading-ai` wheel at a pinned version, keeping its heavy
LangChain-era dependency tree fully isolated from the qlib image — the same
reasoning that makes `rag-api` its own image.

## Services (compose project `qlib`)

| Service | Host port | What |
|---|---|---|
| `vibe-api` | `127.0.0.1:8899` | Vibe REST API + agent sessions (their UI's backend) |
| `vibe-mcp` | none (internal) | 64-tool MCP server, streamable HTTP at `http://vibe-mcp:8900/mcp` |

The qlib API (`webapp/api/routers/vibe.py`) exposes a **whitelisted** subset
under `/api/vibe/*`: read-only market data, Alpha Zoo, broker read-only views,
paper trading and shadow accounts. Live order placement is deliberately not
proxied — that seam stays closed until explicitly opened, and vibe's own
mandate gates are a second layer behind it.

## Setup

```sh
cp vibe/.env.example vibe/.env      # fill in API_AUTH_KEY at minimum
# put the same key in webapp/.env as VIBE_API_TOKEN
docker compose -f docker-compose.yml -f docker-compose.dev.yml build vibe-api
# one-time, image is large (LangChain tree)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d vibe-api vibe-mcp
curl http://127.0.0.1:8770/api/vibe/health
```

State (sessions, runs, shadow accounts, memory) persists in the `vibe-home`
named volume at `/home/vibe/.vibe-trading`.

## Version pinning

The wheel is pinned in `vibe/Dockerfile` (`vibe-trading-ai==0.1.13`). Bump it
deliberately: route paths and MCP tool names used by `webapp/api/routers/vibe.py`
were verified against this version.
