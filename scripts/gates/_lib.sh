#!/usr/bin/env bash
# Shared helpers for the phase gates. Sourced, never executed.
# A gate must be honest: if it cannot prove its claim, it fails.

set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT" || exit 1

FAIL=0
green() { printf '  PASS  %s\n' "$*"; }
red()   { printf '  FAIL  %s\n' "$*"; FAIL=1; }
note()  { printf '  note  %s\n' "$*"; }
head_l() { printf '\n== %s\n' "$*"; }

finish() {
  if [ "$FAIL" -ne 0 ]; then
    printf '\ngate %s: FAILED\n' "${1:-?}"
    exit 1
  fi
  printf '\ngate %s: PASSED\n' "${1:-?}"
  exit 0
}

# assert_file <path> <why>
assert_file() { [ -f "$1" ] && green "$1 exists" || red "$1 missing ($2)"; }
assert_dir()  { [ -d "$1" ] && green "$1/ exists" || red "$1/ missing ($2)"; }
assert_absent(){ [ -e "$1" ] && red "$1 must not be present ($2)" || green "$1 absent"; }

# assert_no_string <extended-regex> <label> [path ...]
# Scans the shipped tree. When this is a git repo it scans tracked files only, so
# gitignored runtime state (data/, __pycache__) cannot fail a release gate.
assert_no_string() {
  local pat="$1" label="$2"; shift 2
  local hits
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    hits=$(git ls-files -z | xargs -0 grep -InE -- "$pat" 2>/dev/null \
             | grep -vE '^(tests|scripts/gates|\.github)/' || true)
  else
    hits=$(grep -rInE -- "$pat" "$@" --exclude-dir=.git --exclude-dir=node_modules \
             --exclude-dir=vendor --exclude-dir=data --exclude-dir=__pycache__ 2>/dev/null \
             | grep -vE '^(\\./)?(tests|scripts/gates|\.github)/' || true)
  fi
  if [ -n "$hits" ]; then
    red "found $label outside tests/ and scripts/gates/:"
    printf '%s\n' "$hits" | head -20 | sed 's/^/        /'
  else
    green "no $label outside tests/ and scripts/gates/"
  fi
}

# assert_server_up <port> — waits up to 20 s for /api/health to answer
wait_health() {
  local port="$1" i
  for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then return 0; fi
    if curl -s -o /dev/null "http://127.0.0.1:${port}/api/health" 2>/dev/null; then return 0; fi
    sleep 0.3
  done
  return 1
}

# start_mock_server <port> — boots the app in mock mode on a loopback port, echoes the PID
start_mock_server() {
  local port="$1"
  MOCK_KAGGLE=1 H3UI_PORT="$port" H3UI_BIND=127.0.0.1 H3UI_NO_WORKER=1 \
    H3UI_DATA_DIR="$ROOT/data-gate" node server.js >"$ROOT/data-gate/server.log" 2>&1 &
  echo $!
}

# free_port — a port unlikely to collide in CI
free_port() { echo $(( 9100 + (RANDOM % 700) )); }

assert_node_syntax() {
  local bad=0 f
  for f in server.js lib/*.js public/app.js; do
    [ -f "$f" ] || continue
    node --check "$f" 2>/dev/null || { red "syntax error in $f"; bad=1; }
  done
  [ "$bad" -eq 0 ] && green "node --check clean on server.js, lib/*.js, public/app.js"
}

run_tests() {
  if node tests/index.js > /tmp/gate-tests-"$$".log 2>&1; then
    green "node tests/index.js green ($(grep -oE '[0-9]+ (tests|passing|passed)' /tmp/gate-tests-"$$".log | tail -1))"
  else
    red "node tests/index.js failed — see /tmp/gate-tests-$$.log"
    tail -25 /tmp/gate-tests-"$$".log | sed 's/^/        /'
  fi
}
