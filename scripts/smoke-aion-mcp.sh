#!/usr/bin/env bash
# Smoke-test the Aion MCP server: health → initialize → tools/list → get_data_status
set -euo pipefail

BASE="${AION_MCP_URL:-http://127.0.0.1:8910}"
MCP="${BASE%/}/mcp"
TOKEN="${AION_MCP_TOKEN:-}"

auth_args=()
if [[ -n "$TOKEN" ]]; then
  auth_args=(-H "Authorization: Bearer ${TOKEN}")
fi

echo "== health =="
curl -fsS "${auth_args[@]}" "${BASE}/health" | python -m json.tool

echo "== initialize =="
init_headers=$(mktemp)
init_body=$(curl -fsS "${auth_args[@]}" -D "$init_headers" -o /tmp/aion-mcp-init.json \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "MCP-Protocol-Version: 2025-03-26" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}' \
  "$MCP")
session=$(grep -i '^mcp-session-id:' "$init_headers" | awk '{print $2}' | tr -d '\r')
python -m json.tool /tmp/aion-mcp-init.json

echo "== notifications/initialized =="
curl -fsS "${auth_args[@]}" -o /dev/null -w "HTTP %{http_code}\n" \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: ${session}" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  "$MCP"

echo "== tools/call get_data_status =="
curl -fsS "${auth_args[@]}" \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: ${session}" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_data_status","arguments":{}}}' \
  "$MCP" | python -m json.tool

echo "OK"
