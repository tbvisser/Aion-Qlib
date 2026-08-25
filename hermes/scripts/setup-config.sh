#!/usr/bin/env bash
# Copy Hermes env template and remind which keys must match webapp/.env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV="$ROOT/hermes/.env"
EXAMPLE="$ROOT/hermes/.env.example"

if [ -f "$ENV" ]; then
  echo "hermes/.env already exists — not overwriting."
else
  cp "$EXAMPLE" "$ENV"
  echo "Created hermes/.env from template."
fi

cat <<'EOF'

Next steps:
  1. Set OPENROUTER_API_KEY (Hermes LLM — separate from Aion chat usage).
  2. Set AION_MCP_TOKEN and VIBE_API_TOKEN to match webapp/.env.
  3. Start the stack:
       docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d aion-mcp hermes-gateway
  4. Smoke-test MCP:
       ./scripts/smoke-aion-mcp.sh
  5. Optional: configure Telegram/Discord in hermes/.env, then restart gateway.

EOF
