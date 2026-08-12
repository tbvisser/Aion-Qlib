---
description: Safely remove a linked worktree (test accounts, shared-dep junctions, git worktree) for this repo
---

# Remove Worktree

Safely tear down a linked git worktree for this repo: stop its running services, delete its per-worktree test accounts from the shared DB, unlink the shared `backend\venv` / `frontend\node_modules` junctions, then `git worktree remove` it (optionally deleting its branch).

Always use this flow. **Never** delete a worktree with `Remove-Item -Recurse`, `rm -rf`, or Explorer while the shared-dep junctions are still linked — on Windows that follows the junctions and wipes the shared ~5.8 GB `backend\venv` for every worktree. `remove-worktree.ps1` unlinks them first, then removes the worktree.

## Process

1. Read `WORKTREES.md` (§7 Landing work, §9 quick-reference) if it has not already been loaded in this session. Make sure any work in the worktree is committed and landed first.
2. Identify the target worktree path (e.g. `.claude\worktrees\<name>`).
3. **From the main checkout** (the usual case — required to actually remove the worktree):

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\remove-worktree.ps1 -Path ".claude\worktrees\<name>" [-DeleteBranch] [-Force]
   ```

4. **From inside the worktree being removed**, run it with no `-Path`. This unlinks the junctions only — a session cannot `git worktree remove` its own working directory — then prints the command to finish removal from the main checkout:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\remove-worktree.ps1
   ```

5. Report what was removed (services stopped, test accounts, junctions, worktree, branch). If account deletion warned, reap orphans with `powershell -ExecutionPolicy Bypass -File scripts\gc-test-users.ps1`.

## Flags

- `-DeleteBranch` — delete the worktree's branch after removal (use once the branch is merged/landed).
- `-Force` — remove a worktree that still has uncommitted changes.
- `-NoStop` — skip stopping the worktree's services before removal.
- `-NoTestUsers` — skip deleting the worktree's test accounts (leave them in the shared DB).
