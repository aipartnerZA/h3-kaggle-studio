#!/usr/bin/env bash
# h3-kaggle-studio installer / doctor.
# Checks the five things this app needs, prints the exact command for anything missing,
# then prepares config.json and data/. Never installs anything without asking.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)

ok=0
missing=()

say()  { printf '%s\n' "$*"; }
have() { printf '  ok    %s\n' "$*"; }
lack() { printf '  MISS  %s\n' "$*"; missing+=("$1"); }

say "h3-kaggle-studio — checking this machine"
say ""

# 1. Node 22+
if command -v node >/dev/null 2>&1; then
  NODE_V=$(node -p 'process.versions.node')
  NODE_MAJOR=${NODE_V%%.*}
  if [ "$NODE_MAJOR" -ge 22 ]; then have "node $NODE_V"
  else lack "node $NODE_V — need 22 or newer"; say "        install: https://nodejs.org/en/download  (or: nvm install 22 && nvm use 22)"
  fi
else
  lack "node — not found"; say "        install: https://nodejs.org/en/download"
fi

# 2. python3
if command -v python3 >/dev/null 2>&1; then
  have "python3 $(python3 -V 2>&1 | awk '{print $2}')"
else
  lack "python3 — not found"; say "        install: apt install python3   |   brew install python"
fi

# 3. ffmpeg / ffprobe
for bin in ffmpeg ffprobe; do
  if command -v "$bin" >/dev/null 2>&1; then have "$bin"
  else lack "$bin — not found"; say "        install: apt install ffmpeg   |   brew install ffmpeg"
  fi
done

# 4. kaggle CLI 2.0+
KG_BIN="${H3UI_KAGGLE_BIN:-kaggle}"
if command -v "$KG_BIN" >/dev/null 2>&1; then
  KG_V=$("$KG_BIN" --version 2>/dev/null | head -1 | awk '{print $NF}')
  KG_MAJOR=$(printf '%s' "$KG_V" | cut -d. -f1)
  if [ -n "${KG_MAJOR:-}" ] && [ "$KG_MAJOR" -ge 2 ] 2>/dev/null; then
    have "kaggle $KG_V"
  else
    lack "kaggle ${KG_V:-unknown} — need 2.0 or newer (older versions cannot read access_token)"
    say "        install: pip install --upgrade kaggle    (or: uv tool install kaggle)"
  fi
else
  lack "kaggle — not found"
  say "        install: pip install --upgrade kaggle    (or: uv tool install kaggle)"
fi

say ""

# 5. config + data
if [ ! -f config.json ]; then
  if [ -f config.example.json ]; then
    cp config.example.json config.json
    say "created config.json from config.example.json (edit it if you need to; env vars win)"
  else
    say "warning: config.example.json is missing, cannot create config.json"
  fi
else
  say "config.json already present, left alone"
fi
mkdir -p data/runs
say "data/ ready"

say ""
if [ "${#missing[@]}" -gt 0 ]; then
  say "Not ready: ${#missing[@]} thing(s) missing above."
  say "Install them, then run this script again."
  exit 2
fi

say "Everything this app needs is present."
say ""
say "Next:"
say "  node server.js"
say "  open http://127.0.0.1:${H3UI_PORT:-8804}"
say ""
say "The first screen walks you through the Kaggle token. Have your account ready,"
say "with phone verification done — without it Kaggle gives you no GPU."
