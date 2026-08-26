# Hermes Agent sidecar

Optional [Hermes Agent](https://github.com/nousresearch/hermes-agent) gateway for
Aion-Qlib. Hermes orchestrates the **Aion MCP** and **Vibe MCP** servers, adds
cross-session memory, natural-language cron, and messaging (Telegram, Discord, …).

This is a **thin wrapper** around the official `nousresearch/hermes-agent` image —
same isolation pattern as `vibe/` and `rag/`. Hermes never ships inside the qlib
API image.

**Pinned image:** `nousresearch/hermes-agent:v2026.8.19` (see `Dockerfile`).

## Quick start

```bash
cp hermes/.env.example hermes/.env
# Fill OPENROUTER_API_KEY, AION_MCP_TOKEN, VIBE_API_TOKEN (match webapp/.env)

docker compose -f docker-compose.yml -f docker-compose.dev.yml build hermes-gateway
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d aion-mcp hermes-gateway vibe-mcp
```

Verify:

```bash
curl http://127.0.0.1:8910/health          # Aion MCP
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f hermes-gateway
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec hermes-gateway hermes gateway status
```

## Architecture

```
hermes-gateway  ──MCP──►  aion-mcp:8910   (qlib read tools)
                ──MCP──►  vibe-mcp:8900   (Alpha Zoo, market data)
```

On first boot the entrypoint seeds:

| File | Purpose |
|---|---|
| `/hermes-data/config.yaml` | Model, MCP servers, tool guardrails |
| `/hermes-data/workspace/AGENTS.md` | Aion domain context |
| `/hermes-data/gateway-config.yaml` | Messaging platforms (empty by default) |
| `/hermes-data/.env` | Merged from compose env |

State persists in the `hermes-home` named volume (mounted at `/hermes-data`; `/opt/data` symlinks there).

## Ports

| Port | Service |
|---|---|
| `8910` | Aion MCP (`aion-mcp`) |
| `8642` | Hermes gateway API / health (optional; published when gateway runs) |
| `9119` | Hermes dashboard (only when `HERMES_DASHBOARD=1`) |

## Environment variables

See `hermes/.env.example`. Critical keys:

| Variable | Must match |
|---|---|
| `AION_MCP_TOKEN` | `webapp/.env` |
| `VIBE_API_TOKEN` | `webapp/.env` (`API_AUTH_KEY` in `vibe/.env`) |
| `OPENROUTER_API_KEY` | Hermes LLM (independent of Aion chat) |

Compose also loads `webapp/.env` into `hermes-gateway`, so shared keys can live
in one file if you prefer.

## Messaging (optional)

1. Uncomment platform blocks in `gateway-config.yaml` (or edit the live copy under
   the `hermes-home` volume after first boot).
2. Set `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` in `hermes/.env`.
3. Restart: `docker compose … restart hermes-gateway`.

See [Hermes messaging docs](https://hermes-agent.nousresearch.com/docs/user-guide/messaging).

## Platform wiring (Agents & Skills)

When the gateway runs, enable it in the Aion API so the roster and console card
probe it without a timeout when the service is off:

```bash
# webapp/.env
HERMES_GATEWAY_ENABLED=true
HERMES_GATEWAY_URL=http://hermes-gateway:8642   # API probe on compose network
HERMES_BRIDGE_TOKEN=…                           # optional: cron → scheduled tasks bridge
```

- **Roster:** one `agent:hermes:hermes-gateway` row (only when enabled)
- **UI:** Agents tab → Agent consoles → Hermes gateway status card
- **UI:** Agents tab → MCP approvals (Tier-1 confirm tools)
- **API:** `GET /api/hermes/health`, `POST /api/hermes/mcp-token`
- **Bridge:** `POST /api/hermes/bridge/scheduled-tasks` (Bearer `HERMES_BRIDGE_TOKEN`)

### User-scoped MCP (P4-A)

Authenticated users call `POST /api/hermes/mcp-token` and pass the returned Bearer
token to `aion-mcp` instead of the shared `AION_MCP_TOKEN`. DB-backed tools then
run under that user's RLS context.

### Scheduled task bridge (P4-C)

Hermes natural-language cron can POST to `/api/hermes/bridge/scheduled-tasks` with:

```json
{
  "user_id": "<uuid>",
  "org_id": "<uuid>",
  "spec": {
    "name": "Weekly outlook",
    "kind": "outlook_report",
    "schedule": {"frequency": "weekly", "time": "07:00", "day": "mon"},
    "params": {"scope": "week"},
    "enabled": true
  }
}
```

Shared data refreshes (`macro_refresh`, `data_refresh`) are rejected — use the Aion UI.

## Cron examples

Copy-paste starters in `config/cron-examples.md` — not auto-installed.

## Native Hermes (without Docker)

Install Hermes locally ([install docs](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)),
point MCP config at `http://127.0.0.1:8910/mcp`, and set the Bearer token from
`webapp/.env`. Run `aion-mcp` via compose or `python -m aion_mcp`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Gateway exits immediately | Check `docker logs hermes-gateway`; ensure `OPENROUTER_API_KEY` is set |
| `mkdir: Permission denied` on `/hermes-data` | Reset volume: `docker volume rm aion-qlib_hermes-home` and recreate; ensure shell scripts use LF (see `.gitattributes`) |
| `entrypoint.sh: no such file` | CRLF line endings — re-checkout `hermes/scripts/*.sh` with LF |
| Roster/API shows unreachable while `hermes gateway status` is OK | Set `HERMES_GATEWAY_URL=http://hermes-gateway:8642` in `webapp/.env` (not `127.0.0.1` from inside the API container) |
| MCP tools fail with 401 | Set matching `AION_MCP_TOKEN` / `VIBE_API_TOKEN` in compose env |
| `list_runs` errors | Set `AION_MCP_SERVICE_USER_ID` on `aion-mcp` (see `aion_mcp/README.md`) |
| Vibe tools unreachable | Start `vibe-mcp` (`docker compose up -d vibe-mcp vibe-api`) |

Smoke tests: `scripts/smoke-aion-mcp.ps1` and `scripts/smoke-hermes.ps1`.

## Upgrade Hermes version

1. Bump `HERMES_VERSION` in `hermes/Dockerfile`.
2. Rebuild: `docker compose … build hermes-gateway`.
3. Run smoke tests and check [Hermes release notes](https://github.com/nousresearch/hermes-agent/releases).
