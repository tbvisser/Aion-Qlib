#!/usr/bin/env bash
# Backend health check (macOS)
PORT=8001
RESPONSE=$(curl -sf "http://localhost:$PORT/health" 2>/dev/null)
if [ $? -eq 0 ]; then
  echo "Backend healthy on port $PORT: $RESPONSE"
else
  echo "Backend NOT healthy on port $PORT (is it running?)"
  exit 1
fi
