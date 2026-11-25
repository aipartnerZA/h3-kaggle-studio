#!/usr/bin/env bash
# P3 — the first-run panel: full screen, one terms gate read to the end, then the account, no bypass.
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

head_l "P3.1 no third-party bundle is loaded or shipped"
if grep -rqE 'cdn\.jsdelivr|unpkg\.com|cdnjs' public/*.html public/*.js public/*.css 2>/dev/null; then
  red "a CDN reference is present — assets must be self-hosted"
else
  green "no CDN references in the served assets"
fi
if grep -qiE 'src="https?://' public/*.html 2>/dev/null; then
  red "a page loads a script from another host"
else
  green "no page loads a script from another host"
fi
if [ -d "$ROOT/public/vendor" ]; then
  red "public/vendor still exists — the panel should need no vendored bundle"
else
  green "no vendored third-party bundle in the tree"
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
check_copy "By continuing, you agree to the Terms and Conditions listed below:"
check_copy "MiniMax H3 Community Licence Agreement"
check_copy "European Union, the United Kingdom"
check_copy "South Korea"
check_copy "Powered by MiniMax H3"
check_copy "personal, non-commercial use"
check_copy "termination of your account"
check_copy "Connect your Kaggle account"
check_copy "kaggle.json"
check_copy "Not affiliated with Kaggle or MiniMax"

head_l "P3.3 the gate cannot be walked around in the browser"
if grep -qiE 'role="dialog"|aria-modal' "$PAGE"; then green "the panel is declared as a modal dialog"; else red "no aria-modal / role=dialog"; fi
if grep -qE 'id="ob-continue"[^>]*disabled' "$PAGE"; then
  green "the continue button is disabled in the served markup"
else
  red "the continue button is not disabled in the markup (the terms could be skipped)"
fi
if grep -qE 'scrollTop' "$WORK/public/onboarding.js" 2>/dev/null \
   && grep -qE 'scrollHeight' "$WORK/public/onboarding.js" 2>/dev/null; then
  green "the button opens on a bottom-of-box test, not a timer or a checkbox"
else
  red "onboarding.js has no bottom-of-box scroll test"
fi
if grep -qiE "addEventListener\('scroll'" "$WORK/public/onboarding.js" 2>/dev/null; then
  green "the scroll event is what re-enables it"
else
  red "nothing listens for the terms being scrolled"
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
