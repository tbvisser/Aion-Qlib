#!/usr/bin/env bash
# Start backend + frontend (macOS)
# Usage: bash scripts/mac-start-all.sh
PROJ=$(cd "$(dirname "$0")/.." && pwd)
bash "$PROJ/scripts/mac-start-backend.sh" "$@"
bash "$PROJ/scripts/mac-start-frontend.sh"
echo ""
echo "Services starting. Check health: bash scripts/mac-health-check.sh"
