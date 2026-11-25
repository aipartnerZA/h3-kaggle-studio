#!/usr/bin/env bash
# P5 — a stranger's path from clone to the first screen, proven on a clean copy.
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

head_l "P5.2 the installer exists and is honest"
assert_file scripts/install.sh "the installer"
if bash -n scripts/install.sh 2>/dev/null; then green "install.sh parses"; else red "install.sh has a syntax error"; fi
for probe in 'node' 'python3' 'ffmpeg' 'ffprobe' 'kaggle'; do
  grep -q "$probe" scripts/install.sh && green "install.sh checks $probe" || red "install.sh does not check $probe"
done
grep -q 'config.example.json' scripts/install.sh && green "install.sh seeds config.json from the example" || red "install.sh does not create config.json"

head_l "P5.1 the README has a quickstart that matches reality"
for cmd in 'git clone' 'scripts/install.sh' 'node server.js'; do
  grep -qF "$cmd" README.md 2>/dev/null && green "README shows: $cmd" || red "README does not show: $cmd"
done
grep -qiF 'access_token' README.md && green "README says where the token goes" || red "README does not say where the token goes"

head_l "P5.4 the docs a stuck person needs"
assert_file docs/ARCHITECTURE.md "the pipeline in execution order"
assert_file docs/TROUBLESHOOTING.md "the failure modes"
for sec in 'stage' 'build' 'push' 'poll' 'collect' 'verify' 'publish'; do
  grep -qi "$sec" docs/ARCHITECTURE.md 2>/dev/null && green "ARCHITECTURE covers: $sec" || red "ARCHITECTURE omits: $sec"
done
for sec in '403' 'quota' 'queue'; do
  grep -qi "$sec" docs/TROUBLESHOOTING.md 2>/dev/null && green "TROUBLESHOOTING covers: $sec" || red "TROUBLESHOOTING omits: $sec"
done

head_l "P5.5 the container story is decided, not implied"
if [ -f Dockerfile ]; then
  note "a Dockerfile ships — it must be labelled community-supported, not a gate"
else
  note "no Dockerfile (the spec allows dropping it; record the reason in the ledger)"
fi

head_l "P5.3 fresh clone: install, tests, onboarding"
FRESH=$(mktemp -d)/clone
mkdir -p "$(dirname "$FRESH")"
if rsync -a --exclude .git --exclude data --exclude node_modules "$ROOT/" "$FRESH/" 2>/dev/null; then
  green "clean copy made at $FRESH"
else
  cp -a "$ROOT/." "$FRESH/" && green "clean copy made at $FRESH (cp)"
fi
rm -rf "$FRESH/data"
if ( cd "$FRESH" && bash scripts/install.sh > install.log 2>&1 ); then
  green "install.sh exits 0 on a clean copy"
  [ -f "$FRESH/config.json" ] && green "config.json created by the installer" || red "installer did not create config.json"
else
  red "install.sh failed on a clean copy"
  tail -15 "$FRESH/install.log" 2>/dev/null | sed 's/^/        /'
fi
if ( cd "$FRESH" && node tests/index.js > tests.log 2>&1 ); then
  green "tests green in the clean copy"
else
  red "tests failed in the clean copy"
  tail -20 "$FRESH/tests.log" 2>/dev/null | sed 's/^/        /'
fi

PORT=$(free_port); KHOME=$(mktemp -d)
( cd "$FRESH" && MOCK_KAGGLE=1 H3UI_PORT="$PORT" H3UI_BIND=127.0.0.1 H3UI_NO_WORKER=1 \
  H3UI_KAGGLE_HOME="$KHOME" node server.js >srv.log 2>&1 & echo $! > srv.pid )
if wait_health "$PORT"; then
  if curl -s "http://127.0.0.1:$PORT/" | grep -qF 'By continuing, you agree to the Terms and Conditions listed below:'; then
    green "the clone serves the terms gate on a clean machine"
  else
    red "the clone does not serve the onboarding"
  fi
else
  red "the clone's server did not start"
  tail -12 "$FRESH/srv.log" 2>/dev/null | sed 's/^/        /'
fi
[ -f "$FRESH/srv.pid" ] && kill "$(cat "$FRESH/srv.pid")" 2>/dev/null
rm -rf "$KHOME"

if [ -n "$(git -C "$ROOT" status --porcelain data 2>/dev/null)" ]; then
  red "data/ is tracked or dirty — it must be gitignored"
else
  green "data/ is not part of the tracked tree"
fi

finish P5
