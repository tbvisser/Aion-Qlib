# Stop Frontend Server
# Run from project root: powershell -File scripts/stop-frontend.ps1
# Stops only THIS worktree's frontend (its port + titled window).

$ErrorActionPreference = "Stop"

if ($PSScriptRoot) { $projectRoot = Split-Path -Parent $PSScriptRoot } else { $projectRoot = (Get-Location).Path }
. (Join-Path $projectRoot 'scripts\worktree-lib.ps1')
$cfg = Get-WorktreePortConfig -ProjectRoot $projectRoot
Assert-WorktreeProvisioned -Config $cfg
$port = $cfg.FrontendPort
$windowTitle = "RAG-Frontend-$($cfg.Tag)"

Write-Host "Stopping frontend server (port $port)..." -ForegroundColor Yellow

$killed = $false

# Method 1: Find the titled PowerShell window and kill it (closes window + child processes)
$titleProcs = Get-Process powershell -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -eq $windowTitle }
foreach ($proc in $titleProcs) {
    Write-Host "  Closing $windowTitle window (PID: $($proc.Id))" -ForegroundColor Red
    taskkill /PID $proc.Id /T /F 2>$null
    $killed = $true
}

# Method 2: Fallback - kill by port if no titled window found
if (-not $killed) {
    try {
        $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($connections) {
            $processIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -ne 0 }
            foreach ($procId in $processIds) {
                $process = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if ($process) {
                    Write-Host "  Killing process: $($process.ProcessName) (PID: $procId)" -ForegroundColor Red
                    taskkill /PID $procId /T /F 2>$null
                    $killed = $true
                }
            }
        }
    } catch {
        Write-Host "  Get-NetTCPConnection failed, trying netstat..." -ForegroundColor Gray
    }
}

# Method 3: Fallback using netstat
if (-not $killed) {
    $netstatOutput = netstat -ano | Select-String ":$port\b.*LISTENING"
    if ($netstatOutput) {
        foreach ($line in $netstatOutput) {
            $parts = $line -split '\s+'
            $procId = $parts[-1]
            if ($procId -and $procId -ne '0') {
                $process = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if ($process) {
                    Write-Host "  Killing process: $($process.ProcessName) (PID: $procId)" -ForegroundColor Red
                    taskkill /PID $procId /T /F 2>$null
                    $killed = $true
                }
            }
        }
    }
}

# Verify it's stopped
Start-Sleep -Milliseconds 500
$stillRunning = netstat -ano | Select-String ":$port\b.*LISTENING"
if ($stillRunning) {
    Write-Host "WARNING: Frontend may still be running. Try running as Administrator." -ForegroundColor Red
    Write-Host $stillRunning -ForegroundColor Gray
} elseif ($killed) {
    Write-Host "Frontend server stopped." -ForegroundColor Green
} else {
    Write-Host "No frontend server running on port $port." -ForegroundColor Cyan
}
