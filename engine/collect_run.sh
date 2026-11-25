#!/bin/bash
# Collect a tagged six-shot run: download output, verify, write sentinel.
#
#   ./collect_run.sh <tag> [--no-pi]
#
# <tag> names everything: kernel <owner>/<kernel-prefix><tag>, downloads
# data/runs/<tag>/raw/, sentinel data/runs/<tag>/done. The owner must be passed
# by the caller as KAGGLE_OWNER. --no-pi is accepted for compatibility but is
# always in effect: clips never leave this machine.
#
# Exit codes: 0 = mp4s present, 2 = kernel failed, 3 = COMPLETE but no mp4.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
H3_ENGINE_ROOT="${H3_ENGINE_ROOT:-$SCRIPT_DIR}"
export H3_ENGINE_ROOT
cd "$H3_ENGINE_ROOT" || exit 1

TAG="${1:-}"
[ -z "$TAG" ] && { echo "usage: collect_run.sh <tag> [--no-pi]"; exit 2; }
# accept optional flags
shift || true
for a in "$@"; do :; done

OWNER="${KAGGLE_OWNER:?owner not set — set config.owner or export KAGGLE_OWNER}"
KERNEL_PREFIX="${KERNEL_PREFIX:-h3-six-}"
REF="${OWNER}/${KERNEL_PREFIX}${TAG}"
RUN_DIR="$H3_ENGINE_ROOT/../data/runs/$TAG"
DONE="$RUN_DIR/done"
OUT="$RUN_DIR/raw"
LOCK="$RUN_DIR/collect.lock"
EMPTY="$RUN_DIR/empty_attempts"
say() { printf '%s [%s] %s\n' "$(date -u '+%H:%M:%S')" "$TAG" "$*"; }

mkdir -p "$RUN_DIR"
[ -f "$DONE" ] && exit 0
command -v kaggle >/dev/null 2>&1 || { say "kaggle CLI not found — install it with 'pip install kaggle' or 'uv tool install kaggle'"; exit 2; }

ST=$(kaggle kernels status "$REF" 2>&1 | sed 's/.*status //' | tr -d '"' | tr -d '\r')
case "$ST" in
  *COMPLETE*) : ;;
  *ERROR*|*CANCEL*) say "RUN FAILED status=$ST"; echo "$ST" > "$DONE"; exit 2 ;;
  *) exit 0 ;;
esac

say "kernel COMPLETE — downloading"
rm -rf "$OUT"
kaggle kernels output "$REF" -p "$OUT" 2>&1 | tail -3
MP4S=$(find "$OUT" -name '*.mp4' | sort)
if [ -z "$MP4S" ]; then
  n=$(( $(cat "$EMPTY" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$EMPTY"
  say "NO MP4 FOUND (empty run $n/3)"
  if [ "$n" -ge 3 ]; then
    say "GIVING UP after $n empty runs"
    echo "no-mp4" > "$DONE"
  fi
  exit 3
fi
rm -f "$EMPTY"

# Guard verify + sentinel so concurrent collectors cannot interleave.
(
  flock -x 9
  # shellcheck disable=SC2086
  python3 "$H3_ENGINE_ROOT/verify_run.py" $MP4S 2>&1
  echo done > "$DONE"
  say "ALL DONE — collected"
) 9>"$LOCK"

exit 0
