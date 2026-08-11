#!/usr/bin/env bash
# Start frontend dev server (macOS)
# Usage: bash scripts/mac-start-frontend.sh
# Runs vite in the background; logs to logs/frontend.log

set -e
PROJ=$(cd "$(dirname "$0")/.." && pwd)
LOGS="$PROJ/logs"; mkdir -p "$LOGS"
PIDS="$PROJ/.pids"; mkdir -p "$PIDS"

cd "$PROJ/frontend"
echo "Starting frontend on http://localhost:5173 ..."
nohup npm run dev > "$LOGS/frontend.log" 2>&1 &
echo $! > "$PIDS/frontend.pid"
echo "Frontend PID $! — tail -f logs/frontend.log"
