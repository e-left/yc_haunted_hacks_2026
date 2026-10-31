#!/usr/bin/env bash
# Phase 1: start the relay on :8080 with the in-memory store and the demo keys from
# backend/.env (created on first run with fresh demo-customer and other-agent keys).
#
# Usage: phases/phase-1/server.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

ensure_built
ensure_env_keys

echo "Starting relay (in-memory store) on ${LILD_BIND:-127.0.0.1:8080} (Ctrl+C to stop)"
cd "$BACKEND"
exec env -u DATABASE_URL LILD_API_KEYS="$LILD_API_KEYS" ./target/debug/lild-backend
