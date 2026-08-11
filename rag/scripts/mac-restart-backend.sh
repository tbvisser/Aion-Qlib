#!/usr/bin/env bash
# Restart backend server (macOS)
PROJ=$(cd "$(dirname "$0")/.." && pwd)
bash "$PROJ/scripts/mac-stop-backend.sh"
sleep 1
bash "$PROJ/scripts/mac-start-backend.sh" "$@"
