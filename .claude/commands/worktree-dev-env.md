---
description: Provision or verify this repo's dev environment inside an existing worktree
---

# Worktree Dev Environment

Provision or verify this repo's development environment inside the current git worktree before creating/switching branches, starting services, running tests, editing code, or opening browser validation.

This does not create a git worktree. It configures an already-created worktree with isolated app ports, env files, a shared backend venv, and per-worktree test accounts, then starts the backend + frontend services.

## Process

1. Read `CLAUDE.md` and `WORKTREES.md` if they have not already been loaded in this session.
2. Check whether `.worktree-ports.json` exists in the repo root.
3. If `.worktree-ports.json` exists, run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\health-check.ps1
   ```

4. If `.worktree-ports.json` does not exist, run (this also auto-starts the services; pass `-NoStart` to skip):

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup-worktree.ps1
   ```

5. Report the backend and frontend ports. Provisioning auto-starts the backend + frontend in their own windows (the frontend needs `node_modules` — link with `-LinkNodeModules` or run `npm install` in `frontend` if it does not come up).

Do not create or switch branches, run tests, edit code, or open browser validation before this succeeds. Provisioning starts the services for you.
