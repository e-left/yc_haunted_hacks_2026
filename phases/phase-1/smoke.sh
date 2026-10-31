#!/usr/bin/env bash
# Phase 1 smoke test against a running relay. Exits non-zero on any failure.
#
# Manual:  phases/phase-1/server.sh   (terminal 1)
#          phases/phase-1/smoke.sh    (terminal 2, reads keys from backend/.env)
# The automated gate (check.sh) sets BASE_URL, CUSTOMER_KEY, OTHER_KEY itself.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ -z "${CUSTOMER_KEY:-}" ]; then load_env; fi
: "${BASE_URL:=http://127.0.0.1:8080}"
: "${CUSTOMER_KEY:?set CUSTOMER_KEY or run phases/phase-1/server.sh first}"
: "${OTHER_KEY:?set OTHER_KEY or run phases/phase-1/server.sh first}"

Q='{"question":"Which in-stock shirts have a body length under 30 inches?"}'
IDEM="smoke-$(date +%s)-$$"

step "Phase 1 smoke test against $BASE_URL"

http GET /v1/health
expect "1. health is 200 without auth" 200 "$HTTP_STATUS"

http POST /v1/requests "$CUSTOMER_KEY" "$IDEM" "$Q"
expect "2. customer submits question -> 202" 202 "$HTTP_STATUS"
expect "   status is pending" pending "$(json_str "$HTTP_BODY" status)"
expect "   first call is not a replay" "" "$(header_value idempotent-replayed)"
ID="$(json_str "$HTTP_BODY" request_id)"
expect "   location header points at the request" "/v1/requests/$ID" "$(header_value location)"

http GET "/v1/requests/$ID" "$CUSTOMER_KEY"
expect "3. customer reads own request -> 200" 200 "$HTTP_STATUS"
expect "   same request_id" "$ID" "$(json_str "$HTTP_BODY" request_id)"

http GET "/v1/requests/$ID" "$OTHER_KEY"
expect "4. other agent reads it -> 404" 404 "$HTTP_STATUS"
expect "   error code not_found" not_found "$(json_str "$HTTP_BODY" code)"

http POST /v1/requests "" "" '{}'
expect "5. no key -> 401" 401 "$HTTP_STATUS"

http POST /v1/requests "$CUSTOMER_KEY" "$IDEM" "$Q"
expect "6. retry with same Idempotency-Key -> 202" 202 "$HTTP_STATUS"
expect "   same request_id (no duplicate)" "$ID" "$(json_str "$HTTP_BODY" request_id)"
expect "   idempotent-replayed header" true "$(header_value idempotent-replayed)"

http POST /v1/requests "$CUSTOMER_KEY" "$IDEM" '{"question":"something else"}'
expect "7. same key, different body -> 409" 409 "$HTTP_STATUS"

http POST /v1/requests "$CUSTOMER_KEY" "" '{"question":"hi","customer_id":"someone-else"}'
expect "8. unknown field (customer_id) rejected -> 400" 400 "$HTTP_STATUS"

finish
