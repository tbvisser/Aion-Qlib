# scripts/setup-worktree.ps1
# Provision the CURRENT git worktree to run its own isolated backend + frontend
# on a unique port offset, while sharing the main checkout's Supabase database
# and Python venv.
#
#   powershell -File scripts/setup-worktree.ps1             # auto-pick a free offset, share deps
#   powershell -File scripts/setup-worktree.ps1 -Offset 50  # pin an offset (multiple of 10)
#   powershell -File scripts/setup-worktree.ps1 -Force      # re-provision / override a collision
#   powershell -File scripts/setup-worktree.ps1 -NoLinkVenv        # give this worktree its own venv
#   powershell -File scripts/setup-worktree.ps1 -NoLinkNodeModules # do not share frontend deps
#   powershell -File scripts/setup-worktree.ps1 -NoStart           # provision without starting services
#
# What it does:
#   1. Picks a port offset (multiple of 10) not used by sibling worktrees or live ports.
#   2. Copies backend/.env and frontend/.env from the main checkout if missing, so this
#      worktree talks to the SAME shared Supabase DB (intentional - see CLAUDE.md).
#   3. Overrides the port keys: backend CORS_ORIGINS and frontend VITE_API_URL.
#   4. Junctions backend/venv and frontend/node_modules to the main checkout.
#   5. Records the assignment in .worktree-ports.json (read by the start/stop scripts).
#
# To REMOVE a worktree later, use scripts/remove-worktree.ps1 - it unlinks the
# junctions first so a recursive delete cannot wipe the shared venv/node_modules.

param(
    [int]$Offset = -1,
    [switch]$Force,
    [switch]$NoLinkVenv,
    [switch]$LinkNodeModules,
    [switch]$NoLinkNodeModules,
    [switch]$NoTestUsers,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'worktree-lib.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Set-EnvVar {
    # Replace KEY=... in a .env file (or append it), writing UTF-8 without BOM so we
    # neither inject a BOM nor mangle non-ASCII bytes via the ANSI codepage.
    param([string]$Path, [string]$Key, [string]$Value)
    $line = "$Key=$Value"
    if (Test-Path $Path) {
        $content = @(Get-Content -Path $Path)
        if ($content -match "^\s*$([regex]::Escape($Key))=") {
            $content = $content -replace "^\s*$([regex]::Escape($Key))=.*", $line
        } else {
            $content += $line
        }
        [System.IO.File]::WriteAllLines($Path, $content, $script:Utf8NoBom)
    } else {
        [System.IO.File]::WriteAllText($Path, "$line`r`n", $script:Utf8NoBom)
    }
}

function New-DirJunction {
    # Create a directory junction (no admin, no copy). Skips if the shared target is
    # missing or the link path already exists (as a junction or a real folder).
    param([string]$LinkPath, [string]$TargetPath, [string]$Label)
    if (-not (Test-Path $TargetPath)) {
        Write-Host "  skip ${Label}: shared target not found at $TargetPath" -ForegroundColor Yellow
        Write-Host "         (set it up in the main checkout first, or this worktree can't run that part)" -ForegroundColor Yellow
        return
    }
    if (Test-Path $LinkPath) {
        $item = Get-Item $LinkPath -Force
        $isLink = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        if ($isLink) {
            Write-Host "  ${Label}: already a junction (shared) - ok" -ForegroundColor Gray
        } else {
            Write-Host "  skip ${Label}: $LinkPath exists as a real folder; remove it to share" -ForegroundColor Yellow
        }
        return
    }
    New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath -ErrorAction Stop | Out-Null
    Write-Host "  ${Label}: linked to shared $TargetPath (no copy)" -ForegroundColor Gray
}

function Ensure-NpmFallback {
    # Worktree startup scripts prepend .tools\bin to PATH. If this machine has no
    # global npm, mirror the main checkout's ignored npm package via a junction and
    # write a tiny npm.cmd shim for this worktree.
    param([string]$ProjectRoot, [string]$MainRoot)

    $localNpmCmd = Join-Path $ProjectRoot '.tools\bin\npm.cmd'
    if (Test-Path $localNpmCmd) {
        Write-Host "  npm fallback: already present" -ForegroundColor Gray
        return
    }

    if (Get-Command npm -ErrorAction SilentlyContinue) {
        Write-Host "  npm fallback: global npm is available" -ForegroundColor Gray
        return
    }

    $mainNpmPackage = Join-Path $MainRoot '.tools\npm'
    $mainNpmCli = Join-Path $mainNpmPackage 'package\bin\npm-cli.js'
    if (-not (Test-Path $mainNpmCli)) {
        Write-Host "  skip npm fallback: main checkout has no .tools\npm package" -ForegroundColor Yellow
        Write-Host "         install npm globally or recreate the main checkout's .tools fallback" -ForegroundColor Yellow
        return
    }

    New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot '.tools\bin') | Out-Null
    New-DirJunction -LinkPath (Join-Path $ProjectRoot '.tools\npm') -TargetPath $mainNpmPackage -Label '.tools\npm'

    $lines = @(
        '@echo off',
        'set "CODEX_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"',
        'if exist "%CODEX_NODE%" (',
        '  set "PATH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;%PATH%"',
        '  "%CODEX_NODE%" "%~dp0..\npm\package\bin\npm-cli.js" %*',
        ') else (',
        '  node "%~dp0..\npm\package\bin\npm-cli.js" %*',
        ')'
    )
    [System.IO.File]::WriteAllLines($localNpmCmd, $lines, $script:Utf8NoBom)
    Write-Host "  npm fallback: wrote .tools\bin\npm.cmd" -ForegroundColor Gray
}

# --- this must be a linked worktree, not the main checkout ---
if (-not (Test-IsLinkedWorktree -ProjectRoot $projectRoot)) {
    Write-Host "This is the MAIN checkout - it uses canonical ports 8001/5173. Nothing to provision." -ForegroundColor Cyan
    Write-Host "Run this from inside a worktree (.claude\worktrees\<name>) to isolate its ports." -ForegroundColor Gray
    exit 0
}

# --- locate the main checkout (parent of the shared .git common dir) ---
$commonDir = (& git -C $projectRoot rev-parse --git-common-dir 2>$null)
if (-not $commonDir) { Write-Host "Not a git repository: $projectRoot" -ForegroundColor Red; exit 1 }
if (-not [System.IO.Path]::IsPathRooted($commonDir)) {
    $commonDir = Join-Path $projectRoot $commonDir
}
$commonDir = (Resolve-Path $commonDir).Path
$mainRoot  = Split-Path -Parent $commonDir
$leaf      = Split-Path -Leaf $projectRoot

# --- share heavy deps from the main checkout via junctions (no multi-GB copy) ---
# Backend venv is ~5.8 GB (torch alone is 4.2 GB), so it is shared, not duplicated.
if (-not $NoLinkVenv) {
    New-DirJunction -LinkPath (Join-Path $projectRoot 'backend\venv') -TargetPath (Join-Path $mainRoot 'backend\venv') -Label 'backend\venv'
}
if ($LinkNodeModules -and $NoLinkNodeModules) {
    Write-Host "ERROR: pass either -LinkNodeModules or -NoLinkNodeModules, not both." -ForegroundColor Red
    exit 1
}
if (-not $NoLinkNodeModules) {
    New-DirJunction -LinkPath (Join-Path $projectRoot 'frontend\node_modules') -TargetPath (Join-Path $mainRoot 'frontend\node_modules') -Label 'frontend\node_modules'
}
Ensure-NpmFallback -ProjectRoot $projectRoot -MainRoot $mainRoot

$recordPath = Join-Path $projectRoot '.worktree-ports.json'
if ((Test-Path $recordPath) -and -not $Force) {
    Write-Host "Ports already provisioned (.worktree-ports.json exists). Use -Force to re-provision:" -ForegroundColor Yellow
    Get-Content -Raw $recordPath | Write-Host
    exit 0
}

# --- gather offsets already claimed by sibling worktrees ---
$used = @{}
$wtPaths = @()
(& git -C $projectRoot worktree list --porcelain) | ForEach-Object {
    if ($_ -like 'worktree *') { $wtPaths += $_.Substring(9).Trim() }
}
$selfNorm = ($projectRoot -replace '/', '\').TrimEnd('\')
foreach ($p in $wtPaths) {
    $pNorm = ($p -replace '/', '\').TrimEnd('\')
    if ($pNorm -eq $selfNorm) { continue }
    $sib = Join-Path $pNorm '.worktree-ports.json'
    if (Test-Path $sib) {
        try {
            $used[[int]((Get-Content -Raw $sib | ConvertFrom-Json).offset)] = $true
        } catch {
            Write-Host "  WARNING: could not read sibling record $sib ($($_.Exception.Message)); its offset may be reused." -ForegroundColor Yellow
        }
    }
}

# --- choose an offset ---
if ($Offset -ge 0) {
    $chosen = $Offset
    if ($chosen % 10 -ne 0) {
        Write-Host "WARNING: -Offset $chosen is not a multiple of 10; ports from different worktrees may overlap." -ForegroundColor Yellow
    }
    $bePortTry = $CANONICAL_BACKEND_PORT + $chosen
    $fePortTry = $CANONICAL_FRONTEND_PORT + $chosen
    $collision = $used.ContainsKey($chosen) -or (Test-PortInUse $bePortTry) -or (Test-PortInUse $fePortTry)
    if ($collision -and -not $Force) {
        Write-Host "ERROR: offset $chosen collides with a sibling worktree or a live port ($bePortTry/$fePortTry)." -ForegroundColor Red
        Write-Host "Pick another offset, or pass -Force to use it anyway." -ForegroundColor Yellow
        exit 1
    }
} else {
    $chosen = $null
    for ($o = 10; $o -le 2500; $o += 10) {
        if ($used.ContainsKey($o)) { continue }
        if (Test-PortInUse ($CANONICAL_BACKEND_PORT  + $o)) { continue }
        if (Test-PortInUse ($CANONICAL_FRONTEND_PORT + $o)) { continue }
        $chosen = $o; break
    }
    if ($null -eq $chosen) { Write-Host "No free port offset found in range." -ForegroundColor Red; exit 1 }
}

$bePort = $CANONICAL_BACKEND_PORT  + $chosen
$fePort = $CANONICAL_FRONTEND_PORT + $chosen

Write-Host "Provisioning worktree '$leaf' with offset $chosen" -ForegroundColor Green
Write-Host "  backend  : http://localhost:$bePort" -ForegroundColor Yellow
Write-Host "  frontend : http://localhost:$fePort" -ForegroundColor Yellow

# --- provision backend/.env (copied from main = shared Supabase DB) ---
$beEnv     = Join-Path $projectRoot 'backend\.env'
$beEnvMain = Join-Path $mainRoot    'backend\.env'
$beEnvEx   = Join-Path $projectRoot 'backend\.env.example'
if (-not (Test-Path $beEnv)) {
    if (Test-Path $beEnvMain) {
        Copy-Item $beEnvMain $beEnv
        Write-Host "  copied backend/.env from main checkout (shared Supabase DB)" -ForegroundColor Gray
    } elseif (Test-Path $beEnvEx) {
        Copy-Item $beEnvEx $beEnv
        Write-Host "  WARNING: main has no backend/.env; copied .env.example - fill in secrets." -ForegroundColor Yellow
    }
}
if (Test-Path $beEnv) {
    Set-EnvVar -Path $beEnv -Key 'CORS_ORIGINS' -Value "[`"http://localhost:$fePort`"]"
}

# --- provision per-worktree test accounts ---
# The shared Supabase DB has no per-worktree data isolation, so each worktree gets
# its own pair of test accounts (test-wt-<tag>@ admin, test2-wt-<tag>@ non-admin).
# Their creds are written into THIS worktree's backend/.env, so the pytest + Playwright
# suites here use them automatically (both read TEST_USER* from backend/.env). The main
# checkout keeps test@/test2@. remove-worktree.ps1 deletes these; gc-test-users.ps1 reaps
# orphans. Pass -NoTestUsers to skip.
$python     = Join-Path $projectRoot 'backend\venv\Scripts\python.exe'
$provScript = Join-Path $projectRoot 'backend\scripts\provision_test_users.py'
if (-not $NoTestUsers) {
    if ((Test-Path $python) -and (Test-Path $provScript) -and (Test-Path $beEnv)) {
        Write-Host "Provisioning worktree test accounts (tag '$leaf')..." -ForegroundColor Cyan
        # EAP=Continue around the native call: the helper logs to stderr, and native
        # stderr under 'Stop' raises a terminating NativeCommandError. Capture both
        # streams; the single stdout JSON line is the creds, stderr lines are progress.
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $provOut  = & $python $provScript --tag $leaf 2>&1
        $provExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP
        $creds = $null
        foreach ($line in @($provOut)) {
            $s = "$line".Trim()
            if ($s.StartsWith('{')) { try { $creds = $s | ConvertFrom-Json } catch { } }
        }
        if ($provExit -eq 0 -and $creds) {
            Set-EnvVar -Path $beEnv -Key 'TEST_USER1_EMAIL'    -Value $creds.user1.email
            Set-EnvVar -Path $beEnv -Key 'TEST_USER1_PASSWORD' -Value $creds.user1.password
            Set-EnvVar -Path $beEnv -Key 'TEST_USER2_EMAIL'    -Value $creds.user2.email
            Set-EnvVar -Path $beEnv -Key 'TEST_USER2_PASSWORD' -Value $creds.user2.password
            Write-Host "  test accounts: $($creds.user1.email) (admin), $($creds.user2.email)" -ForegroundColor Gray
        } else {
            Write-Host "  WARNING: test-account provisioning failed (exit $provExit)." -ForegroundColor Red
            Write-Host "  This worktree still has the main checkout's TEST_USER* creds - NOT safe" -ForegroundColor Red
            Write-Host "  for parallel test runs. Fix and re-run, or pass -NoTestUsers to skip." -ForegroundColor Red
            $provOut | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        }
    } else {
        Write-Host "  skip test accounts: python/script/.env not all present" -ForegroundColor Yellow
    }
}

# --- provision frontend/.env ---
$feEnv     = Join-Path $projectRoot 'frontend\.env'
$feEnvMain = Join-Path $mainRoot    'frontend\.env'
$feEnvEx   = Join-Path $projectRoot 'frontend\.env.example'
if (-not (Test-Path $feEnv)) {
    if (Test-Path $feEnvMain) {
        Copy-Item $feEnvMain $feEnv
        Write-Host "  copied frontend/.env from main checkout" -ForegroundColor Gray
    } elseif (Test-Path $feEnvEx) {
        Copy-Item $feEnvEx $feEnv
        Write-Host "  WARNING: main has no frontend/.env; copied .env.example - fill in values." -ForegroundColor Yellow
    }
}
if (Test-Path $feEnv) {
    Set-EnvVar -Path $feEnv -Key 'VITE_API_URL' -Value "http://localhost:$bePort"
}

# --- record the assignment (gitignored; read by start/stop scripts) ---
$record = [ordered]@{
    offset       = $chosen
    backendPort  = $bePort
    frontendPort = $fePort
    tag          = $leaf
}
[System.IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json), $Utf8NoBom)
Write-Host "  wrote .worktree-ports.json" -ForegroundColor Gray

# --- start this worktree's services (default; pass -NoStart to skip) ---
# start-all.ps1 derives its own project root, so the worktree's own copy starts the
# worktree's stack on its isolated ports. Run it in a CHILD powershell so any exit /
# Assert inside the start scripts can never abort this provisioning run.
if (-not $NoStart) {
    $startAll = Join-Path $projectRoot 'scripts\start-all.ps1'
    if (Test-Path $startAll) {
        Write-Host "Starting this worktree's services (backend + frontend)..." -ForegroundColor Green
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        & powershell -NoProfile -ExecutionPolicy Bypass -File $startAll 2>&1 |
            ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
        $ErrorActionPreference = $prevEAP
        Write-Host "Services launching in their own windows (backend :$bePort, frontend :$fePort)." -ForegroundColor Green
        if ($NoLinkNodeModules) {
            Write-Host "  Note: the frontend needs node_modules - install dependencies in frontend if it failed to start." -ForegroundColor Gray
        }
    } else {
        Write-Host "Done. Start this worktree's stack with: powershell -File scripts/start-all.ps1" -ForegroundColor Green
    }
} else {
    Write-Host "Done (-NoStart). Start this worktree's stack with: powershell -File scripts/start-all.ps1" -ForegroundColor Green
}
