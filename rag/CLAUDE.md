# CLAUDE.md

Full Stack AI Agent Platform with chat (default) and document ingestion interfaces. Config via env vars, no admin UI.

> **First-time setup?** See [INSTALL.md](INSTALL.md) for full installation instructions.

## Stack
- Frontend: React + Vite + Tailwind + shadcn/ui
- Backend: Python + FastAPI
- Database: Supabase (Postgres, pgvector, Auth, Storage, Realtime)
- LLM: OpenAI (Module 1), OpenRouter (Module 2+)
- Observability: LangSmith

## Rules
- No LangChain, no LangGraph - raw SDK calls only
- Use Pydantic for structured LLM outputs
- All tables need Row-Level Security - users only see their own data
- Stream chat responses via SSE
- Use Supabase Realtime for ingestion status updates
- Module 2+ uses stateless completions - store and send chat history yourself
- Ingestion is manual file upload only - no connectors or automated pipelines

## Planning
- Save all plans to `.agent/plans/` folder
- Naming convention: `{sequence}.{plan-name}.md` (e.g., `1.auth-setup.md`, `2.document-ingestion.md`)
- Plans should be detailed enough to execute without ambiguity
- Each task in the plan must include at least one validation test to verify it works
- Assess complexity and single-pass feasibility - can an agent realistically complete this in one go?
- Include a complexity indicator at the top of each plan:
  - ✅ **Simple** - Single-pass executable, low risk
  - ⚠️ **Medium** - May need iteration, some complexity
  - 🔴 **Complex** - Break into sub-plans before executing

## Development Flow
1. **Plan** - Create a detailed plan and save it to `.agent/plans/`
2. **Build** - Execute the plan to implement the feature
3. **Validate** - Run pytest and Playwright tests. Use agent-browser for ad-hoc UI exploration
4. **Iterate** - Fix any issues found during validation

## Pull Requests
`master` on `origin` is **branch-protected — you cannot push to it or merge into it directly; every change lands via a PR.** `gh` is **not installed** here. For this local dev machine only, an ignored `PULL-REQUESTS.md` file may exist with copy-paste GitHub REST API steps that use the token Git Credential Manager already holds. That file is machine-specific local guidance, must stay out of git, and should not be treated as project documentation.

## Managing Services

**Important:** On Windows with MINGW/Git Bash, npm commands produce no output. Always use PowerShell for npm and service commands.

### Service Scripts
All scripts are in the `scripts/` folder. Run with: `powershell -File scripts/<script>.ps1`

| Script | Description |
|--------|-------------|
| `start-all.ps1` | Start both backend and frontend in new windows |
| `start-backend.ps1` | Start backend only (http://localhost:8001) |
| `start-frontend.ps1` | Start frontend only (http://localhost:5173) |
| `stop-all.ps1` | Stop both services |
| `stop-backend.ps1` | Stop backend only |
| `stop-frontend.ps1` | Stop frontend only |
| `restart-all.ps1` | Restart both services |
| `restart-backend.ps1` | Restart backend only |
| `restart-frontend.ps1` | Restart frontend only |
| `setup-worktree.ps1` | Provision THIS worktree's own ports + `.env` + test accounts for parallel agents, then auto-start its services (`-NoStart` to skip; see [WORKTREES.md](WORKTREES.md)) |
| `remove-worktree.ps1` | Safely remove a worktree — stops its services, deletes its test accounts, then unlinks the shared venv/node_modules junctions before removal |
| `gc-test-users.ps1` | Reap orphaned per-worktree test accounts (keeps live worktrees + main) |
| `test-all.ps1` | Run backend + frontend tests (skips slow) |
| `test-backend.ps1` | Run backend pytest tests |
| `test-frontend.ps1` | Run frontend Playwright E2E tests |
| `run-migrations-local.ps1` | Apply pending DB migrations (local Docker Supabase) |
| `run-migrations-cloud.ps1` | Apply pending DB migrations (Supabase Cloud) |

### Quick Commands
```powershell
# Start all services
powershell -File scripts/start-all.ps1

# Restart backend (after code changes)
powershell -File scripts/restart-backend.ps1

# Stop everything
powershell -File scripts/stop-all.ps1
```

### Verify Services
- Backend health: `curl http://localhost:8001/health` should return `{"status":"ok"}`
  (main checkout's port; in a worktree run `powershell -File scripts/health-check.ps1` to hit that worktree's port)
- Frontend: Open http://localhost:5173 in browser (main checkout; worktrees use their own port)

## Worktrees & parallel agents — read WORKTREES.md

> **If you are working in a git worktree, or running parallel agents, you MUST read
> [WORKTREES.md](WORKTREES.md) first.** It is the single source of truth for the
> dev/worktree workflow: port isolation, the shared DB + shared venv model, per-worktree
> test accounts, landing work (local merge), and the safe-removal gotchas. Don't duplicate
> that content here - keep it in WORKTREES.md.
>
> **Mandatory for AI coding agents:** after creating or entering any git worktree,
> provision the worktree dev environment before creating or switching branches,
> starting services, running tests, editing code, or using the browser. Claude Code:
> invoke `/worktree-dev-env`. Codex: invoke `$worktree-dev-env` (or choose
> **Worktree Dev Environment** from `/skills`). Manual fallback command:
> `powershell -ExecutionPolicy Bypass -File scripts/setup-worktree.ps1`. If
> `.worktree-ports.json` already exists, run
> `powershell -ExecutionPolicy Bypass -File scripts/health-check.ps1` and confirm the
> worktree ports/env are provisioned before continuing.

The essentials (full detail in WORKTREES.md):
- **Main checkout** uses canonical ports `8001`/`5173`; **each worktree** gets a unique
  `+offset`, recorded in `.worktree-ports.json`. Claude Code agents provision once with
  `/worktree-dev-env`; Codex agents provision once with `$worktree-dev-env`; use
  `powershell -ExecutionPolicy Bypass -File scripts/setup-worktree.ps1` as the manual
  fallback.
- **Shared, not isolated:** all worktrees + the main checkout use the **one local Supabase
  DB** (`:8000`) and the **one `backend/venv`**. Data is global — a **migration or
  `pip install` from any worktree affects everyone**. Coordinate; avoid destructive DDL in
  parallel. (Test accounts are the exception — each worktree provisions its own.)
- **Removing a worktree:** Claude Code: invoke `/worktree-dev-remove`; Codex: invoke
  `$worktree-dev-remove` (or choose **Remove Worktree** from `/skills`); manual fallback
  `powershell -ExecutionPolicy Bypass -File scripts/remove-worktree.ps1`. It deletes the
  worktree's test accounts and unlinks the shared venv/node_modules junctions first.
  **Never** recursive-delete a worktree that still has those junctions
  (`Remove-Item -Recurse`/Explorer) or you'll wipe the shared venv.

## Supabase (Local Self-Hosted)

This project uses a **local self-hosted Supabase instance** running in Docker.

### Supabase Project Location
- **Path:** `/Users/thomasvisser/Aion-RAG/supabase-local`
- **Kong API Gateway:** http://localhost:8100
- **Studio Dashboard:** http://localhost:8100 (requires basic auth — credentials in `supabase-local/.env`)
- **Docker project name:** `aionrag` (containers named `aionrag-db`, `aionrag-kong`, etc.)

### Starting Supabase
**Always use `sh run.sh start`** (or `docker compose up -d`) from the Supabase project directory. Do NOT use `supabase start` (CLI) — it creates a second set of containers on different ports that conflict.

```bash
cd /Users/thomasvisser/Aion-RAG/supabase-local
sh run.sh start   # start all services
sh run.sh stop    # stop all services
```

Note: Ports are offset from the standard 8000 because another Supabase instance (Aion Platform) runs on port 8000. This project uses **8100** (Kong), **5533** (Postgres session), **6643** (Postgres transaction).

### Supabase MCP
The Supabase MCP server is configured and available. Use the `mcp__supabase-local__*` tools for:
- `execute_sql` - Run SQL queries (main tool for database access)
- `apply_migration` - Apply DDL migrations
- `search_docs` - Search Supabase documentation
- `get_project_url` - Get project URL
- `list_migrations` - List applied migrations

Note: `list_tables` may fail due to read-only user auth - use `execute_sql` as workaround.

## Supabase Migrations

**CRITICAL: Every database schema change MUST have a corresponding migration file.** Never apply DDL changes (CREATE TABLE, ALTER TABLE, CREATE FUNCTION, CREATE POLICY, CREATE INDEX, storage buckets, etc.) directly to the database without a migration. This includes changes made via the Supabase Studio dashboard or raw SQL. If it changes the schema, it needs a migration file in `supabase/migrations/`.

### Creating Migrations
1. Create a new SQL file in `supabase/migrations/` with naming convention: `YYYYMMDDHHMMSS_description.sql`
2. Write your SQL (e.g., `ALTER TABLE`, `CREATE TABLE`, etc.)
3. Apply it using one of the methods below

### Applying Migrations
**During development** (single migration): Use the Supabase MCP `apply_migration` tool to apply individual migrations as you build features.

**Bulk apply** (fresh setup or catching up): Use the migration scripts which apply all pending migrations at once:
```bash
# Local Docker Compose Supabase (macOS)
bash scripts/mac-run-migrations-local.sh --container aionrag-db

# Local Docker Compose Supabase (Windows PowerShell)
powershell -File scripts/run-migrations-local.ps1

# Supabase Cloud
powershell -File scripts/run-migrations-cloud.ps1
```

### Schema Cache Issues
If you get errors like `Could not find the 'column_name' column in the schema cache`, the migration was applied but Supabase's PostgREST cache is stale. Restart the backend to resolve:
```bash
# macOS
bash scripts/mac-restart-backend.sh
# Windows
powershell -File scripts/restart-backend.ps1
```

## Test Credentials
Test-user credentials live in `backend/.env` (gitignored), **not** in source. Set
them (see `backend/.env.example`); the backend pytest API suite and the Playwright
E2E setup read them from the environment:
- `TEST_USER1_EMAIL` / `TEST_USER1_PASSWORD` — primary test user (admin)
- `TEST_USER2_EMAIL` / `TEST_USER2_PASSWORD` — second user, for data-isolation tests

Emails default to `test@test.com` / `test2@test.com` (the **main checkout's** accounts);
passwords are never stored in the repo. **Worktrees auto-provision their own per-worktree
accounts** at setup so parallel test runs don't collide on the shared DB — see
[WORKTREES.md](WORKTREES.md) → "Per-worktree test accounts".

## Testing

- **Backend (pytest):** See `backend/tests/README.md` for setup, fixtures, markers, and running tests
- **Frontend E2E (Playwright):** See `frontend/tests/README.md` for setup, auth flow, and running tests
- When building new features, add pytest API tests and/or Playwright E2E tests as appropriate
- Run backend tests: `cd backend && source venv/Scripts/activate && pytest`
- Run frontend tests: `cd frontend && npm run test:e2e`
- **During story development:** Run only story-related tests per task to keep the feedback loop fast. Run the full regression suite **once** at story completion (not after every task).

## Development Browser Tool (agent-browser)

For ad-hoc UI exploration during development, use `agent-browser` CLI (not for CI — use Playwright for automated E2E tests):

```bash
# Navigate to a page
AGENT_BROWSER_HOME="/c/Users/User/AppData/Roaming/npm/node_modules/agent-browser" agent-browser open http://localhost:5173

# Get interactive elements (for finding selectors)
AGENT_BROWSER_HOME="/c/Users/User/AppData/Roaming/npm/node_modules/agent-browser" agent-browser snapshot -i

# Click an element by reference
AGENT_BROWSER_HOME="/c/Users/User/AppData/Roaming/npm/node_modules/agent-browser" agent-browser click @e1

# Fill a form field
AGENT_BROWSER_HOME="/c/Users/User/AppData/Roaming/npm/node_modules/agent-browser" agent-browser fill @e3 "text value"

# Take a screenshot
AGENT_BROWSER_HOME="/c/Users/User/AppData/Roaming/npm/node_modules/agent-browser" agent-browser screenshot ./screenshot.png

# Get current URL
AGENT_BROWSER_HOME="/c/Users/User/AppData/Roaming/npm/node_modules/agent-browser" agent-browser get url

# Wait for element or time
AGENT_BROWSER_HOME="/c/Users/User/AppData/Roaming/npm/node_modules/agent-browser" agent-browser wait 3000
```

**Note:** The `AGENT_BROWSER_HOME` environment variable is required on Windows.

## Progress
Check PROGRESS.md for current module status. Update it as you complete tasks.

# Notes

The Python Virtual Environment is located in the folder /backend/venv/ NOT .venv
