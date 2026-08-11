# Backend health check (worktree-aware port)
# Run from project root: powershell -File scripts/health-check.ps1

if ($PSScriptRoot) { $projectRoot = Split-Path -Parent $PSScriptRoot } else { $projectRoot = (Get-Location).Path }
. (Join-Path $projectRoot 'scripts\worktree-lib.ps1')
$cfg = Get-WorktreePortConfig -ProjectRoot $projectRoot
Assert-WorktreeProvisioned -Config $cfg

try {
    $response = Invoke-RestMethod -Uri "http://localhost:$($cfg.BackendPort)/health" -TimeoutSec 10
    Write-Output "Backend healthy on port $($cfg.BackendPort): $($response | ConvertTo-Json -Compress)"
} catch {
    Write-Output "Backend NOT healthy on port $($cfg.BackendPort): $($_.Exception.Message)"
    exit 1
}
