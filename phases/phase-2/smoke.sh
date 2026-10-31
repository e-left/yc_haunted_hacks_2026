#!/usr/bin/env bash
# Phase 2 smoke test against a running relay (start it with phases/phase-2/server.sh).
# Checks readiness (the database is reachable), then re-runs the full Phase 1 smoke test,
# because the HTTP behavior must be identical on the Postgres store.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ -z "${CUSTOMER_KEY:-}" ]; then load_env; fi
: "${BASE_URL:=http://127.0.0.1:8080}"
export BASE_URL CUSTOMER_KEY OTHER_KEY

step "Phase 2 smoke test against $BASE_URL"
http GET /v1/ready
expect "1. ready is 200 (database reachable)" 200 "$HTTP_STATUS"
expect "   status ready" ready "$(json_str "$HTTP_BODY" status)"

if [ "$FAILURES" -ne 0 ]; then finish; fi
"$PHASES_DIR/phase-1/smoke.sh"
