#!/usr/bin/env bash
# Phase 1 regression check, fully automated: cargo tests, then a live smoke test
# against a throwaway server with fresh keys. Called by scripts/before-phase.sh.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

step "Phase 1: cargo tests (unit + tests/phase1_relay_api.rs)"
(cd "$BACKEND" && cargo test -q --lib --test phase1_relay_api)

step "Phase 1: live server (in-memory store)"
unset DATABASE_URL
ensure_built
fresh_demo_keys
start_server

"$PHASES_DIR/phase-1/smoke.sh"

step "Phase 1: secrets never reach the logs"
if grep -qF -e "$CUSTOMER_KEY" -e "$OTHER_KEY" "$SERVER_LOG"; then
  fail "plaintext API key found in server log"
else
  pass "no plaintext API key in server log"
fi

finish
