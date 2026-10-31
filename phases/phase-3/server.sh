#!/usr/bin/env bash
# Phase 3: same as the Phase 2 server (Postgres), now with background workers.
# Requests move pending -> active with a result marked "simulated" (stub pipeline).
# LILD_WORKERS=N controls the worker count (default 2, 0 disables).
#
# Usage: phases/phase-3/server.sh
exec "$(dirname "${BASH_SOURCE[0]}")/../phase-2/server.sh"
