#!/usr/bin/env bash
# Shared helpers for phase scripts. Source it; don't run it.
# Bash 3.2 compatible (the macOS default).

set -euo pipefail

PHASES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$PHASES_DIR/.." && pwd)"
BACKEND="$ROOT/backend"
ENV_FILE="$BACKEND/.env"
FAILURES=0

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# expect <description> <expected> <actual>
expect() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi
}

ensure_built() { (cd "$BACKEND" && cargo build -q --bins); }

# gen_key <client_id>  ->  prints "<plaintext> <hash>"
gen_key() { "$BACKEND/target/debug/keygen" "$1" --raw; }

# Fresh demo-customer + other-agent keys, exported for the server and the smoke test.
fresh_demo_keys() {
  local customer_hash other_hash
  read -r CUSTOMER_KEY customer_hash <<<"$(gen_key demo-customer)"
  read -r OTHER_KEY other_hash <<<"$(gen_key other-agent)"
  LILD_API_KEYS="demo-customer:$customer_hash,other-agent:$other_hash"
  export CUSTOMER_KEY OTHER_KEY LILD_API_KEYS
}

# Load backend/.env if it exists (never committed).
load_env() {
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi
}

# start_server [port]: run the server binary in the background, wait for /v1/health.
start_server() {
  local port="${1:-$((18000 + RANDOM % 2000))}"
  BASE_URL="http://127.0.0.1:$port"
  SERVER_LOG="$(mktemp)"
  LILD_BIND="127.0.0.1:$port" RUST_LOG=info "$BACKEND/target/debug/lild-backend" >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  trap stop_server EXIT
  export BASE_URL
  local i
  for i in $(seq 1 50); do
    if curl -sf "$BASE_URL/v1/health" >/dev/null 2>&1; then return 0; fi
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.2
  done
  echo "server failed to start; log:" >&2
  cat "$SERVER_LOG" >&2
  return 1
}

stop_server() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

# http METHOD PATH [KEY] [IDEMPOTENCY_KEY] [BODY]
# Sets HTTP_STATUS, HTTP_HEADERS, HTTP_BODY.
http() {
  local method="$1" path="$2" key="${3:-}" idem="${4:-}" body="${5:-}"
  local hdr out
  hdr="$(mktemp)"; out="$(mktemp)"
  local args=(-s -X "$method" -D "$hdr" -o "$out" -w '%{http_code}' -H 'content-type: application/json')
  if [ -n "$key" ]; then args+=(-H "Authorization: Bearer $key"); fi
  if [ -n "$idem" ]; then args+=(-H "Idempotency-Key: $idem"); fi
  if [ -n "$body" ]; then args+=(--data "$body"); fi
  HTTP_STATUS="$(curl "${args[@]}" "$BASE_URL$path" || echo 000)"
  HTTP_HEADERS="$(cat "$hdr")"
  HTTP_BODY="$(cat "$out")"
  rm -f "$hdr" "$out"
}

# json_str <json> <field>: first string value of "field" (good enough for flat checks)
json_str() { printf '%s' "$1" | sed -n 's/.*"'"$2"'":"\([^"]*\)".*/\1/p' | head -1; }

# header_value <name>: value of a response header from the last http call (case-insensitive)
header_value() {
  printf '%s\n' "$HTTP_HEADERS" | tr -d '\r' | grep -i "^$1:" | head -1 | sed 's/^[^:]*:[[:space:]]*//'
}

finish() {
  if [ "$FAILURES" -eq 0 ]; then
    printf '\n\033[32mAll checks passed.\033[0m\n'
  else
    printf '\n\033[31m%d check(s) failed.\033[0m\n' "$FAILURES"
    exit 1
  fi
}
