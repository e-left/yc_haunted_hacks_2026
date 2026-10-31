#!/usr/bin/env bash
# Phase 4: the relay server is unchanged from Phase 3 (Postgres + workers).
# Phase 4 adds the client side: lild-mcp, which Claude launches to reach this server.
#
# Usage: phases/phase-4/server.sh
exec "$(dirname "${BASH_SOURCE[0]}")/../phase-3/server.sh"
