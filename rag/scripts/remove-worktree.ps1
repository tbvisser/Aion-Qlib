# scripts/remove-worktree.ps1
# Safely remove a worktree. CRITICAL: it UNLINKS the shared-dep junctions
# (backend\venv, frontend\node_modules) first, so a recursive delete can never
# follow them into the main checkout and wipe the shared ~5.8 GB venv. Only then
# does it run `git worktree remove`.
#
#   # from the MAIN checkout:
#   powershell -File scripts/remove-worktree.ps1 -Path ".claude/worktrees/<name>" [-DeleteBranch] [-Force]
#
#   # or from INSIDE the worktree (unlinks only; finish removal from the main checkout):
#   powershell -File scripts/remove-worktree.ps1
#
# NEVER delete a worktree that still has these junctions with `Remove-Item -Recurse`
# or Explorer - on Windows that follows the junction and deletes the TARGET's
# contents (i.e. the main checkout's venv). Always unlink first (this script does).

param(
    [string]$Path,
    [switch]$DeleteBranch,
    [switch]$Force,
    [switch]$NoTestUsers,
    [switch]$NoStop
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'worktree-lib.ps1')

$repoRoot = Split-Path -Parent $PSScriptRoot

function Remove-DirJunctionSafe {
    # Remove a directory junction WITHOUT following it (deletes the link only, never
    # the target). `cmd /c rmdir` on a junction removes just the reparse point; on a
    # real non-empty folder it safely fails, so a genuine venv is never deleted.
    param([string]$LinkPath, [string]$Label)
    if (-not (Test-Path $LinkPath)) { return }
    $item = Get-Item $LinkPath -Force
    $isLink = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isLink) {
        # Non-recursive delete on a directory junction removes only the reparse point
        # (the link); the Win32 RemoveDirectory call never follows into the target. On a
        # real non-empty folder it throws instead - so a genuine venv is never wiped.
        try {
            [System.IO.Directory]::Delete($LinkPath, $false)
            Write-Host "  unlinked ${Label} (shared target untouched)" -ForegroundColor Gray
        } catch {
            Write-Host "  WARNING: failed to unlink ${Label} at $LinkPath ($($_.Exception.Message)) - remove it manually before deleting the worktree." -ForegroundColor Red
        }
    } else {
        Write-Host "  ${Label}: real folder (not a junction) - left as-is" -ForegroundColor Gray
    }
}

# Resolve the target worktree
if ($Path) {
    if (-not (Test-Path $Path)) { Write-Host "No such path: $Path" -ForegroundColor Red; exit 1 }
    $target = (Resolve-Path $Path).Path
} else {
    $target = $repoRoot   # invoked from inside the worktree
}

# Safety: never operate on the main checkout
if (-not (Test-IsLinkedWorktree -ProjectRoot $target)) {
    Write-Host "Refusing: '$target' is the MAIN checkout, not a linked worktree." -ForegroundColor Red
    exit 1
}

# --- stop this worktree's services before teardown (default; pass -NoStop to skip) ---
# Use the TARGET worktree's own stop-all.ps1 so it kills the target's ports/windows,
# not the caller's. Run it in a CHILD powershell so any Assert/exit inside the stop
# scripts can't abort this removal (which must still unlink the junctions).
if (-not $NoStop) {
    $stopAll = Join-Path $target 'scripts\stop-all.ps1'
    if (Test-Path $stopAll) {
        Write-Host "Stopping this worktree's services before removal..." -ForegroundColor Cyan
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & powershell -NoProfile -ExecutionPolicy Bypass -File $stopAll 2>&1 |
            ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
        $ErrorActionPreference = $prevEAP
    }
}

# --- delete this worktree's test accounts from the shared DB, before teardown ---
# Read the tag from the worktree's .worktree-ports.json (still present) and run the
# helper with the MAIN checkout's python + .env (the worktree's venv junction is about
# to be unlinked, and the service key is the same shared Supabase either way).
$recordPath = Join-Path $target '.worktree-ports.json'
$mainPython = Join-Path $repoRoot 'backend\venv\Scripts\python.exe'
$provScript = Join-Path $repoRoot 'backend\scripts\provision_test_users.py'
if (-not $NoTestUsers -and (Test-Path $recordPath) -and (Test-Path $mainPython) -and (Test-Path $provScript)) {
    $tag = $null
    try { $tag = (Get-Content -Raw $recordPath | ConvertFrom-Json).tag } catch { $tag = $null }
    if ($tag) {
        Write-Host "Deleting worktree test accounts (tag '$tag') ..." -ForegroundColor Cyan
        # EAP=Continue: the helper logs to stderr, which under 'Stop' would raise a
        # terminating NativeCommandError and abort teardown. Capture + echo instead.
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $delOut  = & $mainPython $provScript --delete --tag $tag 2>&1
        $delExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP
        $delOut | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
        if ($delExit -ne 0) {
            Write-Host "  WARNING: account deletion exited $delExit; run scripts/gc-test-users.ps1 to reap orphans." -ForegroundColor Yellow
        }
    }
}

Write-Host "Unlinking shared-dep junctions in $target ..." -ForegroundColor Cyan
Remove-DirJunctionSafe -LinkPath (Join-Path $target 'backend\venv')          -Label 'backend\venv'
Remove-DirJunctionSafe -LinkPath (Join-Path $target 'frontend\node_modules') -Label 'frontend\node_modules'

# If we're standing inside the target, we cannot `git worktree remove` it ourselves.
$here = (Resolve-Path '.').Path
if ($here.ToLower().StartsWith($target.ToLower())) {
    Write-Host ""
    Write-Host "Junctions unlinked. To finish removal, run from the MAIN checkout:" -ForegroundColor Yellow
    Write-Host "  powershell -File scripts/remove-worktree.ps1 -Path `"$target`"$(if($DeleteBranch){' -DeleteBranch'})" -ForegroundColor Yellow
    exit 0
}

# Otherwise remove the worktree (junctions already unlinked, so this is safe)
$branch = (& git -C $target rev-parse --abbrev-ref HEAD 2>$null)
$removeArgs = @('worktree', 'remove', $target)
if ($Force) { $removeArgs += '--force' }
& git @removeArgs
Write-Host "Removed worktree $target" -ForegroundColor Green
if ($DeleteBranch -and $branch -and $branch -ne 'HEAD') {
    & git branch -d $branch
    Write-Host "Deleted branch $branch" -ForegroundColor Green
}
