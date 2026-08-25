# Smoke-test the Aion MCP server: health -> initialize -> get_data_status
$ErrorActionPreference = "Stop"

$Base = if ($env:AION_MCP_URL) { $env:AION_MCP_URL } else { "http://127.0.0.1:8910" }
$Mcp = "$($Base.TrimEnd('/'))/mcp"
$Token = $env:AION_MCP_TOKEN

$headers = @{
    "Content-Type" = "application/json"
    "Accept" = "application/json"
    "MCP-Protocol-Version" = "2025-03-26"
}
if ($Token) { $headers["Authorization"] = "Bearer $Token" }

Write-Host "== health =="
(Invoke-RestMethod -Uri "$Base/health" -Headers $headers) | ConvertTo-Json

Write-Host "== initialize =="
$initBody = @{
    jsonrpc = "2.0"
    id = 1
    method = "initialize"
    params = @{
        protocolVersion = "2025-03-26"
        capabilities = @{}
        clientInfo = @{ name = "smoke"; version = "1.0" }
    }
} | ConvertTo-Json -Depth 5

$initResponse = Invoke-WebRequest -Uri $Mcp -Method POST -Headers $headers -Body $initBody -UseBasicParsing
$session = $initResponse.Headers['mcp-session-id']
if (-not $session) { $session = $initResponse.Headers['Mcp-Session-Id'] }
if (-not $session) { throw "MCP initialize did not return mcp-session-id header" }
$initResponse.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10

Write-Host "== tools/call get_data_status =="
$callHeaders = $headers.Clone()
$callHeaders["mcp-session-id"] = $session
$callBody = @{
    jsonrpc = "2.0"
    id = 2
    method = "tools/call"
    params = @{ name = "get_data_status"; arguments = @{} }
} | ConvertTo-Json -Depth 5

(Invoke-RestMethod -Uri $Mcp -Method POST -Headers $callHeaders -Body $callBody) |
    ConvertTo-Json -Depth 10

Write-Host "OK"
