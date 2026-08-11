# Restart All Services
# Run from project root: powershell -File scripts/restart-all.ps1

# Determine project root
if ($MyInvocation.MyCommand.Path) {
    $projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
} elseif ($PSScriptRoot) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
} else {
    $projectRoot = Get-Location
}

. (Join-Path $projectRoot 'scripts\worktree-lib.ps1')
$cfg = Get-WorktreePortConfig -ProjectRoot $projectRoot
Assert-WorktreeProvisioned -Config $cfg

Write-Host "Restarting all services..." -ForegroundColor Cyan

# Each start script handles orphan cleanup before launching
& "$projectRoot\scripts\start-backend.ps1"

# Brief pause to stagger startup
Start-Sleep -Milliseconds 500

& "$projectRoot\scripts\start-frontend.ps1"

Write-Host "`nServices restarting in separate windows:" -ForegroundColor Cyan
Write-Host "  Backend:  http://localhost:$($cfg.BackendPort)" -ForegroundColor Yellow
Write-Host "  Frontend: http://localhost:$($cfg.FrontendPort)" -ForegroundColor Yellow
