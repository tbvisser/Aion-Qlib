# Start Backend Server
# Run from project root: powershell -File scripts/start-backend.ps1
# Launches backend in a new detached window titled "RAG-Backend-<worktree>" on
# this worktree's port (see scripts/setup-worktree.ps1 / .worktree-ports.json).

param(
    [switch]$Server,
    [switch]$NoReload,
    [switch]$Reload
)

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
$windowTitle = "RAG-Backend-$($cfg.Tag)"

if ($Server) {
    # Server mode: actually run the backend (called in the new window)
    $Host.UI.RawUI.WindowTitle = $windowTitle
    try {
        Write-Host "Starting backend server on port $($cfg.BackendPort)..." -ForegroundColor Green
        Write-Host "Project root: $projectRoot" -ForegroundColor Gray
        if (-not (Test-Path (Join-Path $projectRoot 'backend\.env'))) {
            Write-Host "WARNING: backend\.env not found. Run: powershell -File scripts/setup-worktree.ps1" -ForegroundColor Yellow
        }
        Set-Location "$projectRoot\backend"
        & .\venv\Scripts\Activate.ps1
        $uvicornArgs = @("app.main:app", "--host", "0.0.0.0", "--port", "$($cfg.BackendPort)")
        if ($Reload -and -not $NoReload -and $env:BACKEND_RELOAD -ne "false") {
            $uvicornArgs += "--reload"
        }
        python -m uvicorn @uvicornArgs
    } catch {
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Press any key to exit..." -ForegroundColor Yellow
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    }
} else {
    # Launcher mode: stop orphans and open a new detached window
    & "$projectRoot\scripts\stop-backend.ps1"

    $scriptPath = Join-Path $projectRoot "scripts\start-backend.ps1"
    $serverArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Server"
    if ($Reload) {
        $serverArgs += " -Reload"
    }
    if ($NoReload) {
        $serverArgs += " -NoReload"
    }
    Start-Process powershell -ArgumentList $serverArgs

    Write-Host "Backend starting in new window: http://localhost:$($cfg.BackendPort)" -ForegroundColor Green
}
