# infra

The Supabase stack the platform authenticates and stores user data against.

It is **part of the same compose project** as everything else: the root
`docker-compose.yml` pulls it in with `include:`, so `docker compose` from the
repo root drives all 19 containers, and Docker Desktop shows one stack.

```powershell
docker compose up -d          # works, but see the note on start order
docker compose ps
docker compose logs -f api
```

`stack.ps1` is a thin convenience over the same commands:

```powershell
powershell -ExecutionPolicy Bypass -File infra\stack.ps1 up      # start, in order
powershell -ExecutionPolicy Bypass -File infra\stack.ps1 status
powershell -ExecutionPolicy Bypass -File infra\stack.ps1 down
powershell -ExecutionPolicy Bypass -File infra\stack.ps1 logs api
```

The only thing it adds is a wait: the API resolves every caller's organisation
out of Supabase's Postgres, so starting it first leaves it serving errors until
someone restarts it — which looks like a bug in the app rather than a race.

| | |
|---|---|
| UI | http://127.0.0.1:5274 |
| qlib API | http://127.0.0.1:8770/api/health |
| Supabase Studio / Kong | http://127.0.0.1:8010 |
| Postgres (host) | `127.0.0.1:5442` (supavisor pooler) |
| Postgres (containers) | `supabase-db-aq:5432` |

## The two things that make the merge safe

Folding another project's compose file into yours is not free. Two details in
the root `docker-compose.yml` are load-bearing, and both are easy to "tidy away"
without noticing:

**1. `project_directory: ./infra/supabase` on the `include:`.** Supabase's compose
uses relative bind mounts — `./volumes/db/data` *is* the database. Without this,
they resolve against the repo root and Postgres starts on an empty directory.

**2. `db-config` and `deno-cache` are declared `external`.** Compose prefixes
named volumes with the project name, so merging would otherwise point these at
fresh, empty `aion-qlib_*` volumes. `db-config` holds `pgsodium_root.key`, the
root encryption key for Vault: an empty volume means Postgres mints a **new**
key and anything encrypted under the old one is unrecoverable. Pinning them
external also means `docker compose down -v` cannot delete them.

If Postgres ever comes up looking empty, check those two before anything else.

## Why it is gitignored

`infra/supabase/` is excluded in `.gitignore`, `.dockerignore` and
`Dockerfile.dev.dockerignore`. It is an upstream compose project, not our source:
it carries its own `.env` full of keys, a live Postgres data directory, and the
storage bucket contents. `rag/INSTALL.md` advises keeping Supabase outside the
repo for exactly these reasons — ignoring it addresses them while still letting
the whole platform run as one stack.

Nothing here is a backup. `infra/supabase/volumes/db/data` is the database.

## What lives where

- `infra/supabase/` — the server: compose file, `.env`, `volumes/` (Postgres
  data, storage buckets, Kong config). Untracked.
- `rag/supabase/migrations/` — **our** schema, which is versioned. Applied with
  `rag\scripts\run-migrations-local.ps1 -ContainerName supabase-db-aq`.

Similar names, unrelated things: one is the database server, the other is what
we apply to it.
