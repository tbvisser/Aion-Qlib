# Run Database Migrations (Local Docker Compose Supabase)
# Run from project root: powershell -File scripts/run-migrations-local.ps1
#
# Applies all pending migrations from supabase/migrations/ to the local Supabase database
# by running psql directly inside the Docker container (bypasses Supavisor/connection pooler).
#
# Already-applied migrations are skipped (tracked in supabase_migrations.schema_migrations).
# Safe to re-run — will not duplicate or delete data.
#
# Usage:
#   powershell -File scripts/run-migrations-local.ps1                                    # Fresh database
#   powershell -File scripts/run-migrations-local.ps1 -ContainerName "my-supabase-db"   # Custom container
#   powershell -File scripts/run-migrations-local.ps1 -Sync                              # Sync tracking table with existing DB

param(
    [string]$ContainerName = "supabase-db",
    [switch]$Sync
)

# Note: We do NOT set $ErrorActionPreference = "Stop" globally because
# psql sends NOTICE messages to stderr (e.g. "schema already exists, skipping")
# which PowerShell would treat as terminating errors.

# Determine project root
if ($MyInvocation.MyCommand.Path) {
    $projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
} elseif ($PSScriptRoot) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
} else {
    $projectRoot = Get-Location
}

$migrationsDir = Join-Path $projectRoot "supabase\migrations"

# Verify Docker container is running
$containerRunning = docker ps --filter "name=$ContainerName" --format "{{.Names}}" 2>&1
if ($containerRunning -ne $ContainerName) {
    Write-Host "ERROR: Docker container '$ContainerName' is not running." -ForegroundColor Red
    Write-Host "Make sure Supabase is started: docker compose up -d (in your Supabase directory)" -ForegroundColor Yellow
    exit 1
}

# Verify migrations directory exists
if (-not (Test-Path $migrationsDir)) {
    Write-Host "ERROR: Migrations directory not found: $migrationsDir" -ForegroundColor Red
    exit 1
}

# Get list of migration files sorted by name (timestamp order)
$migrationFiles = Get-ChildItem -Path "$migrationsDir\*.sql" | Sort-Object Name
$totalMigrations = ($migrationFiles | Measure-Object).Count

if ($totalMigrations -eq 0) {
    Write-Host "No migration files found in $migrationsDir" -ForegroundColor Yellow
    exit 0
}

Write-Host "`nRunning database migrations (local Docker)..." -ForegroundColor Green
Write-Host "  Container: $ContainerName" -ForegroundColor Gray
Write-Host "  Migration files found: $totalMigrations" -ForegroundColor Gray

# Ensure the schema_migrations tracking table exists
$createTrackingTable = @"
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
    version text NOT NULL PRIMARY KEY,
    statements text[],
    name text
);
"@
$createTrackingTable | docker exec -i $ContainerName psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to create migration tracking table." -ForegroundColor Red
    exit 1
}

# Get already-applied migrations by name and version
# We match by name (not version) because the MCP tool records its own timestamps
# that differ from the file name timestamps.
$appliedRaw = docker exec -i $ContainerName psql -U supabase_admin -d postgres -t -A -c "SELECT name FROM supabase_migrations.schema_migrations;" 2>$null
$appliedNames = @()
if ($appliedRaw -and $appliedRaw -notmatch "ERROR") {
    $appliedNames = $appliedRaw -split "`n" | Where-Object { $_.Trim() -ne "" }
}

Write-Host "  Already applied: $($appliedNames.Count)" -ForegroundColor Gray
Write-Host ""

# -Sync mode: register all migration files as applied without running them.
# Use this when migrations were applied via MCP under different names and the
# tracking table is out of sync with the migration files.
if ($Sync) {
    Write-Host "  SYNC MODE: Registering migration files in tracking table..." -ForegroundColor Yellow
    $registered = 0
    $alreadyTracked = 0

    foreach ($file in $migrationFiles) {
        $version = $file.BaseName -replace '_.*$', ''
        $name = $file.BaseName -replace '^\d+_', ''

        if ($appliedNames -contains $name) {
            $alreadyTracked++
            continue
        }

        $insertSql = "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('$version', '$name') ON CONFLICT (version) DO NOTHING;"
        $insertSql | docker exec -i $ContainerName psql -U supabase_admin -d postgres 2>$null | Out-Null
        Write-Host "  Registered: $($file.Name)" -ForegroundColor Gray
        $registered++
    }

    Write-Host ""
    Write-Host "Sync complete. Registered: $registered | Already tracked: $alreadyTracked" -ForegroundColor Green
    Write-Host "Run without -Sync to apply any genuinely new migrations." -ForegroundColor Gray
    exit 0
}

$applied = 0
$skipped = 0
$failed = 0

foreach ($file in $migrationFiles) {
    # Extract version (timestamp) and name from filename: YYYYMMDDHHMMSS_description.sql
    $version = $file.BaseName -replace '_.*$', ''
    $name = $file.BaseName -replace '^\d+_', ''

    # Check if already applied (match by name)
    if ($appliedNames -contains $name) {
        $skipped++
        continue
    }

    Write-Host "  Applying: $($file.Name)..." -ForegroundColor Cyan -NoNewline

    # Run the migration SQL
    $result = Get-Content $file.FullName -Raw | docker exec -i $ContainerName psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 2>&1
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0) {
        Write-Host " FAILED" -ForegroundColor Red
        # Filter out NOTICE lines, show only real errors
        $errors = $result | Where-Object { $_ -match "ERROR|FATAL|PANIC" }
        if ($errors) {
            Write-Host "    $errors" -ForegroundColor Red
        } else {
            Write-Host "    $result" -ForegroundColor Red
        }
        $failed++
        Write-Host "`nStopping due to migration failure. Fix the issue and re-run." -ForegroundColor Red
        Write-Host "  Failed at: $($file.Name)" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  If these migrations were already applied (e.g. via MCP), run with -Sync to register them:" -ForegroundColor Yellow
        Write-Host "    powershell -File scripts/run-migrations-local.ps1 -Sync" -ForegroundColor Gray
        exit 1
    }

    # Record the migration as applied
    $insertSql = "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('$version', '$name') ON CONFLICT (version) DO NOTHING;"
    $insertSql | docker exec -i $ContainerName psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 2>$null | Out-Null

    Write-Host " OK" -ForegroundColor Green
    $applied++
}

Write-Host ""
if ($failed -gt 0) {
    Write-Host "Migration completed with errors." -ForegroundColor Red
    Write-Host "  Applied: $applied | Skipped: $skipped | Failed: $failed" -ForegroundColor Gray
    exit 1
} elseif ($applied -eq 0) {
    Write-Host "All $skipped migrations already applied. Database is up to date." -ForegroundColor Green
} else {
    Write-Host "Migrations complete." -ForegroundColor Green
    Write-Host "  Applied: $applied | Skipped (already applied): $skipped" -ForegroundColor Gray
}
