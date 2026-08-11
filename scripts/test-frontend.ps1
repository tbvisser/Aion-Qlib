# Run Frontend E2E Tests (Playwright)
# Run from project root: powershell -File scripts/test-frontend.ps1
# Optional args are passed through to playwright, e.g.:
#   powershell -File scripts/test-frontend.ps1 --headed
#   powershell -File scripts/test-frontend.ps1 --grep "Deep Mode"
#   powershell -File scripts/test-frontend.ps1 tests/e2e/deep-mode.spec.ts

param([Parameter(ValueFromRemainingArguments)]$playwrightArgs)

try {
    if ($MyInvocation.MyCommand.Path) {
        $projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
    } elseif ($PSScriptRoot) {
        $projectRoot = Split-Path -Parent $PSScriptRoot
    } else {
        $projectRoot = Get-Location
    }

    # Point Playwright at THIS worktree's frontend port (canonical 5173 for the main
    # checkout, 5173+offset for a worktree). A caller-set $env:BASE_URL wins.
    . (Join-Path $projectRoot 'scripts\worktree-lib.ps1')
    if (-not $env:BASE_URL) {
        $cfg = Get-WorktreePortConfig -ProjectRoot $projectRoot
        Assert-WorktreeProvisioned -Config $cfg
        $env:BASE_URL = "http://localhost:$($cfg.FrontendPort)"
    }

    Write-Host "Running frontend E2E tests against $env:BASE_URL ..." -ForegroundColor Green
    Set-Location "$projectRoot\frontend"

    if ($playwrightArgs) {
        npx playwright test @playwrightArgs
    } else {
        npx playwright test
    }

    $exitCode = $LASTEXITCODE
    Write-Host ""
    if ($exitCode -eq 0) {
        Write-Host "All tests passed." -ForegroundColor Green
    } else {
        Write-Host "Some tests failed (exit code $exitCode)." -ForegroundColor Red
    }
    exit $exitCode
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
