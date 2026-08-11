# Push filtered copy to public remote
# Run from project root: powershell -File scripts/push-public.ps1
#
# Maintains a 'public-release' branch that mirrors master but excludes
# dev-specific folders. Merges master into public-release, removes the
# excluded folders, and pushes to the public remote. Preserves full
# commit history - episode tags and old commits remain intact.
#
# First run creates the branch. Subsequent runs merge new changes.

param(
    [string]$Remote = "public",
    [string]$TargetBranch = "master",
    [switch]$DryRun
)

$LocalBranch = "public-release"

# Folders to exclude from the public repo
$ExcludeFolders = @(
    "_bmad-output",
    "archive",
    ".github",
    ".claude",
    ".agent",
    "docs/superpowers"
)

# Extra .gitignore entries for the public branch so these folders
# don't show as untracked if someone creates them locally
$IgnoreEntries = @(
    "",
    "# Dev-specific folders (not part of the distributable app)",
    "_bmad-output/",
    "archive/",
    ".github/",
    ".claude/",
    ".agent/",
    "docs/superpowers/"
)

# --- Determine project root ---
if ($MyInvocation.MyCommand.Path) {
    $projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
} elseif ($PSScriptRoot) {
    $projectRoot = Split-Path -Parent $PSScriptRoot
} else {
    $projectRoot = Get-Location
}
Set-Location $projectRoot

# --- Preflight checks ---
$currentBranch = git rev-parse --abbrev-ref HEAD 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Not in a git repository." -ForegroundColor Red
    exit 1
}

$remoteUrl = git remote get-url $Remote 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Remote '$Remote' not found. Available remotes:" -ForegroundColor Red
    git remote -v
    exit 1
}

# Check for uncommitted changes
$status = git status --porcelain 2>$null
$hasChanges = $status -and $status.Trim().Length -gt 0

Write-Host "=== Push to Public Remote ===" -ForegroundColor Cyan
Write-Host "Source branch : $currentBranch"
Write-Host "Public branch : $LocalBranch"
Write-Host "Remote        : $Remote ($remoteUrl)"
Write-Host "Excluding     : $($ExcludeFolders -join ', ')"
Write-Host ""

if ($DryRun) {
    Write-Host "[DRY RUN] Would merge $currentBranch into $LocalBranch and push to $Remote/$TargetBranch" -ForegroundColor Yellow
    foreach ($folder in $ExcludeFolders) {
        $files = git ls-files "$folder" 2>$null
        if ($files) {
            Write-Host "  Would exclude: $folder/ ($(@($files).Count) files)" -ForegroundColor Yellow
        }
    }
    exit 0
}

# --- Stash uncommitted changes if needed ---
if ($hasChanges) {
    Write-Host "Stashing uncommitted changes..." -ForegroundColor Gray
    git stash push -m "push-public: auto-stash" --include-untracked --quiet 2>$null
}

# --- Check if public-release branch exists ---
$branchExists = git rev-parse --verify $LocalBranch 2>$null
$isFirstRun = $LASTEXITCODE -ne 0

try {
    if ($isFirstRun) {
        # --- First run: create branch from current HEAD ---
        Write-Host "Creating '$LocalBranch' branch (first run)..." -ForegroundColor Gray
        git checkout -b $LocalBranch 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create branch '$LocalBranch'"
        }

        # Remove excluded folders
        foreach ($folder in $ExcludeFolders) {
            $files = git ls-files "$folder" 2>$null
            if ($files) {
                git rm -rf "$folder" --quiet 2>$null
                Write-Host "  Removed: $folder/" -ForegroundColor DarkGray
            }
        }

        # Add exclusions to .gitignore on this branch
        $gitignorePath = Join-Path $projectRoot ".gitignore"
        $gitignoreContent = Get-Content $gitignorePath -Raw
        $needsUpdate = $false
        foreach ($entry in $ExcludeFolders) {
            if ($gitignoreContent -notmatch [regex]::Escape("$entry/")) {
                $needsUpdate = $true
                break
            }
        }
        if ($needsUpdate) {
            $IgnoreEntries | ForEach-Object { Add-Content -Path $gitignorePath -Value $_ }
            git add .gitignore 2>$null
            Write-Host "  Updated .gitignore with exclusions" -ForegroundColor DarkGray
        }

        git add -A 2>$null
        git commit -m "chore: remove dev-specific folders from public distribution" --quiet 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create initial filtered commit"
        }
        Write-Host "  Created initial filtered commit" -ForegroundColor DarkGray

    } else {
        # --- Subsequent run: merge master into public-release ---
        Write-Host "Switching to '$LocalBranch' branch..." -ForegroundColor Gray
        git checkout $LocalBranch --quiet 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to checkout '$LocalBranch'"
        }

        # Check if there's anything new to merge
        $mergeBase = git merge-base $LocalBranch $currentBranch 2>$null
        $masterHead = git rev-parse $currentBranch 2>$null

        if ($mergeBase -eq $masterHead) {
            Write-Host "Already up to date - nothing new to push." -ForegroundColor Green
            git checkout $currentBranch --quiet 2>$null
            if ($hasChanges) { git stash pop --quiet 2>$null }
            exit 0
        }

        Write-Host "Merging $currentBranch into $LocalBranch..." -ForegroundColor Gray

        # Merge without committing so we can remove folders first
        git merge $currentBranch --no-commit --no-edit 2>$null

        # Remove excluded folders (merge may have re-added them from master)
        $hasRemovals = $false
        foreach ($folder in $ExcludeFolders) {
            if (Test-Path $folder) {
                git rm -rf "$folder" --quiet 2>$null
                $hasRemovals = $true
                Write-Host "  Removed: $folder/" -ForegroundColor DarkGray
            }
        }

        # Ensure .gitignore still has our exclusions
        $gitignorePath = Join-Path $projectRoot ".gitignore"
        if (Test-Path $gitignorePath) {
            $gitignoreContent = Get-Content $gitignorePath -Raw
            $needsUpdate = $false
            foreach ($entry in $ExcludeFolders) {
                if ($gitignoreContent -notmatch [regex]::Escape("$entry/")) {
                    $needsUpdate = $true
                    break
                }
            }
            if ($needsUpdate) {
                $IgnoreEntries | ForEach-Object { Add-Content -Path $gitignorePath -Value $_ }
                git add .gitignore 2>$null
            }
        }

        git add -A 2>$null
        $shortSha = git rev-parse --short $currentBranch 2>$null
        git commit -m "Merge $currentBranch ($shortSha) for public release" --quiet --allow-empty 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create merge commit"
        }
        Write-Host "  Merge commit created" -ForegroundColor DarkGray
    }

    # --- Push to public remote ---
    Write-Host "Pushing to $Remote/$TargetBranch..." -ForegroundColor Gray
    git push $Remote "${LocalBranch}:${TargetBranch}" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Push to $Remote failed"
    }

    # --- Push tags too ---
    Write-Host "Pushing tags..." -ForegroundColor Gray
    git push $Remote --tags 2>&1

    Write-Host ""
    Write-Host "Done! Public remote updated." -ForegroundColor Green
    Write-Host "  $remoteUrl ($TargetBranch)"

} catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
} finally {
    # Always switch back and restore stash
    git checkout $currentBranch --force --quiet 2>$null
    if ($hasChanges) {
        git stash pop --quiet 2>$null
        Write-Host "Restored stashed changes." -ForegroundColor Gray
    }
}
