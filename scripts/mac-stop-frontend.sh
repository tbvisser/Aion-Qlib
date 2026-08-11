#!/usr/bin/env bash
# Stop frontend dev server (macOS)
PROJ=$(cd "$(dirname "$0")/.." && pwd)
PID_FILE="$PROJ/.pids/frontend.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" && echo "Frontend stopped (PID $PID)"
  else
    echo "Frontend not running (stale PID $PID)"
  fi
  rm -f "$PID_FILE"
else
  PID=$(lsof -ti tcp:5173 2>/dev/null)
  if [ -n "$PID" ]; then
    kill $PID && echo "Frontend stopped (port 5173, PID $PID)"
  else
    echo "Frontend not running"
  fi
fi
