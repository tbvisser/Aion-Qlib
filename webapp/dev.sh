#!/usr/bin/env bash
# Dev launcher for AION.
#
#   ./webapp/dev.sh api     # FastAPI on 127.0.0.1:8770 (reload)
#   ./webapp/dev.sh ui      # Vite on  127.0.0.1:5274 (proxies /api -> 8770)
#   ./webapp/dev.sh both    # both, in one terminal
#
# Both bind to localhost only: there is no auth, and the EODHD / OpenRouter
# keys live in the API process.
set -euo pipefail

WEBAPP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$WEBAPP_DIR")"
VENV_PY="$REPO_ROOT/.venv/bin/python"

if [[ ! -x "$VENV_PY" ]]; then
    echo "error: $VENV_PY not found. Create it with:" >&2
    echo "    ./scripts/setup-venv.sh" >&2
    echo "or use the Docker stack instead — see ONBOARDING.md." >&2
    exit 1
fi

start_api() {
    cd "$REPO_ROOT"
    exec "$REPO_ROOT/.venv/bin/uvicorn" webapp.api.main:app \
        --host 127.0.0.1 --port 8770 --reload --reload-dir webapp/api
}

start_ui() {
    cd "$WEBAPP_DIR/ui"
    [[ -d node_modules ]] || npm install
    # Demo scheduled tasks make the Scheduled tab usable for a pitch on a fresh
    # workspace. Override with VITE_DEMO_SCHEDULED_TASKS=false to suppress.
    export VITE_DEMO_SCHEDULED_TASKS=${VITE_DEMO_SCHEDULED_TASKS:-true}
    exec npm run dev
}

case "${1:-both}" in
    api) start_api ;;
    ui)  start_ui ;;
    both)
        start_api & API_PID=$!
        start_ui  & UI_PID=$!
        trap 'kill $API_PID $UI_PID 2>/dev/null || true' INT TERM
        wait
        ;;
    *)
        echo "usage: $0 {api|ui|both}" >&2
        exit 2
        ;;
esac
