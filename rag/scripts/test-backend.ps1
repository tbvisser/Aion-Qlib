# Run Backend Tests (pytest)
# Run from project root: powershell -File scripts/test-backend.ps1
# Optional args are passed through to pytest, e.g.:
#   powershell -File scripts/test-backend.ps1 -v
#   powershell -File scripts/test-backend.ps1 -m "not slow"
#   powershell -File scripts/test-backend.ps1 tests/api/test_deep_mode.py

param([Parameter(ValueFromRemainingArguments)]$pytestArgs)

try {
    if ($MyInvocation.MyCommand.Path) {
        $projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
    } elseif ($PSScriptRoot) {
        $projectRoot = Split-Path -Parent $PSScriptRoot
    } else {
        $projectRoot = Get-Location
    }

    Write-Host "Running backend tests..." -ForegroundColor Green
    Set-Location "$projectRoot\backend"

    & .\venv\Scripts\Activate.ps1
    if ($pytestArgs) {
        python -m pytest @pytestArgs
    } else {
        python -m pytest -v
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
