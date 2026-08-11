# Restart Frontend Server
# Run from project root: powershell -File scripts/restart-frontend.ps1

# Determine project root
if ($MyInvocation.MyCommand.Path) {
    $projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
} elseif ($PSScriptRoot) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
} else {
    $projectRoot = Get-Location
}

Write-Host "Restarting frontend server..." -ForegroundColor Cyan

# start-frontend handles orphan cleanup before launching
& "$projectRoot\scripts\start-frontend.ps1"
