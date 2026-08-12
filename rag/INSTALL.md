# Installation Guide

This guide walks you through setting up the project from scratch.

## Python Version Compatibility

This project has been tested with **Python 3.11** and **Python 3.12**. It will likely work with **3.13**, but **Python 3.14 may require dependency updates** (notably `pydantic` and other compiled packages).

> If you're running into cryptic install or runtime errors, check your Python version first. Either switch to 3.11/3.12 or update the affected dependency versions.

---

## Prerequisites

Before starting, make sure you have the following installed:

| Tool | Version | Notes |
|------|---------|-------|
| Python | 3.11 – 3.13 | See note above about 3.14 |
| Node.js | 18+ | For the frontend |
| Docker Desktop | Latest | Required for local Supabase and/or code sandbox |
| Git | Any recent version | |
| uv | Latest | Python package installer (much faster than pip) |

### Install uv

uv is a fast Python package manager. Install it before setting up the backend:

```bash
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

---

## 1. Clone the Repository

```bash
git clone https://github.com/tbvisser/Aion-RAG.git
cd Aion-RAG
```

### Review CLAUDE.md

If you use Claude Code (or any AI coding tool that reads `CLAUDE.md`), review this file before starting development. It contains project conventions and configuration that Claude Code follows, but some values are specific to the original development environment and may need updating for yours:

- **Supabase project path** — points to a local directory (e.g. `C:\Users\User\Projects\Supabase\supabase-project`). Update this to match where you installed Supabase, or remove it if you're using Supabase Cloud.
- **Local vs Cloud Supabase** — the file assumes a local Docker-based Supabase setup. If you're using Supabase Cloud, update the relevant sections.
- **Test credentials** — default test accounts are listed. These only apply to local Supabase; cloud projects will have their own users.

If you skip this step, Claude Code may make assumptions about your setup that don't match reality (wrong paths, wrong database connection, etc.).

---

## 2. Supabase Setup

> **🤖 AI coding agents — STOP and READ THIS FIRST.** If you are an AI coding agent (Claude Code, Cursor, Codex, etc.) carrying out this setup, you **must actually open and read** the official Supabase [Self-Hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker) guide — *fetch the page and follow it* — before running any Supabase step. Do **not** improvise the installation from training data, and do **not** skip the page. The project-specific notes in this file only *supplement* the official guide; they do **not** replace it. Skipping the official guide produces a broken or misconfigured Supabase stack.

You have two options: **Local (self-hosted via Docker)** or **Supabase Cloud**.

### Option A: Local Supabase (Docker Compose)

This is the recommended approach for development. Follow the official **[Self-Hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker)** guide to get Supabase running locally, with the following project-specific notes:

> **Important:** Install Supabase in a **separate folder** outside this repository. Do **not** clone it inside the project directory. Keeping Supabase separate avoids `.gitignore` headaches, prevents AI coding agents (Claude Code, Cursor, etc.) from accidentally modifying Supabase source files, and keeps the repo clean. This project already has its own `supabase/migrations/` folder for database migration SQL files — that's unrelated to the Supabase Docker installation.

Your directory structure should look something like this:
```
~/Projects/
├── agentic-rag-app/          # This repo (may differ if you renamed it)
│   ├── backend/
│   ├── frontend/
│   ├── supabase/migrations/  # App migration SQL files (part of this repo)
│   └── ...
└── Supabase/
    └── supabase/             # Supabase Docker installation (separate)
        └── docker/
            ├── .env
            ├── docker-compose.yml
            └── volumes/
```

> **Do NOT use `supabase start`** (the CLI). It creates a second set of containers on different ports (54321/54322) that conflicts with the docker-compose stack. Use `docker compose up -d` as described in the official guide.

Once Supabase is running, verify by opening http://localhost:8000 in your browser (Studio dashboard).

#### Enable the MCP Endpoint (Required for Local Development)

The Supabase MCP server is how Claude Code and other AI coding tools interact with your database — running queries, applying migrations during development, inspecting tables, etc. You need to enable local access to the MCP endpoint in your Kong configuration.

In your **separate** Supabase docker directory (e.g. `~/Projects/Supabase/supabase/docker`), edit `volumes/api/kong.yml`.

> **Note:** Recent Supabase releases already ship the `mcp` route in `kong.yml`, **disabled by default** (it returns `403` via a `request-termination` plugin). **Do not add a new `mcp` route** — a second route with the same name breaks Kong. Instead, *enable the existing one* by toggling its plugins as shown below, following `kong.yml`'s own inline comments. (There is also a separate `mcp-blocker` route that blocks direct `/api/mcp` access — leave it as-is.)

**First, find your Docker gateway IP.** This is the IP address your host machine uses to communicate with Docker containers. You need it for the `ip-restriction` config below.

```bash
docker network inspect supabase_default --format "{{range .IPAM.Config}}{{.Gateway}}{{end}}"
```

This prints just the IP, e.g. `172.18.0.1`. If it returns nothing, the network name may differ — list your networks and look for the Supabase one:

```bash
docker network ls
# Find the one with "supabase" in the name, then:
docker network inspect <network_name> --format "{{range .IPAM.Config}}{{.Gateway}}{{end}}"
```

**Then enable the existing `mcp` route.** Find the `## MCP endpoint - local access` block in `kong.yml`. By default its `plugins` section blocks all access via `request-termination`, with inline comments explaining how to open it. Following those comments: **comment out** the `request-termination` plugin, **uncomment** the `cors` + `ip-restriction` plugins, and add your Docker gateway IP to the `allow` list (replacing `172.18.0.1` if yours is different). The enabled result should look like this:

```yaml
  ## MCP endpoint - local access
  - name: mcp
    _comment: 'MCP: /mcp -> http://studio:3000/api/mcp (local access)'
    url: http://studio:3000/api/mcp
    routes:
      - name: mcp
        strip_path: true
        paths:
          - /mcp
    plugins:
      # Block access to /mcp by default
      #- name: request-termination
      #  config:
      #    status_code: 403
      #    message: "Access is forbidden."
      # Enable local access (danger zone!)
      - name: cors
      - name: ip-restriction
        config:
          allow:
            - 127.0.0.1
            - ::1
            - 172.18.0.1   # <-- your Docker gateway IP from the step above
          deny: []
```

After editing, restart the Kong container:
```bash
docker compose restart kong
```

#### Verify MCP is Working

```bash
curl http://localhost:8000/mcp
```

You should get a response (not a 403 or connection error).

> **Claude Code users:** If Claude Code reports it cannot access the Supabase MCP tools, exit Claude Code completely and re-enter it. The MCP server configuration is loaded on startup, so changes to Kong won't be picked up until Claude Code restarts.

### Option B: Supabase Cloud

1. Create a project at [supabase.com](https://supabase.com)
2. Note your project URL, anon key, and service role key from the project settings
3. You'll use these values in the `.env` files below

---

## 3. Environment Variables

### Backend

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` and fill in the **required** fields:

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Your Supabase project URL (local: `http://localhost:8000`) |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `LLM_MODEL` | Yes | Chat model (e.g., `gpt-4o`) |
| `LLM_API_KEY` | Yes | API key for your LLM provider |
| `EMBEDDING_API_KEY` | Yes | API key for embeddings (OpenAI) |

Everything else is optional and can be configured later. The `.env.example` file has descriptions for all available options including reranking, web search, PII redaction, observability, and code sandbox.

### Optional: use a ChatGPT/Codex subscription for inference

Instead of paying per token via `LLM_API_KEY`, you can route the **main chat and
agent loops** through an existing ChatGPT/Codex subscription (Plus/Pro/Team).

1. Install the official Codex CLI and sign in. This writes and auto-refreshes
   `~/.codex/auth.json`, which the backend reads — the app never implements the
   browser login itself:
   ```bash
   npm i -g @openai/codex
   codex login
   ```
2. In `backend/.env`, set:
   ```
   LLM_PROVIDER=codex
   CODEX_MODEL=gpt-5.5            # must be a model your plan can use (cf. ~/.codex/config.toml)
   # CODEX_REASONING_EFFORT=xhigh # optional: minimal|low|medium|high|xhigh
   ```
3. Restart the backend (`powershell -File scripts/restart-backend.ps1`).

**Keep `LLM_*` and `EMBEDDING_*` configured** (e.g. OpenRouter + OpenAI). Codex
powers only the user-facing chat and the deep/explorer/sub-agent loops; the
high-volume utility calls (citation verification, PII redaction, metadata
extraction, history compaction, thread-title generation) and **all embeddings**
keep using those providers. This split is deliberate — a ChatGPT plan's rolling
message quota is small relative to how many LLM calls a single turn makes, so
spending it only on primary inference keeps the app usable.

- When `LLM_PROVIDER=codex`, analyze/explorer/task sub-agents use `CODEX_MODEL`
  with medium reasoning. `SUB_AGENT_*` still applies on the OpenAI-compatible path.
- Caveat: the Codex backend is an **undocumented endpoint** that can change
  without notice, and using it to power a non-Codex app may conflict with
  OpenAI's terms. Set `LLM_PROVIDER=` (empty) to revert to the standard
  OpenAI-compatible API path at any time.

### Frontend

```bash
cd frontend
cp .env.example .env
```

Edit `frontend/.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SUPABASE_URL` | Yes | Same as backend `SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | Yes | Same as backend `SUPABASE_ANON_KEY` |
| `VITE_API_URL` | Yes | Backend URL (default: `http://localhost:8001`) |
| `VITE_BRAND` | No | `aion` (default) or `mercer-hartwell` |

---

## 4. Database Migrations

All migration files live in `supabase/migrations/` and follow the naming convention `YYYYMMDDHHMMSS_description.sql`. The migration scripts track what has been applied in `supabase_migrations.schema_migrations` — they skip already-applied migrations and are safe to re-run.

### Option A: Local Supabase (Docker Compose)

The local migration script runs SQL directly inside the Postgres Docker container, bypassing the connection pooler:

#### Fresh database (first-time setup)

```powershell
powershell -File scripts/run-migrations-local.ps1
```

This will:
- Connect to the `supabase-db` Docker container (use `-ContainerName` if yours differs)
- Check which migrations have already been applied
- Apply only the new ones in order
- Track applied migrations in `supabase_migrations.schema_migrations`

#### Existing database (migrations previously applied via MCP)

> **Background:** If migrations were previously applied one-at-a-time using the Supabase MCP tool (e.g. via Claude Code), they were recorded in the tracking table with different version numbers than the migration file names. The script matches by migration name rather than version, but some MCP-applied migrations may have been recorded under slightly different names. Running the script against an existing database may try to re-apply migrations that are already present, causing errors like `"column already exists"` or `"policy already exists"`.

**Before running on an existing database, back up first:**
```bash
docker exec supabase-db pg_dump -U supabase_admin -d postgres > backup_before_migration.sql
```

Then sync the tracking table to register all migration files as already-applied:
```powershell
powershell -File scripts/run-migrations-local.ps1 -Sync
```

This does **not** run any SQL against your data — it only updates the tracking table so the script knows these migrations are already in the database. After syncing, normal runs will correctly skip everything:

```powershell
powershell -File scripts/run-migrations-local.ps1
# Output: "All 41 migrations already applied. Database is up to date."
```

Going forward, any new migration files added to `supabase/migrations/` will be picked up and applied automatically.

### Option B: Supabase Cloud

The cloud migration script uses the Supabase CLI (`npx supabase db push`):

```powershell
# First time: link your project (you'll be prompted for your database password)
powershell -File scripts/run-migrations-cloud.ps1 -ProjectRef "your-project-ref"

# Subsequent runs (already linked)
powershell -File scripts/run-migrations-cloud.ps1
```

You can preview what would be applied without making changes:
```powershell
powershell -File scripts/run-migrations-cloud.ps1 -DryRun
```

> **Note:** You may need to run `npx supabase login` first to authenticate with Supabase Cloud.

---

## 5. Backend Setup

```bash
cd backend
```

### Create Virtual Environment and Install Dependencies

Using **uv** (recommended - significantly faster than pip):

```bash
uv venv venv
source venv/Scripts/activate   # Windows (Git Bash)
# source venv/bin/activate     # macOS/Linux
uv pip install -r requirements.txt
```

Using pip (slower alternative):

```bash
python -m venv venv
source venv/Scripts/activate   # Windows (Git Bash)
# source venv/bin/activate     # macOS/Linux
pip install -r requirements.txt
```

### Verify Backend Starts

```powershell
powershell -File scripts/start-backend.ps1
```

Check health:
```bash
curl http://localhost:8001/health
# Should return: {"status":"ok"}
```

---

## 6. Frontend Setup

```bash
cd frontend
npm install
```

### Verify Frontend Starts

```powershell
powershell -File scripts/start-frontend.ps1
```

Open http://localhost:5173 in your browser.

---

## 7. Start Everything

Once both are set up, you can start all services at once:

```powershell
powershell -File scripts/start-all.ps1
```

Other useful scripts:

| Script | Description |
|--------|-------------|
| `scripts/stop-all.ps1` | Stop both services |
| `scripts/restart-all.ps1` | Restart both services |
| `scripts/restart-backend.ps1` | Restart backend only (useful after code changes) |
| `scripts/restart-frontend.ps1` | Restart frontend only |
| `scripts/run-migrations-local.ps1` | Apply pending DB migrations (local Docker Supabase) |
| `scripts/run-migrations-cloud.ps1` | Apply pending DB migrations (Supabase Cloud) |
| `scripts/test-all.ps1` | Run backend + frontend tests |
| `scripts/test-backend.ps1` | Run backend pytest tests |
| `scripts/test-frontend.ps1` | Run frontend Playwright E2E tests |

---

## 8. Running Tests

### All Tests

```powershell
powershell -File scripts/test-all.ps1
```

### Backend (pytest)

```powershell
powershell -File scripts/test-backend.ps1
```

See `backend/tests/README.md` for markers, fixtures, and test organization.

### Frontend (Playwright)

```bash
cd frontend
npx playwright install   # First time only - installs browsers
```

```powershell
powershell -File scripts/test-frontend.ps1
```

See `frontend/tests/README.md` for auth flow and test structure.

---

## 9. Agent Browser Setup (Optional)

[agent-browser](https://github.com/vercel-labs/agent-browser) is a CLI tool that Claude Code uses for ad-hoc UI exploration during development — clicking elements, filling forms, taking screenshots, etc. It is **not** used for automated tests (Playwright handles that).

```bash
npm install -g agent-browser
```

> **Windows note:** On Windows, you may need to set the `AGENT_BROWSER_HOME` environment variable. See the `CLAUDE.md` "Development Browser Tool" section for usage examples and the required env var path.

---

## 10. Code Sandbox Setup

The app can execute Python code in a sandboxed Docker container — useful for skills that generate files (PowerPoint, CSV, charts, etc.).

**Prerequisites:**

```bash
# Build the custom sandbox image
docker build -t sandbox-python:latest backend/sandbox/
```

**Enable** by setting in `backend/.env`:
```
SANDBOX_ENABLED=true
```

Optional configuration (defaults shown):
```
SANDBOX_MAX_EXECUTION_TIME=60
SANDBOX_MAX_MEMORY_MB=512
SANDBOX_SESSION_TTL_MINUTES=30
SANDBOX_CONTAINER_IMAGE=sandbox-python:latest
SANDBOX_MAX_CONCURRENT_SESSIONS=5
```

---

## Troubleshooting

### "Could not find column in schema cache"
The migration was applied but Supabase PostgREST cache is stale. Restart the backend:
```powershell
powershell -File scripts/restart-backend.ps1
```

### npm commands produce no output on Windows
This happens in MINGW/Git Bash. Always use PowerShell for npm and service commands.

### Python dependency errors
Check your Python version. This project requires 3.11 or 3.12. Python 3.14+ may need dependency updates (especially pydantic).

### Docker networking issues (local Supabase)
If MCP or Supabase connections fail, verify your Docker gateway IP matches what's in the Kong config (see step 2, "Find your Docker gateway IP").
