<#
.SYNOPSIS
  Start, stop and inspect the Aion platform.

.DESCRIPTION
  Two compose files, one Docker project (aion-qlib):

  - Supabase lives in infra/supabase/. Auth, Postgres, Studio.
  - The platform lives in the repo-root compose file: api (qlib), ui, rag-api,
    vibe-api, vibe-mcp, and the scalability agent.

  Same project name so Docker Desktop groups them under aion-qlib. They stay
  two files so `down` can stop the platform without touching the database.

  This script starts Supabase first, waits until Postgres accepts connections,
  then starts the platform. The wait is load-bearing: the API resolves every
  caller's organisation out of that database, and starting it first leaves it
  serving errors until someone restarts it.

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

    # Passed through to `docker compose logs` (for example: api, ui, db).
    [Parameter(Position = 1)]
    [string]$Service
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$supabaseDir = Join-Path $PSScriptRoot 'supabase'
$platformServices = @('api', 'ui', 'rag-api', 'agent', 'vibe-api', 'vibe-mcp')

if (-not (Test-Path (Join-Path $supabaseDir 'docker-compose.yml'))) {
    Write-Host "Supabase is missing from $supabaseDir." -ForegroundColor Red
    Write-Host "Clone or copy the supabase-aq stack there. See infra/README.md." -ForegroundColor Yellow
    exit 1
}

function Invoke-Platform {
    param([string[]]$ComposeArgs, [string]$Label)
    Write-Host "==> $Label" -ForegroundColor Cyan
    Push-Location $repoRoot
    try {
        & docker compose @ComposeArgs
        if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
    }
    finally { Pop-Location }
}

function Invoke-Supabase {
    param([string[]]$ComposeArgs, [string]$Label)
    Write-Host "==> $Label" -ForegroundColor Cyan
    Push-Location $supabaseDir
    try {
        & docker compose @ComposeArgs
        if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)" }
    }
    finally { Pop-Location }
}

function Move-SupabaseIntoAionProject {
    # Older runs used project supabase-aq, which Docker Desktop shows as its
    # own heading. Recreate those containers under aion-qlib. Volumes and bind
    # mounts stay; never pass -v.
    $ids = docker ps -a --filter "label=com.docker.compose.project=supabase-aq" --format "{{.ID}}"
    if (-not $ids) { return }
    Write-Host "==> Moving Supabase under aion-qlib" -ForegroundColor Cyan
    Push-Location $supabaseDir
    try {
        & docker compose -p supabase-aq down
        if ($LASTEXITCODE -ne 0) { throw "Moving Supabase failed (exit $LASTEXITCODE)" }
    }
    finally { Pop-Location }
}

switch ($Action) {
    'up' {
        Move-SupabaseIntoAionProject
        Invoke-Supabase @('up', '-d') 'Supabase'

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

        Invoke-Platform (@('up', '-d') + $platformServices) 'Platform (api, ui, rag, vibe, agent)'

        Write-Host ''
        Write-Host 'UI       http://127.0.0.1:5274' -ForegroundColor Green
        Write-Host 'API      http://127.0.0.1:8770/api/health' -ForegroundColor Green
        Write-Host 'RAG      http://127.0.0.1:8001/health' -ForegroundColor Green
        Write-Host 'Vibe     http://127.0.0.1:8899/health' -ForegroundColor Green
        Write-Host 'Agent    http://127.0.0.1:8771/health' -ForegroundColor Green
        Write-Host 'Studio   http://127.0.0.1:8010' -ForegroundColor Green
    }

    'down' {
        # Platform only. Do not pass --remove-orphans: that would stop Supabase
        # too, because it now shares project aion-qlib.
        Invoke-Platform @('down') 'Stopping platform (Supabase stays)'
    }

    'restart' {
        & $PSCommandPath down
        & $PSCommandPath up
    }

    'status' {
        Invoke-Platform @('ps', '--format', 'table {{.Name}}\t{{.Status}}') 'Aion platform'
        Invoke-Supabase @('ps', '--format', 'table {{.Name}}\t{{.Status}}') 'Supabase'
    }

    'logs' {
        if (-not $Service) {
            Invoke-Platform @('logs', '-f', '--tail', '50') 'logs: platform'
            return
        }
        if ($Service -in $platformServices) {
            Invoke-Platform @('logs', '-f', '--tail', '100', $Service) "logs: $Service"
        }
        else {
            Invoke-Supabase @('logs', '-f', '--tail', '100', $Service) "logs: $Service"
        }
    }
}
