# Run Database Migrations (Supabase Cloud)
# Run from project root: powershell -File scripts/run-migrations-cloud.ps1
#
# Applies all pending migrations from supabase/migrations/ to a Supabase Cloud project
# using the Supabase CLI (npx supabase db push).
#
# Already-applied migrations are skipped automatically.
# Safe to re-run — will not duplicate or delete data.
#
# Prerequisites:
#   - Supabase CLI installed (npx supabase)
#   - A Supabase Cloud project
#
# Usage:
#   powershell -File scripts/run-migrations-cloud.ps1                          # Interactive (prompts for project link)
#   powershell -File scripts/run-migrations-cloud.ps1 -ProjectRef "abcdefgh"   # Link and push in one step

param(
    [string]$ProjectRef,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Determine project root
if ($MyInvocation.MyCommand.Path) {
    $projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
} elseif ($PSScriptRoot) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
} else {
    $projectRoot = Get-Location
}

Set-Location $projectRoot

$migrationsDir = Join-Path $projectRoot "supabase\migrations"

# Verify migrations directory exists
if (-not (Test-Path $migrationsDir)) {
    Write-Host "ERROR: Migrations directory not found: $migrationsDir" -ForegroundColor Red
    exit 1
}

# Count migration files
$migrationFiles = Get-ChildItem -Path "$migrationsDir\*.sql" -ErrorAction SilentlyContinue
$totalMigrations = ($migrationFiles | Measure-Object).Count

if ($totalMigrations -eq 0) {
    Write-Host "No migration files found in $migrationsDir" -ForegroundColor Yellow
    exit 0
}

Write-Host "`nRunning database migrations (Supabase Cloud)..." -ForegroundColor Green
Write-Host "  Migration files found: $totalMigrations" -ForegroundColor Gray

# Link project if ref provided
if ($ProjectRef) {
    Write-Host "  Linking to project: $ProjectRef" -ForegroundColor Gray
    npx supabase link --project-ref $ProjectRef
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Failed to link project. Check your project ref and authentication." -ForegroundColor Red
        Write-Host "  You may need to run: npx supabase login" -ForegroundColor Yellow
        exit 1
    }
}

Write-Host ""

# Run supabase db push
if ($DryRun) {
    Write-Host "DRY RUN — showing what would be applied:" -ForegroundColor Yellow
    npx supabase db push --dry-run
} else {
    echo "Y" | npx supabase db push
}

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nMigrations applied successfully." -ForegroundColor Green
} else {
    Write-Host "`nMigration failed. Check the output above for details." -ForegroundColor Red
    Write-Host "Common issues:" -ForegroundColor Yellow
    Write-Host "  - Not linked: run 'npx supabase link --project-ref YOUR_REF' first" -ForegroundColor Gray
    Write-Host "  - Not logged in: run 'npx supabase login' first" -ForegroundColor Gray
    Write-Host "  - Wrong project: check your linked project with 'npx supabase projects list'" -ForegroundColor Gray
    exit 1
}
