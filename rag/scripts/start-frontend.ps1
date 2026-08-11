# Start Frontend Server
# Run from project root: powershell -File scripts/start-frontend.ps1
# Launches frontend in a new detached window titled "RAG-Frontend-<worktree>" on
# this worktree's port (see scripts/setup-worktree.ps1 / .worktree-ports.json).

param([switch]$Server)

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
$windowTitle = "RAG-Frontend-$($cfg.Tag)"

if ($Server) {
    # Server mode: actually run the frontend (called in the new window)
    $Host.UI.RawUI.WindowTitle = $windowTitle
    try {
        Write-Host "Starting frontend server on port $($cfg.FrontendPort)..." -ForegroundColor Green
        Write-Host "Project root: $projectRoot" -ForegroundColor Gray
        Set-Location "$projectRoot\frontend"
        $localToolsBin = Join-Path $projectRoot ".tools\bin"
        if (Test-Path $localToolsBin) {
            $env:Path = "$localToolsBin;$env:Path"
        }
        $env:FRONTEND_PORT = "$($cfg.FrontendPort)"
        npm run dev
    } catch {
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Press any key to exit..." -ForegroundColor Yellow
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    }
} else {
    # Launcher mode: stop orphans and open a new detached window
    & "$projectRoot\scripts\stop-frontend.ps1"

    $scriptPath = Join-Path $projectRoot "scripts\start-frontend.ps1"
    Start-Process powershell -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Server"

    Write-Host "Frontend starting in new window: http://localhost:$($cfg.FrontendPort)" -ForegroundColor Green
}
