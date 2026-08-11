# scripts/worktree-lib.ps1
# Shared helpers for per-worktree port isolation.
# Dot-source from other scripts:  . (Join-Path $projectRoot 'scripts\worktree-lib.ps1')
#
# Each git worktree can run its own backend + frontend on an isolated port
# "offset" so multiple worktrees (e.g. parallel AI agents) don't collide on
# 8001 / 5173. The shared Supabase database and Python venv are intentionally
# NOT isolated. Ports are recorded per worktree in <root>\.worktree-ports.json by
# scripts/setup-worktree.ps1. Absent that file (e.g. the main checkout), the
# canonical ports are used.
#
# Note: the sandbox bridge has NO dedicated port - its router is mounted on the
# main FastAPI app, so it rides the (already-isolated) backend port. There is
# deliberately no bridge port here.

# Canonical ports for the main checkout (offset 0).
$CANONICAL_BACKEND_PORT  = 8001
$CANONICAL_FRONTEND_PORT = 5173

function Test-IsLinkedWorktree {
    # A linked git worktree has a .git FILE (a gitdir: pointer); the main checkout
    # has a .git DIRECTORY. This needs no git call and works before provisioning.
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    return (Test-Path (Join-Path $ProjectRoot '.git') -PathType Leaf)
}

function Get-WorktreePortConfig {
    # Returns a port-config object for the given project root, reading
    # .worktree-ports.json if present and valid, else the canonical (main) ports.
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)

    $isLinked = Test-IsLinkedWorktree -ProjectRoot $ProjectRoot
    $recordPath = Join-Path $ProjectRoot '.worktree-ports.json'
    if (Test-Path $recordPath) {
        try {
            $rec = Get-Content -Raw -Path $recordPath | ConvertFrom-Json
            $be = [int]$rec.backendPort
            $fe = [int]$rec.frontendPort
            if ($be -gt 0 -and $fe -gt 0 -and $rec.tag) {
                return [pscustomobject]@{
                    Offset           = [int]$rec.offset
                    BackendPort      = $be
                    FrontendPort     = $fe
                    Tag              = [string]$rec.tag
                    Provisioned      = $true
                    IsLinkedWorktree = $isLinked
                }
            }
            Write-Host "  WARNING: $recordPath has missing/invalid port fields; ignoring it." -ForegroundColor Yellow
        } catch {
            Write-Host "  WARNING: $recordPath is unreadable ($($_.Exception.Message)); ignoring it." -ForegroundColor Yellow
        }
    }
    return [pscustomobject]@{
        Offset           = 0
        BackendPort      = $CANONICAL_BACKEND_PORT
        FrontendPort     = $CANONICAL_FRONTEND_PORT
        Tag              = 'main'
        Provisioned      = $false
        IsLinkedWorktree = $isLinked
    }
}

function Test-PortInUse {
    # True if something is LISTENing on the given local TCP port.
    param([Parameter(Mandatory = $true)][int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return [bool]$conn
}

function Assert-WorktreeProvisioned {
    # Refuse to fall back to canonical ports (8001/5173) from inside an
    # UNPROVISIONED linked worktree - that would collide with, and let stop/restart
    # kill, the main checkout's servers. The main checkout itself is never blocked.
    param([Parameter(Mandatory = $true)]$Config)
    if ($Config.IsLinkedWorktree -and -not $Config.Provisioned) {
        Write-Host "ERROR: this worktree is not provisioned (no .worktree-ports.json)." -ForegroundColor Red
        Write-Host "Run first:  powershell -File scripts/setup-worktree.ps1" -ForegroundColor Yellow
        Write-Host "Refusing to use canonical ports 8001/5173 from a worktree (would clash with the main checkout)." -ForegroundColor Yellow
        exit 1
    }
}
