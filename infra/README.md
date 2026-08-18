# infra

The Supabase stack the platform authenticates and stores user data against.

It lives in `infra/supabase/` as its own compose file, but uses the same
project name as the platform (`aion-qlib`) so Docker Desktop groups Studio,
Kong, Postgres, `api`, `ui`, RAG, Vibe and the agent under one heading. The
backend shares that project's default network and reaches `supabase-db-aq`
by container name.

```powershell
powershell -ExecutionPolicy Bypass -File infra\stack.ps1 up       # supabase, then platform
powershell -ExecutionPolicy Bypass -File infra\stack.ps1 status
powershell -ExecutionPolicy Bypass -File infra\stack.ps1 down     # platform only; supabase stays
powershell -ExecutionPolicy Bypass -File infra\stack.ps1 logs api
```

Or by hand:

```powershell
# Supabase
Set-Location infra\supabase
docker compose up -d

# Platform
Set-Location <repo root>
docker compose up -d
```

Do not add `--remove-orphans` to a root `docker compose down`: both files share
project `aion-qlib`, so that flag would stop Supabase as well.

`stack.ps1 up` waits until Postgres accepts connections before starting the
API. Skip that wait and the API serves errors until you restart it, because it
resolves every caller's organisation out of that database.

| | |
|---|---|
| UI | http://127.0.0.1:5274 |
| API (qlib) | http://127.0.0.1:8770/api/health |
| RAG | http://127.0.0.1:8001/health |
| Vibe | http://127.0.0.1:8899/health |
| Scalability agent | http://127.0.0.1:8771/health |
| Supabase Studio / Kong | http://127.0.0.1:8010 |
| Postgres (host) | `127.0.0.1:5442` (supavisor pooler) |
| Postgres (containers) | `supabase-db-aq:5432` |

`down` stops the platform (api, ui, rag, vibe, agent). To stop Supabase:

```powershell
Set-Location infra\supabase
docker compose down     # never add -v: that deletes the database
```

## Why it is gitignored

`infra/supabase/` is excluded in `.gitignore`, `.dockerignore` and
`Dockerfile.dev.dockerignore`. It is an upstream compose project, not our source:
it carries its own `.env` full of keys, a live Postgres data directory, and the
storage bucket contents. `rag/INSTALL.md` advises keeping Supabase outside the
repo for exactly these reasons.

Nothing here is a backup. `infra/supabase/volumes/db/data` is the database.

## What lives where

- `infra/supabase/` — the server: compose file, `.env`, `volumes/` (Postgres
  data, storage buckets, Kong config). Untracked.
- `rag/supabase/migrations/` — **our** schema, which is versioned. Applied with
  `rag\scripts\run-migrations-local.ps1 -ContainerName supabase-db-aq`.

Similar names, unrelated things: one is the database server, the other is what
we apply to it.
