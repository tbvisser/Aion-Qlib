# Copy Hermes env template (Windows).
$ErrorActionPreference = "Stop"
$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$Env = Join-Path $Root "hermes\.env"
$Example = Join-Path $Root "hermes\.env.example"

if (Test-Path $Env) {
    Write-Host "hermes/.env already exists — not overwriting."
} else {
    Copy-Item $Example $Env
    Write-Host "Created hermes/.env from template."
}

Write-Host @"

Next steps:
  1. Set OPENROUTER_API_KEY in hermes/.env (Hermes LLM).
  2. Set AION_MCP_TOKEN and VIBE_API_TOKEN to match webapp/.env.
  3. Start:
       docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d aion-mcp hermes-gateway
  4. Smoke-test:
       powershell -ExecutionPolicy Bypass -File scripts/smoke-aion-mcp.ps1

"@
