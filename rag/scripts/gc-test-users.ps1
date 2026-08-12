# scripts/gc-test-users.ps1
# Garbage-collect orphaned per-worktree test accounts (test-wt-*/test2-wt-*@test.com)
# whose worktree no longer exists - e.g. after a forced/crashed removal that skipped
# remove-worktree.ps1's account cleanup. Never touches the main checkout's test@/test2@
# accounts (they don't match the pattern). Run from any checkout - all share one DB.
#
#   powershell -File scripts/gc-test-users.ps1
#
# It keeps the accounts of every CURRENTLY-live worktree (by tag from each worktree's
# .worktree-ports.json) and deletes the rest.

$ErrorActionPreference = 'Stop'
$repoRoot   = Split-Path -Parent $PSScriptRoot
$python     = Join-Path $repoRoot 'backend\venv\Scripts\python.exe'
$provScript = Join-Path $repoRoot 'backend\scripts\provision_test_users.py'

if (-not (Test-Path $python))     { Write-Host "No venv python at $python" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $provScript)) { Write-Host "Missing $provScript" -ForegroundColor Red; exit 1 }

# Collect the tag of every live worktree (the main checkout has no record -> no tag,
# which is correct: it uses test@/test2@, not the test-wt-* accounts gc considers).
$wtPaths = @()
(& git -C $repoRoot worktree list --porcelain) | ForEach-Object {
    if ($_ -like 'worktree *') { $wtPaths += $_.Substring(9).Trim() }
}
$liveTags = @()
foreach ($p in $wtPaths) {
    $rec = Join-Path ($p -replace '/', '\') '.worktree-ports.json'
    if (Test-Path $rec) {
        try { $t = (Get-Content -Raw $rec | ConvertFrom-Json).tag } catch { $t = $null }
        if ($t) { $liveTags += $t }
    }
}

$keep = (($liveTags | Sort-Object -Unique) -join ',')
Write-Host "Keeping live worktree tags: '$keep'" -ForegroundColor Cyan
# Attached form (--keep-tags=) so an EMPTY keep set still passes one token; PowerShell
# silently drops a separate empty-string argument, which would break argparse.
# EAP=Continue: the helper logs to stderr, which under 'Stop' raises a terminating
# NativeCommandError. Capture both streams and echo them.
$prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$gcOut  = & $python $provScript "--gc" "--keep-tags=$keep" 2>&1
$gcExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
$gcOut | ForEach-Object { Write-Host $_ }
exit $gcExit
