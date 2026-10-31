#!/usr/bin/env bash
# Connect OpenAI Codex CLI to the relay: builds lild-mcp, gives Codex its own key
# (client_id codex-agent, stored as CODEX_KEY in backend/.env), and registers it with
# `codex mcp add` (written to ~/.codex/config.toml, so it applies to all Codex sessions).
#
# The key is NOT copied into Codex's config. The config only points at backend/.env and
# names the variable (LILD_KEY_VAR=CODEX_KEY); lild-mcp reads it at startup.
#
# Usage: phases/phase-4/connect-codex.sh           (relay at http://127.0.0.1:8080)
#        LILD_BASE_URL=https://relay.example.com phases/phase-4/connect-codex.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

BASE="${LILD_BASE_URL:-http://127.0.0.1:8080}"
NAME="lild-relay"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found. Install it first: npm install -g @openai/codex (or brew install codex)" >&2
  exit 1
fi

step "Build lild-mcp (release)"
(cd "$BACKEND" && cargo build -q --bins && cargo build -q --release --bin lild-mcp)
BIN="$BACKEND/target/release/lild-mcp"
pass "$BIN"

step "Codex's own key (client_id codex-agent, CODEX_KEY in backend/.env)"
ensure_agent_key codex-agent CODEX_KEY
if [ "$NEW_AGENT_KEY" = 1 ]; then
  pass "created a new key. Restart the relay so it accepts it (Ctrl+C, then phases/phase-4/server.sh)"
else
  pass "already exists, reusing it"
fi

step "Register with Codex"
codex mcp remove "$NAME" >/dev/null 2>&1 || true
codex mcp add "$NAME" \
  --env "LILD_BASE_URL=$BASE" \
  --env "LILD_ENV_FILE=$ENV_FILE" \
  --env "LILD_KEY_VAR=CODEX_KEY" \
  -- "$BIN" >/dev/null
pass "registered '$NAME' (inspect: codex mcp get $NAME)"

cat <<EOF

Equivalent entry in ~/.codex/config.toml (written for you by the command above):

[mcp_servers.$NAME]
command = "$BIN"
env = { LILD_BASE_URL = "$BASE", LILD_ENV_FILE = "$ENV_FILE", LILD_KEY_VAR = "CODEX_KEY" }

Try it: start the relay (phases/phase-4/server.sh), run 'codex' and ask:
  "Use the lild-relay tools to ask the merchant which in-stock shirts have a body length under 30 inches."
Codex asks you to approve each MCP tool call; pick "always" for lild-relay to stop the prompts.

Non-interactive (codex exec) can't show approval prompts, so allow this server's tools explicitly:
  codex exec -c 'mcp_servers.$NAME.default_tools_approval_mode="approve"' "..."
EOF
