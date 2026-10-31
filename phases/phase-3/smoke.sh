#!/usr/bin/env bash
# Phase 3 smoke test against a running relay (phases/phase-3/server.sh).
# Re-runs the Phase 2 smoke test (which includes Phase 1), then checks that a new
# request is picked up by a worker and becomes active with a simulated result.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ -z "${CUSTOMER_KEY:-}" ]; then load_env; fi
: "${BASE_URL:=http://127.0.0.1:8080}"
export BASE_URL CUSTOMER_KEY OTHER_KEY

"$PHASES_DIR/phase-2/smoke.sh"

step "Phase 3 smoke test against $BASE_URL"
http POST /v1/requests "$CUSTOMER_KEY" "" '{"question":"Which in-stock shirts have a body length under 30 inches?"}'
expect "1. submit -> 202 pending" "202 pending" "$HTTP_STATUS $(json_str "$HTTP_BODY" status)"
ID="$(json_str "$HTTP_BODY" request_id)"

final=""
for _ in $(seq 1 50); do
  http GET "/v1/requests/$ID" "$CUSTOMER_KEY"
  final="$(json_str "$HTTP_BODY" status)"
  [ "$final" = pending ] || break
  sleep 0.2
done
expect "2. worker moves it to active (within 10s)" active "$final"
if printf '%s' "$HTTP_BODY" | grep -q '"simulated":true'; then
  pass "3. result is labeled simulated (stub pipeline)"
else
  fail "3. result is labeled simulated (body: $HTTP_BODY)"
fi
if printf '%s' "$HTTP_BODY" | grep -qE '"(last_error|attempts|locked_by)"'; then
  fail "4. internal worker fields leaked: $HTTP_BODY"
else
  pass "4. no internal worker fields in the API response"
fi

http GET "/v1/requests/$ID" "$OTHER_KEY"
expect "5. other agent still can't see the finished request -> 404" 404 "$HTTP_STATUS"

finish
