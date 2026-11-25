#!/bin/bash
# Build, gate and push one six-shot 15 s run.
#
#   ./run_six.sh <tag> [--dry-run] [--no-wait] [--no-live-check]
#
# <tag> names everything: data/runs/<tag>/jobs.json, data/runs/<tag>/queue/prep/,
# kernel <owner>/<kernel-prefix><tag>, sentinel data/runs/<tag>/done and downloads
# data/runs/<tag>/raw/. The owner must be passed by the caller as KAGGLE_OWNER
# (config.owner, or the username the app reads from `kaggle config view`), so a
# missing owner fails loudly instead of pushing to someone else's account.
# Nothing is copied off this machine.
#
# --dry-run builds and runs every gate, prints the result, and does NOT push.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
H3_ENGINE_ROOT="${H3_ENGINE_ROOT:-$SCRIPT_DIR}"
export H3_ENGINE_ROOT
cd "$H3_ENGINE_ROOT" || exit 1

TAG="${1:-}"
DRY=0
NOWAIT=0
NOLIVE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --no-wait) NOWAIT=1 ;;   # cron/chain use: push, arm, report once, return
    --no-live-check) NOLIVE=1 ;;  # rehearsal only: prove a build while another kernel runs
  esac
done
[ -z "$TAG" ] && { echo "usage: run_six.sh <tag> [--dry-run] [--no-wait] [--no-live-check]"; exit 2; }
echo "$TAG" | grep -qE '^[a-z0-9][a-z0-9-]{1,30}$' || { echo "tag must be lowercase alnum/hyphen"; exit 2; }

OWNER="${KAGGLE_OWNER:?owner not set — set config.owner or export KAGGLE_OWNER}"
KERNEL_PREFIX="${KERNEL_PREFIX:-h3-six-}"
RUN_DIR="$H3_ENGINE_ROOT/../data/runs/$TAG"
JOBS="$RUN_DIR/jobs.json"
KDIR="kernel_${TAG}"
REF="${OWNER}/${KERNEL_PREFIX}${TAG}"
TITLE="H3 Six ${TAG}"
DONE="$RUN_DIR/done"
PIN="49b61c3cd044fb65acd97a960467a00414694146"
fail() { echo "PREFLIGHT FAIL: $*"; exit 3; }
say() { echo "[$TAG] $*"; }

mkdir -p "$RUN_DIR"

if [ "$DRY" = "1" ]; then
  say "dry run: kaggle CLI not required (nothing is pushed)"
else
  command -v kaggle >/dev/null 2>&1 || fail "kaggle CLI not found — install it with 'pip install kaggle' or 'uv tool install kaggle'"
fi

# ---- 1. the batch itself -----------------------------------------------------
[ -f "$JOBS" ] || fail "no $JOBS — stage shots with stage_shot.py --tag $TAG"
N=$(python3 -c "import json;print(len(json.load(open('$JOBS'))['jobs']))")
DISTINCT=$(python3 -c "
import json,sys
j=json.load(open('$JOBS'))['jobs']
print(len({x['start_image'] for x in j if x.get('start_image')}))")
[ "$N" -ge 1 ] || fail "$JOBS has no jobs"
[ "$N" -le 8 ] || fail "$N jobs: the inlined base64 blows the ~1 MB push ceiling above ~8"
[ "$N" = "$DISTINCT" ] || say "WARNING: $N jobs but only $DISTINCT distinct start images"
python3 - "$JOBS" <<'PY' || exit 3
import json, os, sys
jobs = json.load(open(sys.argv[1]))["jobs"]
missing = [j["start_image"] for j in jobs
           if j.get("start_image") and not os.path.isfile(j["start_image"])]
if missing:
    sys.exit("PREFLIGHT FAIL: missing start image(s): " + ", ".join(missing))
empty = [j["id"] for j in jobs if not j.get("prompt", "").strip()]
if empty:
    sys.exit("PREFLIGHT FAIL: empty prompt for " + ", ".join(empty))
PY
B64KB=$(python3 -c "
import json
jobs=json.load(open('$JOBS'))['jobs']
t=sum((__import__('os').path.getsize(j['start_image'])+2)//3*4 for j in jobs if j.get('start_image'))
print(t//1024)")
say "batch: $N job(s), $DISTINCT start image(s), ~${B64KB} KB base64"
say "base64 total < 800 KB"
[ "$B64KB" -lt 800 ] || fail "~${B64KB} KB of inlined images: keep the script under the 1 MB push ceiling (re-prep images smaller)"

# ---- 2. GPU and queue state --------------------------------------------------
if [ "$DRY" = "1" ]; then
  say "dry run: skipping account, quota and live-kernel checks (no credential needed, nothing pushed)"
else
kaggle config view >/dev/null 2>&1 || fail "kaggle auth: no account (run kaggle config view)"
QUOTA=$(kaggle quota 2>/dev/null | awk '/^GPU/{print $3}')
say "GPU quota remaining: ${QUOTA:-unknown}"
case "$QUOTA" in
  *h) H=${QUOTA%h}; awk -v h="$H" 'BEGIN{exit !(h+0 < 2.5)}' && fail "only ${QUOTA} GPU left; this run needs ~2.2h" ;;
esac
LIVE=$(for r in $(kaggle kernels list -m --user="$OWNER" 2>/dev/null | awk -v p="$KERNEL_PREFIX" 'index($0,p){print $1}'); do
         s=$(kaggle kernels status "$r" 2>&1 | sed 's/.*status //'); case "$s" in *RUNNING*|*QUEUED*) echo "$r $s";; esac
       done)
if [ "$NOLIVE" = "1" ]; then
  # Report-only pre-gate: lets a batch be proven while another kernel is live.
  # Never passed on the push path.
  [ -n "$LIVE" ] && say "live-check bypassed for rehearsal: $LIVE"
else
  [ -n "$LIVE" ] && fail "a six-shot kernel is still live: $LIVE (push would 409 or run two sessions)"
fi
fi

# ---- 3. build ----------------------------------------------------------------
rm -rf "$KDIR"
python3 build_pro.py "$JOBS" "$KDIR" "$REF" "$TITLE" options_scene.json || fail "build_pro.py failed"
[ -f "$KDIR/h3-pro.py" ] || fail "builder produced no $KDIR/h3-pro.py"

# ---- 4. gates on the built script -------------------------------------------
SIZE=$(stat -c%s "$KDIR/h3-pro.py")
[ "$SIZE" -lt 1000000 ] || fail "script is $((SIZE/1024)) KB — Kaggle rejects >~1 MB (SaveKernel 400)"
grep -q "COMFYUI_COMMIT = \"$PIN\"" "$KDIR/h3-pro.py" || fail "v0.44.1 pin ($PIN) missing — the Sol int8 VAE only builds on it"
IMGS=$(grep -cE '^IMG[0-9]+_B64 = ' "$KDIR/h3-pro.py")
[ "$IMGS" = "$DISTINCT" ] || fail "script embeds $IMGS image constant(s), batch has $DISTINCT distinct start image(s)"
python3 - "$KDIR/h3-pro.py" "$JOBS" <<'PY' || exit 3
import json, re, sys
src = open(sys.argv[1], encoding="utf-8").read()
jobs = json.load(open(sys.argv[2]))["jobs"]
block = src.split("JOBS = [", 1)[1]
# the builder writes job strings with %r, i.e. single quotes
# (only required when at least one slot has a start image)
if any(j.get("start_image") for j in jobs):
    if not re.search(r"\"images\": \{\"first\": IMG\d+_B64\}", block):
        sys.exit("PREFLIGHT FAIL: built JOBS block has no per-job IMGn_B64 start image")
for j in jobs:
    if not re.search(r"\"id\": ['\"]%s['\"]" % re.escape(j["id"]), block):
        sys.exit("PREFLIGHT FAIL: job %s missing from the built JOBS block" % j["id"])
    if j["video_vae"] not in src:
        sys.exit("PREFLIGHT FAIL: VAE %s not referenced in the script" % j["video_vae"])
print("jobs in script: " + ", ".join(j["id"] for j in jobs))
PY
grep -q "\"id\": \"$REF\"" "$KDIR/kernel-metadata.json" || fail "metadata id is not $REF"
grep -q '"machine_shape": "NvidiaTeslaT4"' "$KDIR/kernel-metadata.json" || fail "metadata is not T4"
grep -q '"enable_gpu": true' "$KDIR/kernel-metadata.json" || fail "metadata has GPU off"
say "built $KDIR/h3-pro.py ($((SIZE/1024)) KB), pin OK, $IMGS image constant(s), all job ids present"

if [ "$DRY" = "1" ]; then
  say "DRY RUN OK — nothing pushed. Real run: ./run_six.sh $TAG"
  exit 0
fi

# ---- 5. push and arm the watcher --------------------------------------------
PUSH=$(kaggle kernels push -p "$KDIR" 2>&1)
echo "$PUSH"
echo "$PUSH" | grep -qi 'successfully pushed\|success' || fail "push did not report success"
echo "$TAG" > "$H3_ENGINE_ROOT/../data/current_run"
rm -f "$DONE"
say "pushed $REF; watcher armed for tag $TAG (cron adopts on COMPLETE)"

if [ "$NOWAIT" = "1" ]; then
  sleep 20
  ST=$(kaggle kernels status "$REF" 2>&1 | sed 's/.*status //' | tr -d '"')
  say "no-wait: status=$ST (watcher adopts on COMPLETE)"
  exit 0
fi

for i in $(seq 1 40); do
  sleep 30
  ST=$(kaggle kernels status "$REF" 2>&1 | sed 's/.*status //' | tr -d '"')
  say "poll $i status=$ST"
  case "$ST" in
    *RUNNING*) say "RUNNING — ETA ~2h05 (${N} x 15 s standard + setup)"; exit 0 ;;
    *COMPLETE*|*ERROR*|*CANCEL*) say "ended early: $ST — check $RUN_DIR/raw"; exit 4 ;;
  esac
done
say "still QUEUED after 20 min — the watcher will adopt it whenever it runs"
