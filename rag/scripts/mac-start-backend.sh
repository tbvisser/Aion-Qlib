#!/usr/bin/env bash
# Start backend server (macOS)
# Usage: bash scripts/mac-start-backend.sh [--no-reload]
# Runs uvicorn in the background; logs to logs/backend.log

set -e
PROJ=$(cd "$(dirname "$0")/.." && pwd)
LOGS="$PROJ/logs"; mkdir -p "$LOGS"
PIDS="$PROJ/.pids"; mkdir -p "$PIDS"

PORT=8001

echo "Starting backend on http://localhost:$PORT ..."
if [ ! -f "$PROJ/backend/.env" ]; then
  echo "WARNING: backend/.env not found — copy backend/.env.example and fill in credentials."
fi

# Activate venv
source "$PROJ/backend/venv/bin/activate"
cd "$PROJ/backend"

nohup python -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT" \
  > "$LOGS/backend.log" 2>&1 &
echo $! > "$PIDS/backend.pid"
echo "Backend PID $! — tail -f logs/backend.log"
