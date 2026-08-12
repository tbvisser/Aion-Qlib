#!/usr/bin/env bash
# Stop backend + frontend (macOS)
PROJ=$(cd "$(dirname "$0")/.." && pwd)
bash "$PROJ/scripts/mac-stop-backend.sh"
bash "$PROJ/scripts/mac-stop-frontend.sh"
