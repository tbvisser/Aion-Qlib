<#
.SYNOPSIS
  Start, stop and inspect the Aion platform.

.DESCRIPTION
  Everything -- Supabase, the qlib API, the UI, RAG and the Vibe sidecar -- is a
  single compose project, so plain `docker compose` works from the repo root and
  this script is a convenience rather than a requirement.

  What it adds over `docker compose up -d` is the wait: the API resolves every
  caller's organisation out of Supabase's Postgres, and starting it before
  Postgres accepts connections leaves it serving errors until someone restarts
  it -- which reads as a bug in the app rather than a race at boot.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File infra\stack.ps1 up
  powershell -ExecutionPolicy Bypass -File infra\stack.ps1 status
  powershell -ExecutionPolicy Bypass -File infra\stack.ps1 down
  powershell -ExecutionPolicy Bypass -File infra\stack.ps1 logs api
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('up', 'down', 'restart', 'status', 'logs')]
    [string]$Action = 'status',

    # Passed through to `docker compose logs` (for example: api, rag-api, db).
    [Parameter(Position = 1)]
    [string]$Service
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$supabaseDir = Join-Path $PSScriptRoot 'supabase'

if (-not (Test-Path (Join-Path $supabaseDir 'docker-compose.yml'))) {
    Write-Host "Supabase is missing from $supabaseDir." -ForegroundColor Red
    Write-Host "The root docker-compose.yml includes it, so nothing will start." -ForegroundColor Yellow
    Write-Host "See infra/README.md." -ForegroundColor Yellow
    exit 1
}

function Invoke-Compose {
    param([string[]]$ComposeArgs, [string]$Label)
    Write-Host "==> $Label" -ForegroundColor Cyan
    Push-Location $repoRoot
    try {
        # Not `2>&1`: docker writes progress to stderr, and in Windows PowerShell
        # redirecting a native command's stderr wraps every line in an
        # ErrorRecord and sets $? to false even on success.
        & docker compose @ComposeArgs
        if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
    }
    finally { Pop-Location }
}

switch ($Action) {
    'up' {
        # Supabase first and explicitly, so the wait below has something to wait
        # for. `up -d` afterwards starts everything else in the same project.
        Invoke-Compose @('up', '-d', 'db', 'kong', 'auth', 'rest', 'storage', 'meta') 'Supabase'

        Write-Host '==> Waiting for Postgres to accept connections' -ForegroundColor Cyan
        $ready = $false
        foreach ($attempt in 1..60) {
            & docker exec supabase-db-aq pg_isready -U postgres -q 2>$null
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            Start-Sleep -Seconds 2
        }
        if (-not $ready) {
            Write-Host 'Postgres did not become ready in 120s.' -ForegroundColor Red
            Write-Host 'Check: infra\stack.ps1 logs db' -ForegroundColor Yellow
            exit 1
        }
        Write-Host '    ready' -ForegroundColor Green

        Invoke-Compose @('up', '-d') 'Everything else'

        Write-Host ''
        Write-Host 'UI       http://127.0.0.1:5274' -ForegroundColor Green
        Write-Host 'API      http://127.0.0.1:8770/api/health' -ForegroundColor Green
        Write-Host 'Studio   http://127.0.0.1:8010' -ForegroundColor Green
    }

    'down' {
        # Never with -v. Supabase's two named volumes are declared external in
        # the root compose file so `down -v` cannot reach them, but the qlib
        # volumes and, more importantly, the habit are worth protecting.
        Invoke-Compose @('down') 'Stopping the platform'
    }

    'restart' {
        & $PSCommandPath down
        & $PSCommandPath up
    }

    'status' {
        Invoke-Compose @('ps', '--format', 'table {{.Name}}\t{{.Status}}') 'Aion platform'
    }

    'logs' {
        if ($Service) {
            Invoke-Compose @('logs', '-f', '--tail', '100', $Service) "logs: $Service"
        }
        else {
            Invoke-Compose @('logs', '-f', '--tail', '50') 'logs: everything'
        }
    }
}
