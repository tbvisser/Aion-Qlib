#!/usr/bin/env bash
# Apply pending DB migrations to local Docker Supabase (macOS)
# Usage: bash scripts/mac-run-migrations-local.sh [--sync] [--container supabase-db]
# Safe to re-run — skips already-applied migrations.

set -euo pipefail
PROJ=$(cd "$(dirname "$0")/.." && pwd)
MIGRATIONS_DIR="$PROJ/supabase/migrations"
CONTAINER="supabase-db"
SYNC=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --sync) SYNC=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Verify container is running
if ! docker ps --filter "name=$CONTAINER" --format "{{.Names}}" | grep -q "^${CONTAINER}$"; then
  echo "ERROR: Docker container '$CONTAINER' is not running."
  echo "Start Supabase: docker compose up -d (from your Supabase directory)"
  exit 1
fi

# Ensure migration tracking table exists
docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 <<'SQL' 2>/dev/null
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
    version text NOT NULL PRIMARY KEY,
    statements text[],
    name text
);
SQL

# Get already-applied migration names
APPLIED=$(docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres -t -A \
  -c "SELECT name FROM supabase_migrations.schema_migrations;" 2>/dev/null || true)

echo "Running database migrations (local Docker)..."
echo "  Container: $CONTAINER"
echo "  Migrations dir: $MIGRATIONS_DIR"

APPLIED_COUNT=0; SKIPPED=0; FAILED=0

for FILE in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  BASENAME=$(basename "$FILE" .sql)
  VERSION="${BASENAME%%_*}"
  NAME="${BASENAME#*_}"

  if echo "$APPLIED" | grep -qx "$NAME"; then
    SKIPPED=$((SKIPPED+1))
    continue
  fi

  if $SYNC; then
    docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres \
      -c "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('$VERSION', '$NAME') ON CONFLICT (version) DO NOTHING;" 2>/dev/null
    echo "  Registered: $(basename "$FILE")"
    APPLIED_COUNT=$((APPLIED_COUNT+1))
    continue
  fi

  printf "  Applying: %s..." "$(basename "$FILE")"
  if docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres \
      -v ON_ERROR_STOP=1 < "$FILE" 2>/dev/null; then
    docker exec -i "$CONTAINER" psql -U supabase_admin -d postgres \
      -c "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('$VERSION', '$NAME') ON CONFLICT (version) DO NOTHING;" 2>/dev/null
    echo " OK"
    APPLIED_COUNT=$((APPLIED_COUNT+1))
  else
    echo " FAILED"
    FAILED=$((FAILED+1))
    echo "Migration failed. Fix the issue and re-run."
    echo "If already applied via MCP, run with --sync to register them."
    exit 1
  fi
done

echo ""
if $SYNC; then
  echo "Sync complete. Registered: $APPLIED_COUNT | Already tracked: $SKIPPED"
elif [ "$APPLIED_COUNT" -eq 0 ]; then
  echo "All $SKIPPED migrations already applied. Database is up to date."
else
  echo "Migrations complete. Applied: $APPLIED_COUNT | Skipped: $SKIPPED"
fi
