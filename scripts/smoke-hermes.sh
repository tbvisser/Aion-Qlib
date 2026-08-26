#!/usr/bin/env bash
# Smoke-test Hermes gateway + Aion API health probe.
set -euo pipefail

GATEWAY="${HERMES_GATEWAY_URL:-http://127.0.0.1:8642}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== hermes gateway status (in container) =="
docker compose -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.dev.yml" \
  exec -T hermes-gateway hermes gateway status

echo "== probe from api container =="
docker compose -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.dev.yml" \
  exec -T api python -c "
from webapp.api.config import get_settings
from webapp.api.hermes_gateway_probe import probe_hermes_gateway
import json
print(json.dumps(probe_hermes_gateway(get_settings()), indent=2))
"

echo "OK"
