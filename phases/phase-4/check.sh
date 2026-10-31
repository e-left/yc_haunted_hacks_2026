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

finish
