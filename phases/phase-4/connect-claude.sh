#!/usr/bin/env bash
# Connect Claude to the relay: builds lild-mcp, gives Claude its own key
# (client_id claude-agent, stored as CLAUDE_KEY in backend/.env), and registers it
# with Claude Code (local scope: this project only). Also prints the Claude Desktop config.
#
# The key is NOT copied into Claude's config. The config only points at backend/.env and
# names the variable (LILD_KEY_VAR=CLAUDE_KEY); lild-mcp reads it at startup.
#
# Usage: phases/phase-4/connect-claude.sh          (relay at http://127.0.0.1:8080)
#        LILD_BASE_URL=https://relay.example.com phases/phase-4/connect-claude.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

BASE="${LILD_BASE_URL:-http://127.0.0.1:8080}"
NAME="lild-relay"

step "Build lild-mcp (release)"
(cd "$BACKEND" && cargo build -q --bins && cargo build -q --release --bin lild-mcp)
BIN="$BACKEND/target/release/lild-mcp"
pass "$BIN"

step "Claude's own key (client_id claude-agent, CLAUDE_KEY in backend/.env)"
ensure_agent_key claude-agent CLAUDE_KEY
if [ "$NEW_AGENT_KEY" = 1 ]; then
  pass "created a new key. Restart the relay so it accepts it (Ctrl+C, then phases/phase-4/server.sh)"
else
  pass "already exists, reusing it"
fi

CONFIG="{\"type\":\"stdio\",\"command\":\"$BIN\",\"args\":[],\"env\":{\"LILD_BASE_URL\":\"$BASE\",\"LILD_ENV_FILE\":\"$ENV_FILE\",\"LILD_KEY_VAR\":\"CLAUDE_KEY\"}}"

step "Register with Claude Code"
if command -v claude >/dev/null 2>&1; then
  cd "$ROOT"
  claude mcp remove "$NAME" -s local >/dev/null 2>&1 || true
  claude mcp add-json "$NAME" "$CONFIG" -s local >/dev/null
  pass "registered '$NAME' for this project (inspect: claude mcp get $NAME)"
else
  echo "  'claude' CLI not found; skipping Claude Code registration."
fi

cat <<EOF

Claude Desktop: add this to
  ~/Library/Application Support/Claude/claude_desktop_config.json
then restart Claude Desktop:

{
  "mcpServers": {
    "$NAME": {
      "command": "$BIN",
      "env": { "LILD_BASE_URL": "$BASE", "LILD_ENV_FILE": "$ENV_FILE", "LILD_KEY_VAR": "CLAUDE_KEY" }
    }
  }
}

Try it: start the relay (phases/phase-4/server.sh), open Claude Code in this folder and ask:
  "Use the lild-relay tools to ask the merchant which in-stock shirts have a body length under 30 inches."
Claude asks permission the first time it uses a tool; choose "always allow" for lild-relay.
EOF
