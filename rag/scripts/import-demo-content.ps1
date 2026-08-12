# Import Optional Demo Content (Local Docker Compose Supabase)
# Run from project root: powershell -File scripts/import-demo-content.ps1
#
# Applies supabase/demo/demo_content.sql — the sample tables for the Text-to-SQL,
# budget-compliance, and PII-redaction demos. The normal migration run does NOT
# create these (they were dropped from the main app for security); this script
# recreates them WITH Row-Level Security enabled. Safe to re-run (idempotent).
#
# Requires the sql_reader role to exist (created by the standard migrations).
#
# Usage:
#   powershell -File scripts/import-demo-content.ps1
#   powershell -File scripts/import-demo-content.ps1 -ContainerName "my-supabase-db"

param(
    [string]$ContainerName = "supabase-db"
)

if ($MyInvocation.MyCommand.Path) {
    $projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
} elseif ($PSScriptRoot) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
} else {
    $projectRoot = Get-Location
}

$demoFile = Join-Path $projectRoot "supabase\demo\demo_content.sql"

$containerRunning = docker ps --filter "name=$ContainerName" --format "{{.Names}}" 2>&1
if ($containerRunning -ne $ContainerName) {
    Write-Host "ERROR: Docker container '$ContainerName' is not running." -ForegroundColor Red
    Write-Host "Make sure Supabase is started: docker compose up -d (in your Supabase directory)" -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $demoFile)) {
    Write-Host "ERROR: Demo content file not found: $demoFile" -ForegroundColor Red
    exit 1
}

Write-Host "`nImporting demo content..." -ForegroundColor Green
Write-Host "  Container: $ContainerName" -ForegroundColor Gray
Write-Host "  File: $demoFile" -ForegroundColor Gray

$result = Get-Content $demoFile -Raw | docker exec -i $ContainerName psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 2>&1
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    Write-Host " FAILED" -ForegroundColor Red
    $errors = $result | Where-Object { $_ -match "ERROR|FATAL|PANIC" }
    if ($errors) {
        Write-Host "    $errors" -ForegroundColor Red
    } else {
        Write-Host "    $result" -ForegroundColor Red
    }
    Write-Host "`n  If it failed because the sql_reader role is missing, run the migrations first:" -ForegroundColor Yellow
    Write-Host "    powershell -File scripts/run-migrations-local.ps1" -ForegroundColor Gray
    exit 1
}

Write-Host "Demo content imported." -ForegroundColor Green
Write-Host "  Tables: sales_data, team_members, travel_expenses, budget_limits," -ForegroundColor Gray
Write-Host "          test_customer_records, test_employee_directory (all RLS-enabled)" -ForegroundColor Gray
