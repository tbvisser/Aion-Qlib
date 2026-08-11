# Run All Tests (Backend + Frontend)
# Run from project root: powershell -File scripts/test-all.ps1

try {
    if ($MyInvocation.MyCommand.Path) {
        $projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
    } elseif ($PSScriptRoot) {
        $projectRoot = Split-Path -Parent $PSScriptRoot
    } else {
        $projectRoot = Get-Location
    }

    $failed = @()

    # --- Backend ---
    Write-Host "=== Backend Tests (pytest) ===" -ForegroundColor Cyan
    Set-Location "$projectRoot\backend"
    & .\venv\Scripts\Activate.ps1
    python -m pytest -v -m "not slow"
    if ($LASTEXITCODE -ne 0) { $failed += "backend" }

    Write-Host ""

    # --- Frontend ---
    Write-Host "=== Frontend E2E Tests (Playwright) ===" -ForegroundColor Cyan
    Set-Location "$projectRoot\frontend"
    npx playwright test
    if ($LASTEXITCODE -ne 0) { $failed += "frontend" }

    # --- Summary ---
    Write-Host ""
    Write-Host "=== Summary ===" -ForegroundColor Cyan
    if ($failed.Count -eq 0) {
        Write-Host "All test suites passed." -ForegroundColor Green
        exit 0
    } else {
        Write-Host "Failed suites: $($failed -join ', ')" -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
