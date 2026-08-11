---
name: worktree-dev-remove
description: Safely tear down a linked git worktree for this repo — delete its per-worktree test accounts, unlink the shared backend venv / node_modules junctions, then remove the worktree (and optionally its branch). Use when landing/finishing a worktree, cleaning up a parallel agent's worktree, or whenever a worktree must be deleted. Never recursive-delete a worktree by hand — it follows the junctions and wipes the shared venv.
---

# Remove Worktree

## Workflow

Use this skill to remove a linked git worktree for this repo once its work is committed and landed.

This always goes through `scripts\remove-worktree.ps1`. **Never** delete a worktree with `Remove-Item -Recurse`, `rm -rf`, or Explorer while the shared-dep junctions are still linked — on Windows that follows the `backend\venv` / `frontend\node_modules` junctions and wipes the shared ~5.8 GB venv for every worktree. This script unlinks them first.

1. Load `WORKTREES.md` (§7 Landing work, §9 quick-reference) if it has not already been read in the current thread. Confirm the worktree's work is committed and landed.
2. Identify the target worktree path (e.g. `.claude\worktrees\<name>`).
3. From the **main checkout** (required to actually remove the worktree):

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\remove-worktree.ps1 -Path ".claude\worktrees\<name>" [-DeleteBranch] [-Force]
   ```

4. From **inside the worktree being removed**, run it with no `-Path`. This unlinks the junctions only — a session cannot `git worktree remove` its own working directory — then prints the command to finish removal from the main checkout:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\remove-worktree.ps1
   ```

5. Summarize what was removed (services stopped, test accounts, junctions, worktree, branch).

## Notes

- The script stops the worktree's services, deletes its per-worktree test accounts from the **shared** Supabase DB, unlinks the junctions, then runs `git worktree remove`.
- `-DeleteBranch` deletes the branch after removal; `-Force` removes a worktree with uncommitted changes; `-NoStop` skips stopping services; `-NoTestUsers` skips test-account deletion.
- If account deletion warns or teardown half-failed, reap orphaned accounts with `powershell -ExecutionPolicy Bypass -File scripts\gc-test-users.ps1` (keeps live worktrees + main, deletes the rest).
- This removes a worktree; it does not undo a `pip install` or migration applied to the shared DB/venv from that worktree — those are global.
