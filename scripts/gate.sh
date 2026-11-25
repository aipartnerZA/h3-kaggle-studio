#!/usr/bin/env bash
# Dispatch: bash scripts/gate.sh <ID>
set -euo pipefail
ID="${1:-}"
if [ -z "$ID" ]; then
  echo "usage: bash scripts/gate.sh <ID>" >&2
  exit 2
fi
SCRIPT="scripts/gates/${ID}.sh"
if [ ! -f "$SCRIPT" ]; then
  echo "gate stub not implemented: $SCRIPT missing" >&2
  exit 1
fi
exec bash "$SCRIPT"
