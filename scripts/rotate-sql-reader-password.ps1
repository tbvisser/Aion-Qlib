# Rotate the sql_reader database password (Local Docker Compose Supabase)
# Run from project root: powershell -File scripts/rotate-sql-reader-password.ps1
#
# The sql_reader role is the read-only login the optional SQL/budget agent tools
# connect as. Its old password was committed to git history and must be treated
# as compromised — run this to set a fresh strong password, then copy the printed
# SQL_READER_DATABASE_URL into backend/.env (this script never edits .env).
#
# Usage:
#   powershell -File scripts/rotate-sql-reader-password.ps1
#   powershell -File scripts/rotate-sql-reader-password.ps1 -Password "your-own-strong-password"
#   powershell -File scripts/rotate-sql-reader-password.ps1 -DbHost localhost -DbPort 5432

param(
    [string]$ContainerName = "supabase-db",
    [string]$Password = "",
    [string]$DbHost = "localhost",
    [int]$DbPort = 5432
)

$containerRunning = docker ps --filter "name=$ContainerName" --format "{{.Names}}" 2>&1
if ($containerRunning -ne $ContainerName) {
    Write-Host "ERROR: Docker container '$ContainerName' is not running." -ForegroundColor Red
    Write-Host "Make sure Supabase is started: docker compose up -d (in your Supabase directory)" -ForegroundColor Yellow
    exit 1
}

# Generate a strong alphanumeric password if one wasn't supplied. Alphanumeric so
# it's safe to embed in a connection string without URL-encoding.
if ([string]::IsNullOrWhiteSpace($Password)) {
    $charset = (48..57) + (65..90) + (97..122)  # 0-9 A-Z a-z
    $Password = -join (1..28 | ForEach-Object { [char]($charset | Get-Random) })
}

# ALTER at top level so psql substitutes :'pw' as a safely-quoted literal. The
# role is created by the standard migrations; if it's missing, run them first.
$sql = "ALTER USER sql_reader WITH PASSWORD :'pw';"
$result = $sql | docker exec -i $ContainerName psql -U supabase_admin -d postgres -v pw="$Password" -v ON_ERROR_STOP=1 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to set sql_reader password." -ForegroundColor Red
    Write-Host "    $result" -ForegroundColor Red
    Write-Host "`n  If the role doesn't exist yet, run the migrations first:" -ForegroundColor Yellow
    Write-Host "    powershell -File scripts/run-migrations-local.ps1" -ForegroundColor Gray
    exit 1
}

Write-Host "`nsql_reader password rotated." -ForegroundColor Green
Write-Host "Put this in backend/.env (adjust host/port if your Postgres isn't on ${DbHost}:${DbPort}):" -ForegroundColor Cyan
Write-Host ""
Write-Host "SQL_READER_DATABASE_URL=postgresql://sql_reader:$Password@${DbHost}:${DbPort}/postgres" -ForegroundColor Yellow
Write-Host ""
Write-Host "Then restart the backend: powershell -File scripts/restart-backend.ps1" -ForegroundColor Gray
