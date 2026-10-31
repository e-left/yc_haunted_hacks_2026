#!/usr/bin/env bash
# Phase 4 smoke test against a running relay (phases/phase-4/server.sh).
# Re-runs the Phase 3 smoke (which includes 1 and 2), then plays a full MCP session
# through the real lild-mcp binary, exactly like Claude would.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

if [ -z "${CUSTOMER_KEY:-}" ]; then load_env; fi
: "${BASE_URL:=http://127.0.0.1:8080}"
export BASE_URL CUSTOMER_KEY OTHER_KEY

"$PHASES_DIR/phase-3/smoke.sh"

step "Phase 4 smoke test: MCP session via lild-mcp against $BASE_URL"
ensure_built
MCP="$BACKEND/target/debug/lild-mcp"

# mcp_session <api key>: initialize, initialized, check connection, ask the merchant.
mcp_session() {
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check_relay_connection","arguments":{}}}' \
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask_merchant","arguments":{"question":"Which in-stock shirts have a body length under 30 inches?","wait_seconds":10}}}' \
    | LILD_BASE_URL="$BASE_URL" LILD_API_KEY="$1" LILD_ENV_FILE="" "$MCP" 2>/dev/null
}
line_for() { printf '%s\n' "$OUT" | grep "\"id\":$1[,}]" | head -1; }

OUT="$(mcp_session "$CUSTOMER_KEY")"
expect "1. initialize -> protocol 2025-06-18" 1 "$(line_for 1 | grep -c '"protocolVersion":"2025-06-18"')"
expect "2. check_relay_connection -> key accepted" 1 "$(line_for 2 | grep -c '"api_key":"accepted"')"
expect "3. ask_merchant -> active" 1 "$(line_for 3 | grep -c '"status":"active"')"
expect "   not a tool error" 1 "$(line_for 3 | grep -c '"isError":false')"
expect "   simulated result is flagged" 1 "$(line_for 3 | grep -c 'SIMULATED')"
expect "4. exactly 3 responses (notification got none)" 3 "$(printf '%s\n' "$OUT" | grep -c '"jsonrpc"')"
expect "5. API key never in MCP output" 0 "$(printf '%s' "$OUT" | grep -c 'lild_live_')"

OUT="$(mcp_session "$(gen_key nobody | cut -d' ' -f1)")"
expect "6. unknown key -> tool error" 1 "$(line_for 2 | grep -c '"isError":true')"
expect "   says authentication failed" 1 "$(line_for 2 | grep -c 'authentication failed')"
expect "   and leaks no key" 0 "$(printf '%s' "$OUT" | grep -c 'lild_live_')"

finish
