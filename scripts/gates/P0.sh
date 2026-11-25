#!/usr/bin/env bash
# P0 — the staging tree is exactly the reviewed subset, and it starts.
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

head_l "P0.1 core entries"
for p in server.js lib public tests scripts/gate.sh config.example.json; do
  [ -e "$p" ] && green "$p present" || red "$p missing"
done

head_l "P0.2 nothing private came along"
# data/ is runtime state, not source: it may exist, but nothing under it is tracked.
if [ -n "$(git ls-files data 2>/dev/null)" ]; then
  red "data/ has tracked files (client renders or run state)"
else
  green "data/ holds no tracked files"
fi
if git check-ignore -q data/runs 2>/dev/null || grep -q '^data/' .gitignore 2>/dev/null; then
  green "data/ is gitignored"
else
  red "data/ is not gitignored"
fi
assert_absent "SPEC.md"              "internal design doc"
assert_absent "STATE.md"             "operator history"
assert_absent "FRONTEND-HANDOFF.md"  "internal handover"
if compgen -G "*.zip" > /dev/null; then red "*.zip present (client material)"; else green "no *.zip"; fi
if compgen -G ".lock_*" > /dev/null; then red ".lock_* present (run state)"; else green "no .lock_*"; fi
if find . -path ./.git -prune -o -name '*wesaipartner*' -print | grep -q .; then
  red "a file is named after the old operator"
else
  green "no operator-named files"
fi

head_l "P0.3 test baseline"
assert_node_syntax
run_tests

head_l "P0.4 gate registry responds"
for g in P0 P1 P2 P3 P4 P5 P6 P7; do
  [ -f "scripts/gates/${g}.sh" ] && green "gate ${g} present" || red "gate ${g} missing"
done

finish P0
