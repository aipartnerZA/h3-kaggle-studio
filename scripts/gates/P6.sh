#!/usr/bin/env bash
# P6 — published: the remote matches this tree, a stranger can clone it, and no secret went with it.
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

REPO_SLUG_DEFAULT="aipartnerZA/h3-kaggle-studio"
SLUG="${H3_REPO_SLUG:-$REPO_SLUG_DEFAULT}"

head_l "P6.1 the remote exists and is the intended one"
if ! git remote get-url origin >/dev/null 2>&1; then
  red "no git remote 'origin' — P6.2 has not run"
else
  URL=$(git remote get-url origin)
  green "origin = $URL"
  case "$URL" in
    *"$SLUG"*) green "origin points at $SLUG" ;;
    *) red "origin does not point at $SLUG" ;;
  esac
fi

head_l "P6.2 the pushed commit is this commit"
LOCAL=$(git rev-parse HEAD)
if REMOTE=$(git ls-remote origin refs/heads/main 2>/dev/null | awk '{print $1}'); then
  if [ -n "$REMOTE" ] && [ "$REMOTE" = "$LOCAL" ]; then
    green "origin/main = $LOCAL"
  else
    red "origin/main (${REMOTE:-absent}) is not HEAD ($LOCAL) — push is behind or missing"
  fi
else
  red "git ls-remote origin failed"
fi

head_l "P6.4 an anonymous clone works"
TMP=$(mktemp -d)
CLONE="$TMP/clone"
if GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true GIT_CONFIG_GLOBAL=/dev/null \
   git clone -q --depth 1 "https://github.com/${SLUG}.git" "$CLONE" 2>"$TMP/clone.err"; then
  green "anonymous clone of https://github.com/${SLUG}.git succeeded"
  if [ -f "$CLONE/README.md" ] && [ -f "$CLONE/LICENSE" ]; then
    green "the clone carries README.md and LICENSE"
  else
    red "the clone is missing README.md or LICENSE"
  fi
  if ( cd "$CLONE" && cp config.example.json config.json && node tests/index.js >"$TMP/tests.log" 2>&1 ); then
    green "the clone's test suite is green"
  else
    red "the clone's test suite failed — see $TMP/tests.log"
    tail -20 "$TMP/tests.log" 2>/dev/null | sed 's/^/        /'
  fi
  PORT=$(free_port); KHOME=$(mktemp -d)
  ( cd "$CLONE" && MOCK_KAGGLE=1 H3UI_PORT="$PORT" H3UI_BIND=127.0.0.1 H3UI_NO_WORKER=1 \
      H3UI_KAGGLE_HOME="$KHOME" H3UI_DATA_DIR="$TMP/data" node server.js >"$TMP/srv.log" 2>&1 & echo $! > "$TMP/pid" )
  if wait_health "$PORT"; then
    if curl -s "http://127.0.0.1:$PORT/" | grep -qF 'Render video on a free GPU'; then
      green "the anonymous clone serves the onboarding"
    else
      red "the anonymous clone does not serve the onboarding"
    fi
  else
    red "the anonymous clone's server did not start"
    tail -12 "$TMP/srv.log" 2>/dev/null | sed 's/^/        /'
  fi
  [ -f "$TMP/pid" ] && kill "$(cat "$TMP/pid")" 2>/dev/null
  rm -rf "$KHOME"
else
  red "anonymous clone failed — the repo is still private (P6.4 pending)"
  sed 's/^/        /' "$TMP/clone.err" 2>/dev/null | head -4
fi
rm -rf "$TMP"

head_l "P6.4b no secret or operator identity in the committed history"
LOG=$(git log --all -p --format='commit %H%nAuthor: %an <%ae>%n' 2>/dev/null)
bad=0
for pat in 'gho_[A-Za-z0-9]' 'ghp_[A-Za-z0-9]' 'BEGIN [A-Z ]*PRIVATE KEY' 'kaggle[a-z_]*key' 'access_token='; do
  [ -z "$pat" ] && continue
  if printf '%s' "$LOG" | grep -qE -- "$pat"; then
    red "history contains a credential-shaped string matching: $pat"
    bad=1
  fi
done
[ "$bad" -eq 0 ] && green "no credential-shaped string in git log -p"
assert_no_string 'wesaipartner'       'the operator username'   .
assert_no_string '/root/apps/h3-kaggle' 'the old engine path'    .
assert_no_string 'Mr Vuyi'            'the experimental operator client' .

head_l "P6.5 a release tag exists"
if git tag --list 'v1.*' | grep -q .; then
  green "tags: $(git tag --list 'v1.*' | tr '\n' ' ')"
else
  red "no v1.* tag yet"
fi

finish P6
