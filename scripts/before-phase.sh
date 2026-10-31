#!/usr/bin/env bash
# Regression gate. Run it before starting phase N: it re-checks phases 1..N-1 so a new
# phase can't silently break an earlier one.
#
# Usage: scripts/before-phase.sh <N>     (N >= 2)
#   e.g. scripts/before-phase.sh 2       -> checks phase 1
#        scripts/before-phase.sh 5       -> checks phases 1, 2, 3, 4
#
# Each phase owns phases/phase-X/check.sh. This script just runs them in order.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N="${1:-}"

if ! [[ "$N" =~ ^[0-9]+$ ]] || [ "$N" -lt 2 ]; then
  echo "usage: $0 <N>   (N >= 2, the phase you are about to start)" >&2
  exit 2
fi

printf '\033[1m== Gate before phase %s: build + lint\033[0m\n' "$N"
(cd "$ROOT/backend" && cargo build -q --all-targets && cargo clippy -q --all-targets -- -D warnings)
echo "  build and clippy clean"

failed=""
for X in $(seq 1 $((N - 1))); do
  check="$ROOT/phases/phase-$X/check.sh"
  if [ ! -x "$check" ]; then
    printf '\033[31mmissing %s\033[0m\n' "$check"
    failed="$failed $X"
    continue
  fi
  if ! "$check"; then failed="$failed $X"; fi
done

echo
if [ -z "$failed" ]; then
  printf '\033[32mGATE PASSED: phases 1..%s OK. Safe to start phase %s.\033[0m\n' "$((N - 1))" "$N"
else
  printf '\033[31mGATE FAILED: broken phase(s):%s. Fix before starting phase %s.\033[0m\n' "$failed" "$N"
  exit 1
fi
