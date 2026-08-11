---
name: worktree-dev-env
description: Provision or verify this repo's development environment inside an existing Codex git worktree before branch creation, service startup, testing, browser validation, or code edits. Use when entering or creating a worktree, when `.worktree-ports.json` may be missing, or when the user asks to configure the worktree dev environment.
---

# Worktree Dev Environment

## Workflow

Use this skill as the first action after entering a linked git worktree for this repo.

This does not create a git worktree. It configures an already-created worktree with isolated app ports, env files, shared backend/frontend dependencies, a local npm fallback when needed, and per-worktree test accounts, then starts the backend + frontend services.

1. Load `CLAUDE.md` and `WORKTREES.md` if they have not already been read in the current thread.
2. Check whether `.worktree-ports.json` exists in the repo root.
3. If it exists, verify provisioning:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\health-check.ps1
   ```

4. If it does not exist, provision the worktree dev environment. The setup script shares `backend\venv` and `frontend\node_modules` by default and auto-starts the services; pass `-NoStart` to skip:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup-worktree.ps1
   ```

5. Summarize the resulting backend/frontend ports. Provisioning auto-starts the backend + frontend in their own windows.

Do not create or switch branches, run tests, edit code, or open browser validation before this workflow succeeds. Provisioning starts the services for you.

## Notes

- This repo intentionally shares the local Supabase database, `backend\venv`, and `frontend\node_modules` across worktrees.
- If setup fails because the current checkout is not a linked worktree, report that and continue with main-checkout behavior only if the requested task is safe there.
- Provisioning auto-starts the services (`RAG-Backend-<tag>` / `RAG-Frontend-<tag>` windows). Pass `-NoStart` to skip, e.g. when you only need the env configured.
- Backend env changes still require a backend restart after setup.
