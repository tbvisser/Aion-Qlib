# Restart Backend Server
# Run from project root: powershell -File scripts/restart-backend.ps1

# Determine project root
if ($MyInvocation.MyCommand.Path) {
    $projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
} elseif ($PSScriptRoot) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
} else {
    $projectRoot = Get-Location
}

Write-Host "Restarting backend server..." -ForegroundColor Cyan

# start-backend handles orphan cleanup before launching
& "$projectRoot\scripts\start-backend.ps1"
