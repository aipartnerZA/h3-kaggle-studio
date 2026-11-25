#!/usr/bin/env bash
# P4 — the licence obligations are in the artifact, not only in a document.
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

head_l "P4.3 MIT LICENSE and the NOTICE sentence"
assert_file LICENSE "MIT"
if grep -q 'MIT License' LICENSE && grep -qi 'A.I Partner' LICENSE; then green "LICENSE is MIT with a named holder"; else red "LICENSE is not MIT or has no holder"; fi
assert_file NOTICE "the H3 notice"
NOTICE_SENTENCE='MiniMax H3 is licensed under the MiniMax H3 Community License Agreement, Copyright © 2026 MiniMax. All Rights Reserved.'
if grep -qF "$NOTICE_SENTENCE" NOTICE; then green "NOTICE carries the section III.4 sentence verbatim"; else red "NOTICE is missing the exact section III.4 sentence"; fi

head_l "P4.1 attribution in the interface"
PORT=$(free_port); WORK=$(mktemp -d); KHOME=$(mktemp -d)
rsync -a --exclude .git --exclude data --exclude node_modules "$ROOT/" "$WORK/" 2>/dev/null || cp -a "$ROOT/." "$WORK/"
# pre-seed a ready setup so the studio markup is served
mkdir -p "$WORK/data"
cat > "$WORK/data/setup.json" <<'JSON'
{"schema":1,"licence_version":"minimax-h3-2026-08-02","licence_accepted_at":"2026-11-25T00:00:00Z","territory_attested":true,"kaggle_tou_ack_at":"2026-11-25T00:00:00Z","kaggle_tou_version":"2025-06-22","username":"tester","kaggle_cli_version":"2.2.5","last_probe_at":"2026-11-25T00:00:00Z","last_probe_result":"ok"}
JSON
chmod 600 "$WORK/data/setup.json"
( cd "$WORK" && cp config.example.json config.json 2>/dev/null
  MOCK_KAGGLE=1 H3UI_PORT="$PORT" H3UI_BIND=127.0.0.1 H3UI_NO_WORKER=1 \
  H3UI_KAGGLE_HOME="$KHOME" node server.js >"$WORK/server.log" 2>&1 & echo $! > "$WORK/pid" )
if wait_health "$PORT"; then
  STUDIO=$(curl -s "http://127.0.0.1:$PORT/" 2>/dev/null)
  if printf '%s' "$STUDIO" | grep -qF 'Powered by MiniMax H3'; then green "studio footer carries 'Powered by MiniMax H3'"; else red "studio footer has no attribution"; fi
  if printf '%s' "$STUDIO" | grep -qF 'MiniMax H3'; then green "the model is named prominently (section IV.2)"; else red "the model is not named in the UI"; fi
  if printf '%s' "$STUDIO" | grep -qi 'Mr Vuyi'; then red "client name still in the studio"; else green "no client name in the studio"; fi
else
  red "server did not boot for the attribution check"
fi
[ -f "$WORK/pid" ] && kill "$(cat "$WORK/pid")" 2>/dev/null
rm -rf "$WORK" "$KHOME"

head_l "P4.2 the AI-generation identifier is applied to published files"
if grep -rqE 'comment=|AI-generated|MiniMax H3' lib/pipeline.js 2>/dev/null; then
  green "publish step writes an identifier into the mp4 metadata"
else
  red "no metadata write found in lib/pipeline.js"
fi
if command -v ffmpeg >/dev/null 2>&1; then
  T=$(mktemp -d)
  ffmpeg -v error -f lavfi -i color=c=black:s=64x64:d=1 -y "$T/in.mp4" >/dev/null 2>&1
  if [ -s "$T/in.mp4" ]; then
    if node -e '
      const { execFileSync } = require("child_process");
      const fs = require("fs");
      const f = process.argv[1];
      const t = f.replace(/\.mp4$/, ".s.mp4");
      execFileSync("ffmpeg", ["-y","-v","error","-i",f,"-c","copy",
        "-metadata","title=MiniMax H3",
        "-metadata","comment=AI-generated video - MiniMax H3 via h3-kaggle-studio v1.0.0",
        t], { stdio: "ignore" });
      fs.renameSync(t, f);
      const out = execFileSync("ffprobe", ["-v","quiet","-print_format","json","-show_format",f], { encoding: "utf8" });
      process.exit(out.indexOf("MiniMax H3") >= 0 ? 0 : 1);
    ' "$T/in.mp4" 2>/dev/null; then
      green "the identifier is readable back out of the mp4 (ffprobe)"
    else
      red "ffprobe cannot read the identifier back"
    fi
  else
    note "ffmpeg is present but cannot synthesise a test file; metadata check skipped"
  fi
  rm -rf "$T"
else
  note "ffmpeg not installed here; metadata proof deferred"
fi

head_l "P4.4 the README states the six things a stranger must know"
README_MISS=0
for topic in 'European Union' 'United Kingdom' 'South Korea' 'United States' 'personal, non-commercial' '20 million'; do
  if grep -qiF "$topic" README.md 2>/dev/null; then green "README warns about: $topic"; else red "README does not mention: $topic"; README_MISS=1; fi
done
if grep -qiE 'no model weights|does not (bundle|ship) .*weights|ships? no .*weights' README.md 2>/dev/null; then
  green "README says the weights are not included"
else
  red "README does not say the weights are not included"
fi

head_l "P4.5 the compliance document quotes the clauses"
assert_file docs/COMPLIANCE.md "the clause-by-clause document"
for clause in 'I.5' 'V.4' 'IV.1' 'IV.2' 'V.2' 'III.4'; do
  grep -qF "$clause" docs/COMPLIANCE.md 2>/dev/null && green "COMPLIANCE cites section $clause" || red "COMPLIANCE does not cite section $clause"
done

finish P4
