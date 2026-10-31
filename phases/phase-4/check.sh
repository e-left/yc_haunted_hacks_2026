#!/usr/bin/env bash
# Phase 4 regression check, fully automated. Called by scripts/before-phase.sh.
# 1. cargo tests: MCP protocol, tools, security, the real binary over stdio
# 2. live relay (Postgres + workers) + full smoke for phases 1-4
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

step "Phase 4: cargo tests (tests/phase4_agent_mcp.rs)"
(cd "$BACKEND" && cargo test -q --test phase4_agent_mcp)

step "Phase 4: live relay + MCP session"
ensure_postgres
ensure_built
fresh_demo_keys
export DATABASE_URL="$LOCAL_TEST_DATABASE_URL"
start_server
"$PHASES_DIR/phase-4/smoke.sh"

step "Phase 4: separate keys per agent (claude-agent, codex-agent)"
stop_server
ENV_FILE="$(mktemp -d)/.env"          # throwaway .env: never touches backend/.env
ensure_agent_key claude-agent CLAUDE_KEY
ensure_agent_key codex-agent CODEX_KEY
ensure_agent_key claude-agent CLAUDE_KEY
expect "re-running reuses the existing key" 0 "$NEW_AGENT_KEY"
expect ".env is private (mode 600)" 600 "$(stat -f %Lp "$ENV_FILE" 2>/dev/null || stat -c %a "$ENV_FILE")"
LILD_API_KEYS="$(grep '^LILD_API_KEYS=' "$ENV_FILE" | cut -d= -f2-)"; export LILD_API_KEYS
start_server
as_agent() {  # as_agent <KEY_VAR> <json-rpc line>
  printf '%s\n' "$2" | LILD_BASE_URL="$BASE_URL" LILD_API_KEY="" LILD_ENV_FILE="$ENV_FILE" LILD_KEY_VAR="$1" \
    "$BACKEND/target/debug/lild-mcp" 2>/dev/null
}
ASK='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_merchant","arguments":{"question":"shirts under 30in","wait_seconds":10}}}'
C="$(as_agent CLAUDE_KEY "$ASK")"; X="$(as_agent CODEX_KEY "$ASK")"
expect "claude (CLAUDE_KEY) gets an answer" 1 "$(printf '%s' "$C" | grep -c '"status":"active"')"
expect "codex (CODEX_KEY) gets an answer" 1 "$(printf '%s' "$X" | grep -c '"status":"active"')"
XID="$(printf '%s' "$X" | grep -o '"request_id":"[^"]*"' | head -1 | cut -d'"' -f4)"
P="$(as_agent CLAUDE_KEY "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"get_request_status\",\"arguments\":{\"request_id\":\"$XID\"}}}")"
expect "claude cannot read codex's request" 1 "$(printf '%s' "$P" | grep -c 'request not found')"
LOG="$(sed 's/\x1b\[[0-9;]*m//g' "$SERVER_LOG")"
expect "backend tells the agents apart" 2 "$(printf '%s\n' "$LOG" | grep 'request accepted' | grep -cE 'client_id=(claude|codex)-agent')"

finish
