#!/usr/bin/env bash
# Stop backend server (macOS)
PROJ=$(cd "$(dirname "$0")/.." && pwd)
PID_FILE="$PROJ/.pids/backend.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" && echo "Backend stopped (PID $PID)"
  else
    echo "Backend not running (stale PID $PID)"
  fi
  rm -f "$PID_FILE"
else
  # Fallback: kill by port
  PID=$(lsof -ti tcp:8001 2>/dev/null)
  if [ -n "$PID" ]; then
    kill $PID && echo "Backend stopped (port 8001, PID $PID)"
  else
    echo "Backend not running"
  fi
fi
