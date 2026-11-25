#!/usr/bin/env bash
# P3 — the first-run panel: full screen, six panes, real gate, no bypass in the browser.
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

head_l "P3.1 vendored Swiper, hashes locked"
assert_file public/vendor/swiper-14.4.0/swiper-bundle.min.js "vendored js"
assert_file public/vendor/swiper-14.4.0/swiper-bundle.min.css "vendored css"
assert_file scripts/vendor.lock "the hash lock"
if [ -f scripts/vendor.lock ]; then
  while read -r f want _size; do
    case "$f" in */*) ;; *) continue ;; esac
    got=$(sha256sum "$f" 2>/dev/null | awk '{print $1}')
    if [ "$got" = "$want" ]; then green "$(basename "$f") hash matches the lock"; else red "$(basename "$f") hash drifted from scripts/vendor.lock"; fi
  done < scripts/vendor.lock
fi
if grep -rqE 'cdn\.jsdelivr|unpkg\.com|cdnjs' public/*.html public/*.js public/*.css 2>/dev/null; then
  red "a CDN reference is present — assets must be self-hosted"
else
  green "no CDN references in the served assets"
fi

head_l "P3.2 the copy is in the build"
PORT=$(free_port)
WORK=$(mktemp -d)
KHOME=$(mktemp -d)
rsync -a --exclude .git --exclude data --exclude node_modules "$ROOT/" "$WORK/" 2>/dev/null || cp -a "$ROOT/." "$WORK/"
( cd "$WORK" && cp config.example.json config.json 2>/dev/null
  MOCK_KAGGLE=1 H3UI_PORT="$PORT" H3UI_BIND=127.0.0.1 H3UI_NO_WORKER=1 \
  H3UI_KAGGLE_HOME="$KHOME" node server.js >"$WORK/server.log" 2>&1 & echo $! > "$WORK/pid" )
wait_health "$PORT" || { red "server did not boot"; tail -10 "$WORK/server.log" | sed 's/^/        /'; }

PAGE="$WORK/page.html"
curl -s "http://127.0.0.1:$PORT/" -o "$PAGE" 2>/dev/null
check_copy() {
  if grep -qF "$1" "$PAGE" 2>/dev/null; then green "copy present: ${1:0:48}…"; else red "copy missing: ${1:0:48}…"; fi
}
check_copy "Render video on a free GPU"
check_copy "Before you render: the model licence"
check_copy "European Union, the United Kingdom"
check_copy "South Korea"
check_copy "Powered by MiniMax H3"
check_copy "Kaggle's rules"
check_copy "personal, non-commercial use"
check_copy "termination of your account"
check_copy "Get your Kaggle token"
check_copy "Connect your account"
check_copy "Not affiliated with Kaggle or MiniMax"

head_l "P3.3 the gate cannot be walked around in the browser"
if grep -qiE 'swiper' "$PAGE"; then green "the page loads Swiper from the vendored path"; else red "no Swiper on the setup page"; fi
if grep -qiE 'role="dialog"|aria-modal' "$PAGE"; then green "the panel is declared as a modal dialog"; else red "no aria-modal / role=dialog"; fi
if grep -qiE 'allowTouchMove' "$PAGE" || grep -qiE 'allowTouchMove' "$WORK/public"/onboarding.js 2>/dev/null; then
  green "touch movement is controlled per pane"
else
  red "no allowTouchMove control (the licence pane can be swiped past)"
fi
if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/state")" = "409" ]; then
  green "the studio API still refuses before setup"
else
  red "the studio API answers before setup"
fi
if grep -q "Mr Vuyi" "$PAGE" 2>/dev/null; then red "the old client name is still in the page"; else green "no client name in the page"; fi

head_l "P3.7 mock mode is bannered"
if grep -qiE 'mock' "$PAGE" 2>/dev/null; then green "mock mode is announced in the UI"; else red "mock mode is not announced"; fi

head_l "P3.5 skip flag is loopback-only"
if grep -qE 'H3UI_SKIP_ONBOARDING' server.js 2>/dev/null; then
  if grep -qE 'loopback|127\.0\.0\.1|::1' server.js 2>/dev/null; then
    green "the skip flag is aware of loopback"
  else
    red "H3UI_SKIP_ONBOARDING has no loopback check"
  fi
else
  red "H3UI_SKIP_ONBOARDING is not implemented"
fi

if [ -f "$WORK/pid" ]; then kill "$(cat "$WORK/pid")" 2>/dev/null; fi
rm -rf "$WORK" "$KHOME"

head_l "P3.6 suite"
assert_node_syntax
run_tests

finish P3
