#!/usr/bin/env bash
# Phase 2 regression check, fully automated. Called by scripts/before-phase.sh.
# 1. cargo tests against the local Postgres test database
# 2. live server on Postgres: readiness + the full Phase 1 smoke test
# 3. restart the server: a request created before the restart is still there
# 4. no plaintext keys in logs or in the database
# Uses the `lild_test` database so dev data is never touched.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

step "Phase 2: Postgres"
ensure_postgres
pass "local Postgres is up"

step "Phase 2: cargo tests (tests/phase2_postgres.rs)"
(cd "$BACKEND" && TEST_DATABASE_URL="$LOCAL_TEST_DATABASE_URL" cargo test -q --test phase2_postgres)

step "Phase 2: live server on Postgres"
ensure_built
fresh_demo_keys
export DATABASE_URL="$LOCAL_TEST_DATABASE_URL"
start_server
"$PHASES_DIR/phase-2/smoke.sh"

step "Phase 2: data survives a restart"
http POST /v1/requests "$CUSTOMER_KEY" "" '{"question":"persist me across a restart"}'
expect "create before restart -> 202" 202 "$HTTP_STATUS"
ID="$(json_str "$HTTP_BODY" request_id)"
LOG_BEFORE="$(cat "$SERVER_LOG")"
stop_server
start_server
http GET "/v1/requests/$ID" "$CUSTOMER_KEY"
expect "same request after restart -> 200" 200 "$HTTP_STATUS"
expect "question preserved" "persist me across a restart" "$(json_str "$HTTP_BODY" question)"

step "Phase 2: secrets never stored or logged in plaintext"
if printf '%s\n%s' "$LOG_BEFORE" "$(cat "$SERVER_LOG")" | grep -qF -e "$CUSTOMER_KEY" -e "$OTHER_KEY"; then
  fail "plaintext API key found in server log"
else
  pass "no plaintext API key in server logs"
fi
LEAKED="$(cd "$ROOT" && docker compose exec -T postgres psql -U lild -d lild_test -tAc \
  "select count(*) from lild.api_keys where key_hash like 'lild_live_%'")"
expect "no plaintext API key in the database" 0 "$LEAKED"

finish
