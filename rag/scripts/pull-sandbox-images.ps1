Write-Host "Building custom sandbox Python image..."
docker build -t sandbox-python:latest "$PSScriptRoot\..\backend\sandbox"
Write-Host "Done."
