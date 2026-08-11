# Generate a Fernet encryption key for SETTINGS_ENCRYPTION_KEY
# Run this script during first-time setup

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $scriptPath "..\backend"
$venvPython = Join-Path $backendPath "venv\Scripts\python.exe"

if (Test-Path $venvPython) {
    & $venvPython "$scriptPath\generate-encryption-key.py"
} else {
    Write-Host "Backend venv not found. Using system Python..." -ForegroundColor Yellow
    python "$scriptPath\generate-encryption-key.py"
}
