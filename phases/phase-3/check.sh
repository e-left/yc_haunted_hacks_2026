#!/usr/bin/env bash
# Phase 3 regression check, fully automated. Called by scripts/before-phase.sh.
# 1. cargo tests: worker scenarios on both stores + DB-enforced state machine
# 2. live server with workers: full smoke (phases 1-3)
# 3. crash recovery: kill -9 the server mid-flight, restart, every request finishes
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

drop_temp_dbs() {
  (cd "$ROOT" && docker compose exec -T postgres psql -U lild -d lild -tAc \
    "select 'DROP DATABASE \"' || datname || '\" WITH (FORCE);' from pg_database where datname like 'lild_p3_%'" \
    | docker compose exec -T postgres psql -q -U lild -d lild >/dev/null) || true
}

step "Phase 3: Postgres"
ensure_postgres
pass "local Postgres is up"

step "Phase 3: cargo tests (unit + tests/phase3_worker.rs)"
(cd "$BACKEND" && TEST_DATABASE_URL="$LOCAL_TEST_DATABASE_URL" cargo test -q --lib --test phase3_worker)
drop_temp_dbs   # in case a failed test left one behind

step "Phase 3: live server with workers"
ensure_built
fresh_demo_keys
export DATABASE_URL="$LOCAL_TEST_DATABASE_URL"
start_server
"$PHASES_DIR/phase-3/smoke.sh"

step "Phase 3: hard crash (kill -9) with work queued, then restart"
stop_server
LILD_WORKERS=0 start_server   # accept requests but don't process them yet
IDS=""
for i in 1 2 3 4 5; do
  http POST /v1/requests "$CUSTOMER_KEY" "" "{\"question\":\"crash test $i\"}"
  IDS="$IDS $(json_str "$HTTP_BODY" request_id)"
done
kill -9 "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
pass "server killed with 5 pending requests"
start_server                  # normal start, workers on
all_active=1
for ID in $IDS; do
  st=""
  for _ in $(seq 1 50); do
    http GET "/v1/requests/$ID" "$CUSTOMER_KEY"
    st="$(json_str "$HTTP_BODY" status)"
    [ "$st" = pending ] || break
    sleep 0.2
  done
  [ "$st" = active ] || { all_active=0; fail "request $ID ended as '$st'"; }
done
[ "$all_active" = 1 ] && pass "all 5 requests completed after the crash"

step "Phase 3: graceful shutdown on SIGTERM"
kill -TERM "$SERVER_PID"
for _ in $(seq 1 50); do kill -0 "$SERVER_PID" 2>/dev/null || break; sleep 0.1; done
if grep -q "shutdown complete" "$SERVER_LOG"; then
  pass "server drained workers and exited cleanly"
else
  fail "no clean shutdown in log"
fi
SERVER_PID=""

finish
