# Worktrees & Parallel Dev Workflow

How this project runs **multiple git worktrees in parallel** (e.g. several AI coding
agents at once) without the servers, ports, or processes colliding — while deliberately
**sharing** the heavy, stable things (the Python venv and the database).

> TL;DR: each worktree = its own **code + branch + ports**, but a **shared database**
> and a **shared Python venv**. AI coding agents MUST provision the worktree dev
> environment once per worktree before any branch, service, test, code, or browser
> work. Claude Code: `/worktree-dev-env`. Codex: `$worktree-dev-env`. Manual fallback:
> `powershell -ExecutionPolicy Bypass -File scripts/setup-worktree.ps1`.

---

## 1. The mental model

A git worktree gives each branch its own working directory while sharing one `.git`
store. That isolates **code** but not the **runtime** — by default every worktree would
fight over `localhost:8001` / `5173` and the one local database. This project closes that
gap with a thin port-isolation layer, while keeping the expensive bits shared.

| Thing | Per-worktree (isolated) | Shared (one instance) |
|---|:---:|:---:|
| Source code + branch | ✅ | |
| Backend / frontend / bridge **ports** | ✅ (`+offset`) | |
| Server **process** + window title | ✅ (`RAG-Backend-<wt>`) | |
| `backend/.env` / `frontend/.env` | ✅ (own copy) | |
| **Supabase database** (`:8000`) | | ✅ one DB, shared data |
| **Python venv** (`backend/venv`, ~5.8 GB) | | ✅ junction to main |
| `frontend/node_modules` | ✅ junction to main by default | ✅ unless skipped |

**Why shared, not isolated, for the DB and venv:** the venv is ~5.8 GB (torch alone is
4.2 GB) and the local Supabase stack is one Docker deployment. Duplicating either per
worktree would cost tens of GB / multiple container stacks. We accept shared state there
and isolate only what actually collides: ports and processes.

---

## 2. Ports

- **Main checkout** uses the canonical ports: backend `8001`, frontend `5173`.
- **Each worktree** gets a unique **offset** (a multiple of 10): backend `8001+offset`,
  frontend `5173+offset`. The first worktree is typically `+10` (`8011` / `5183`), the
  next `+20`, and so on.
- The sandbox bridge has **no separate port** — its router is mounted on the backend app
  (`main.py`), so it already rides the worktree's isolated backend port.
- The assignment is recorded in `<worktree>/.worktree-ports.json` (gitignored). The
  start/stop/restart/health scripts read it automatically.

Find a worktree's ports:

```powershell
Get-Content .worktree-ports.json
powershell -File scripts/health-check.ps1   # also pings that worktree's backend
```

---

## 3. Per-worktree setup (run once)

**Mandatory first action for AI coding agents:** after creating or entering a git
worktree, provision the worktree dev environment before creating or switching
branches, starting services, running tests, editing code, or opening the app in a
browser. The git worktree already exists at this point; this step configures repo
runtime details inside it.

- Claude Code: invoke `/worktree-dev-env`.
- Codex: invoke `$worktree-dev-env` (or choose **Worktree Dev Environment** from `/skills`).
- Manual fallback: use the PowerShell commands below.

If `.worktree-ports.json` already exists, run
`powershell -ExecutionPolicy Bypass -File scripts/health-check.ps1` and confirm the
worktree is provisioned before continuing.

```powershell
# from inside the worktree, if not using /worktree-dev-env or $worktree-dev-env:
powershell -ExecutionPolicy Bypass -File scripts/setup-worktree.ps1
```

That single command:
1. Picks a free port offset (skipping offsets used by sibling worktrees and live ports).
2. Copies `backend/.env` + `frontend/.env` from the **main checkout** (so the worktree
   points at the same shared Supabase DB) and rewrites the port keys: `CORS_ORIGINS`
   (backend) and `VITE_API_URL` (frontend).
3. **Junctions `backend/venv`** to the main checkout's venv — shared, zero copy.
4. **Provisions this worktree's own test accounts** (`test-wt-<tag>@test.com` admin +
   `test2-wt-<tag>@test.com`) and writes their creds into this worktree's `backend/.env`,
   so the test suites here don't fight other worktrees over the shared DB (see §5).
5. Writes `.worktree-ports.json`.
6. **Starts this worktree's services** (backend + frontend, each in its own window). Pass `-NoStart` to skip.

Flags:
- `-NoLinkNodeModules` — skip sharing `frontend/node_modules` if this worktree needs
  its own frontend dependency install.
- `-LinkNodeModules` — accepted for older commands; sharing frontend deps is now the default.
- `-NoLinkVenv` — give this worktree its own isolated venv instead of sharing.
- `-NoTestUsers` — skip per-worktree test-account provisioning (inherit main's creds).
- `-NoStart` — skip auto-starting the services after provisioning.
- `-Offset N` — pin a specific offset. `-Force` — re-provision an existing worktree.

---

## 4. Running a worktree's stack

Provisioning (`setup-worktree.ps1`) already auto-starts the stack. Use these to restart, or
to start after provisioning with `-NoStart`:

```powershell
powershell -File scripts/start-all.ps1       # backend + frontend on THIS worktree's ports
powershell -File scripts/restart-backend.ps1 # restart just this worktree's backend
powershell -File scripts/stop-all.ps1        # stop just this worktree's servers
```

Each server runs in a window titled `RAG-Backend-<worktree>` / `RAG-Frontend-<worktree>`,
and the stop scripts target **this worktree's port and title only**.

### Does restarting one worktree affect another? No.

Each worktree's backend is a **separate process on a different port** with a
**worktree-specific window title**. `stop`/`restart` scripts kill by *that* port and
title, so restarting worktree A's backend (`8011`) never touches worktree B's (`8021`)
or the main checkout's (`8001`). `uvicorn --reload` watches each worktree's own `backend/`
source, so a code edit in A reloads only A.

**The one coupling to remember:** the venv and DB are shared. A plain restart is fully
isolated, but:
- `pip install` in one worktree changes the **shared venv** for all (a later restart in
  another worktree picks up the change).
- Any **migration** or data change hits the **shared database** for everyone.

See the shared-state notes below before doing either while other agents are working.

---

## 5. Shared database — important

Every worktree and the main checkout talk to the **same** local Supabase DB on
`http://localhost:8000`. Ports are isolated; **data is not**:

- Test rows, inserts, and **deletes** are visible to every worktree and the main checkout.
- A **migration applied from any worktree changes the shared schema for all of them** —
  coordinate migrations; don't run conflicting/destructive DDL in parallel.
- There is no per-worktree data isolation by design (no cloud branching, no per-worktree
  Docker stack). Treat the database as global, shared state.

(See `CLAUDE.md` → Supabase Migrations for the migration policy.)

### Per-worktree test accounts (so parallel test runs don't collide)

The one place the shared DB *is* isolated per worktree is **test accounts**. Both suites
(pytest API + Playwright E2E) wipe **all** threads/folders for the logged-in user at
session start, so if every worktree logged in as the same `test@`/`test2@` accounts,
parallel regression runs would delete each other's data. So:

- The **main checkout** keeps `test@test.com` / `test2@test.com`.
- **Each worktree** provisions its own pair at `setup-worktree.ps1` time:
  `test-wt-<tag>@test.com` (admin) and `test2-wt-<tag>@test.com` (non-admin), `<tag>` =
  worktree leaf. The generated creds are written into this worktree's `backend/.env` as
  `TEST_USER1/2_*`, which both suites already read — **no test code changes**; the suites
  here simply use them.
- `remove-worktree.ps1` deletes the accounts (and their data). If a worktree was removed
  the unsafe way, or provisioning half-failed, reap orphans anytime:
  ```powershell
  powershell -File scripts/gc-test-users.ps1   # keeps live worktrees + main; deletes the rest
  ```
- Mechanics: `backend/scripts/provision_test_users.py` (Supabase admin API via the service
  role) creates / password-rotates / deletes; `is_admin` is set programmatically on user1
  (the signup trigger always writes `is_admin=false`).

> **Residual:** distinct accounts isolate **per-user** data (threads, folders, documents,
> messages). They do **not** isolate **global** tables — notably `global_settings` is a
> single admin-managed row, so tests that mutate it (e.g. model-config) can still race
> across parallel worktrees. Don't run those concurrently, or snapshot/restore around them.

---

## 6. Shared venv — important

- The venv lives at **`backend/venv`** (NOT `.venv` — see §8). In a worktree it's a
  junction to the main checkout's venv, so all worktrees share one ~5.8 GB environment.
- A `pip install` / dependency change from any worktree lands in the shared venv for all.
  That's usually what you want for parallel agents on one dependency set; if a branch
  needs *different* dependency versions, provision that worktree with `-NoLinkVenv` to
  give it an isolated venv.
- `frontend/node_modules` is a few hundred MB and is shared by default via a junction to
  the main checkout. Pass `-NoLinkNodeModules` only when a worktree needs an isolated
  frontend dependency install.

---

## 7. Landing work (local merge, solo-dev flow)

This is a single-developer project, so worktree branches are merged **locally** into
`master` from the main checkout — no PR round-trip.

```powershell
# 1. commit in the worktree
git add -A; git commit -m "feat: ..."

# 2. merge from the MAIN checkout (which stays parked on master)
cd "C:\Users\Owner\Projects\TAIA Full Stack AI Platform\agentic-rag-app"
git merge <worktree-branch>
git push origin master            # optional: publish/backup

# 3. clean up (from the main checkout). Claude Code: invoke /worktree-dev-remove;
#    Codex: invoke $worktree-dev-remove. It stops this worktree's services, deletes its
#    test accounts, UNLINKS the shared venv / node_modules junctions BEFORE removal, then
#    removes the worktree + deletes the branch. Manual fallback:
powershell -File scripts/remove-worktree.ps1 -Path ".claude/worktrees/<name>" -DeleteBranch
```

Do **not** `git checkout master` inside a worktree — master lives in the main checkout.

> ⚠️ **Never** delete a worktree that still has the shared-dep junctions with
> `Remove-Item -Recurse`, `rm -rf`, or Explorer. On Windows that **follows** the
> `backend/venv` / `frontend/node_modules` junction and deletes the **main checkout's**
> copy (wiping the shared ~5.8 GB venv for every worktree). `remove-worktree.ps1` unlinks
> the junctions first — always use it, or `cmd /c rmdir` the junctions by hand before any
> recursive delete.

---

## 8. `venv` vs `.venv`

Use **`backend/venv`**. That is where the environment actually lives, what the service
scripts activate, and what `CLAUDE.md` mandates ("located in `/backend/venv/` NOT
`.venv`"). The only `.venv` references in the repo are the `.gitignore` safety-net (which
ignores both spellings) and notes explicitly telling you *not* to use `.venv`.

---

## 9. Windows / tooling gotchas

- **PowerShell scripts must be ASCII-only.** Windows PowerShell 5.1 reads BOM-less `.ps1`
  files as ANSI, so an em dash or smart quote inside a code string corrupts the parse.
  Use plain `-` and straight quotes.
- **npm / `Write-Host` produce no output under MINGW/Git Bash.** Run service scripts in
  PowerShell (their windows show output); use `Write-Output` if you need a value captured.
- **One stack per port.** You can't run two backends on `8001` — that's the whole point of
  per-worktree offsets. The main checkout owns the canonical ports; worktrees own theirs.
- **Tests follow the worktree's ports.** `test-frontend.ps1` auto-points Playwright at this
  worktree's frontend port (set `$env:BASE_URL` to override). Backend API tests that assume
  `localhost:8001` hit the MAIN checkout's backend — run them from the main checkout, or
  point them at the worktree's backend port.
- **Removing a worktree → unlink junctions first** — Claude Code `/worktree-dev-remove`,
  Codex `$worktree-dev-remove`, or `scripts/remove-worktree.ps1`; never recursive-delete a
  worktree that still has the venv/node_modules junctions (see §7).

---

## 10. Cheat sheet

```powershell
# new worktree off master (from the main checkout)
git worktree add ".claude/worktrees/my-thing" -b feat/my-thing master

# Claude Code: invoke /worktree-dev-env
# Codex: invoke $worktree-dev-env (or choose Worktree Dev Environment from /skills)
# Manual fallback: provision it (ports + .env + shared venv + shared node_modules).
# This AUTO-STARTS the services; pass -NoStart to skip.
powershell -File scripts/setup-worktree.ps1

# check (setup already started the stack; start-all re-starts or starts after -NoStart)
powershell -File scripts/start-all.ps1
Get-Content .worktree-ports.json
powershell -File scripts/health-check.ps1

# land + clean up (from the main checkout) — remove-worktree.ps1 stops services + unlinks junctions first
git merge feat/my-thing
# Claude Code: invoke /worktree-dev-remove
# Codex: invoke $worktree-dev-remove (or choose Remove Worktree from /skills)
# Manual fallback:
powershell -File scripts/remove-worktree.ps1 -Path ".claude/worktrees/my-thing" -DeleteBranch
```

See also: `CLAUDE.md` (architecture, service scripts, migrations, testing) and
`AGENTS.md` (agent-specific setup notes).
