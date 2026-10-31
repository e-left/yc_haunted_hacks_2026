#!/usr/bin/env bash
# Phase 2: start the relay on :8080 backed by Postgres.
# Uses DATABASE_URL from backend/.env if set (e.g. your Supabase connection string),
# otherwise the local compose Postgres, which it starts for you.
#
# Usage: phases/phase-2/server.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

ensure_built
ensure_env_keys

if [ -z "${DATABASE_URL:-}" ]; then
  ensure_postgres
  DATABASE_URL="$LOCAL_DATABASE_URL"
  echo "Using local Postgres (127.0.0.1:54329/lild)"
else
  echo "Using DATABASE_URL from backend/.env"
fi

echo "Starting relay (postgres store) on ${LILD_BIND:-127.0.0.1:8080} (Ctrl+C to stop)"
cd "$BACKEND"
exec env DATABASE_URL="$DATABASE_URL" LILD_API_KEYS="$LILD_API_KEYS" ./target/debug/lild-backend
