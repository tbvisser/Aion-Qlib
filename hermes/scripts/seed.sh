#!/bin/sh
# Seed Hermes config on first boot (runs as root; /hermes-data volume is root-owned).
set -eu

DATA="${HERMES_HOME:-/hermes-data}"
SEED=/opt/aion-seed

mkdir -p "${DATA}/workspace"

if [ ! -f "${DATA}/config.yaml" ]; then
  cp "${SEED}/config/config.yaml" "${DATA}/config.yaml"
fi

if [ ! -f "${DATA}/workspace/AGENTS.md" ]; then
  cp "${SEED}/workspace/AGENTS.md" "${DATA}/workspace/AGENTS.md"
fi

if [ ! -f "${DATA}/gateway-config.yaml" ] && [ -f "${SEED}/config/gateway-config.yaml.example" ]; then
  cp "${SEED}/config/gateway-config.yaml.example" "${DATA}/gateway-config.yaml"
fi

touch "${DATA}/.env"
merge_env() {
  key="$1"
  eval "val=\${$key:-}"
  if [ -n "$val" ]; then
    tmp="${DATA}/.env.$$.tmp"
    grep -v "^${key}=" "${DATA}/.env" > "$tmp" 2>/dev/null || : > "$tmp"
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
    mv "$tmp" "${DATA}/.env"
  fi
}

merge_env OPENROUTER_API_KEY
merge_env ANTHROPIC_API_KEY
merge_env OPENAI_API_KEY
merge_env NOUS_API_KEY
merge_env AION_MCP_TOKEN
merge_env VIBE_API_TOKEN
merge_env TELEGRAM_BOT_TOKEN
merge_env DISCORD_BOT_TOKEN
