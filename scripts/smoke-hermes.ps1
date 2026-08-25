# Smoke-test Hermes gateway + Aion API health proxy.
$ErrorActionPreference = "Stop"

$Gateway = if ($env:HERMES_GATEWAY_URL) { $env:HERMES_GATEWAY_URL } else { "http://127.0.0.1:8642" }
$Api = if ($env:AION_API_URL) { $env:AION_API_URL } else { "http://127.0.0.1:8770" }

Write-Host "== hermes gateway port (TCP) =="
$uri = [Uri]$Gateway.TrimEnd('/')
$tcp = New-Object System.Net.Sockets.TcpClient
try {
  $tcp.Connect($uri.Host, $(if ($uri.Port -gt 0) { $uri.Port } else { 8642 }))
  Write-Host "TCP open on $($uri.Host):$($uri.Port)"
} finally {
  $tcp.Close()
}

Write-Host "== hermes gateway status (in container) =="
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -T hermes-gateway hermes gateway status 2>&1

Write-Host "== probe from api container =="
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -T api python -c "
from webapp.api.config import get_settings
from webapp.api.hermes_gateway_probe import probe_hermes_gateway
import json
print(json.dumps(probe_hermes_gateway(get_settings()), indent=2))
" 2>&1

Write-Host "OK"
