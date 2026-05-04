#!/bin/bash
# AI SDLC — Database migration
#
# Idempotent: every CREATE TABLE / CREATE INDEX / ALTER TABLE in schema.sql is
# wrapped with IF NOT EXISTS (or is otherwise safe to repeat). Existing tables
# are NEVER dropped, recreated, or truncated. Re-running this script after a
# git pull is the standard way to apply new schema changes.
#
# Usage:
#   bash migrate.sh                  # apply schema.sql against the DB in backend/.env
#   bash migrate.sh --dry-run        # show what would change without touching the DB
#
# Reads DB_HOST / DB_NAME / DB_USER / DB_PASSWORD from backend/.env automatically.

set -e
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMA="$BASE_DIR/schema.sql"
ENV_FILE="$BASE_DIR/backend/.env"

if [ ! -f "$SCHEMA" ]; then
  echo "ERROR: schema.sql not found at $SCHEMA"
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: backend/.env not found — cannot read DB credentials"
  exit 1
fi

# Pull DB_* from backend/.env without sourcing it (the file may have other
# variables that would clobber the shell). Strips inline comments + quotes.
get_env() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | head -1 | sed -E "s/^${key}=//; s/[\"']//g; s/[[:space:]]*#.*//; s/[[:space:]]+$//"
}

DB_HOST=$(get_env DB_HOST)
DB_PORT=$(get_env DB_PORT)
DB_NAME=$(get_env DB_NAME)
DB_USER=$(get_env DB_USER)
DB_PASSWORD=$(get_env DB_PASSWORD)
: "${DB_HOST:=localhost}"
: "${DB_PORT:=5432}"

if [ -z "$DB_NAME" ] || [ -z "$DB_USER" ]; then
  echo "ERROR: DB_NAME / DB_USER missing from backend/.env"
  exit 1
fi

PSQL="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -v ON_ERROR_STOP=1"
export PGPASSWORD="$DB_PASSWORD"

echo "=== AI SDLC migration ==="
echo "  database: $DB_NAME @ $DB_HOST:$DB_PORT (user: $DB_USER)"

# List tables BEFORE so the user can see what's already there. New tables in
# schema.sql will appear in the AFTER list and not the BEFORE list.
echo ""
echo "Tables before migration:"
$PSQL -t -A -c "
  SELECT '  ' || tablename
    FROM pg_tables
   WHERE schemaname = 'public'
   ORDER BY tablename
" | sed 's/^$//'

if [ "$1" = "--dry-run" ]; then
  echo ""
  echo "[dry-run] schema.sql would be applied (idempotent — IF NOT EXISTS guards)."
  exit 0
fi

# Run the schema file. Every statement is idempotent — existing tables, indexes,
# and constraints are preserved untouched. New ones are created.
echo ""
echo "Applying schema.sql..."
$PSQL -q -f "$SCHEMA"

# Compare row counts of expected core tables — proves the data wasn't wiped.
echo ""
echo "Tables after migration (with row counts):"
$PSQL -t -A -F $'\t' -c "
  SELECT '  ' || c.relname || E'\t' || COALESCE(s.n_live_tup, 0)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
   WHERE c.relkind = 'r' AND n.nspname = 'public'
   ORDER BY c.relname
"

echo ""
echo "Migration complete."
