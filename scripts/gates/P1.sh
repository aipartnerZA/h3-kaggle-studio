#!/usr/bin/env bash
# P1 — a stranger's machine can render: no operator paths, no operator username.
source "$(cd "$(dirname "$0")" && pwd)/_lib.sh"

head_l "P1.1 engine vendored"
for f in stage_shot.py prep_still.sh run_six.sh collect_run.sh build_pro.py build_kernel.py \
         h3_pro_node.py pro_tail.py options_scene.json ref/nb_flf.ipynb verify_run.py; do
  assert_file "engine/$f" "engine file from the reuse manifest"
done

head_l "P1.2 no host paths, no operator identity"
assert_no_string '/root/apps/h3-kaggle' 'the old engine path'      .
assert_no_string '/srv/storage'         'the delivery path'        .
assert_no_string '/root/\.local'        "the operator's PATH"      .
assert_no_string 'wesaipartner'         'the operator username'    .
assert_no_string 'aipartner\.co\.za'    'the production hostname'  .
assert_no_string '/root/'               'any /root path'           .

head_l "P1.3 the engine resolves inside the repo"
if grep -qE 'H3_ENGINE_ROOT|SCRIPT_DIR=\$\(cd "\$\(dirname' engine/run_six.sh engine/collect_run.sh 2>/dev/null; then
  green "engine scripts resolve their own directory"
else
  red "engine scripts still rely on an external root"
fi
if grep -qE 'Path\(__file__\)|os\.path\.dirname\(__file__\)' engine/stage_shot.py; then
  green "stage_shot.py resolves the engine root from its own file"
else
  red "stage_shot.py has no __file__-relative root"
fi

head_l "P1.4 artefacts under data/, no external delivery"
if grep -rqE 'data/runs|DATA_DIR|runsDir' lib/ engine/ 2>/dev/null; then
  green "run artefacts live under data/"
else
  red "run artefact paths not found under data/"
fi
if grep -rqE 'srv/storage|Video/h3-' engine/ lib/ 2>/dev/null; then
  red "an external delivery step survives"
else
  green "no external delivery step"
fi

head_l "P1.5/P1.7 config and binary resolution"
assert_file config.example.json "the template that ships"
if grep -q 'kaggle_bin' lib/kaggle.js server.js 2>/dev/null; then
  green "kaggle binary comes from config/PATH"
else
  red "kaggle binary is not resolved from config/PATH"
fi

head_l "P1.6 prefix is configurable"
if grep -qE 'H3UI_PREFIX|config\.prefix' server.js; then
  green "prefix is read from config/env"
else
  red "prefix is hardcoded"
fi
if grep -qE '"/h3/|/h3/assets' public/index.html; then
  red "public/index.html still hardcodes /h3 asset paths"
else
  green "public/index.html has no hardcoded /h3 asset path"
fi

head_l "P1.8 code and tests"
assert_node_syntax
run_tests

head_l "P1.9 dry-run kernel build (no push, no quota spent, no credential)"
DRYTAG=gate-dryrun
rm -rf "engine/kernel_${DRYTAG}" "data/runs/${DRYTAG}"
mkdir -p "data/runs/${DRYTAG}"
python3 - "tests/fixtures/dryrun/jobs.json" "data/runs/${DRYTAG}/jobs.json" <<'PY'
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
root = os.getcwd()
j = json.load(open(src))
for job in j["jobs"]:
    if job.get("start_image"):
        job["start_image"] = os.path.join(root, job["start_image"])
json.dump(j, open(dst, "w"), indent=2)
PY
DRYLOG=/tmp/gate-p1-dryrun-$$.log
if KAGGLE_OWNER=gate-dryrun bash engine/run_six.sh "$DRYTAG" --dry-run > "$DRYLOG" 2>&1; then
  green "engine/run_six.sh --dry-run exits 0 with no credential"
  K="engine/kernel_${DRYTAG}/h3-pro.py"
  if [ -f "$K" ]; then
    green "$K built"
    SIZE=$(stat -c%s "$K" 2>/dev/null || stat -f%z "$K")
    [ "$SIZE" -lt 1000000 ] && green "script is $((SIZE/1024)) KB, under the 1 MB push ceiling" || red "script is $((SIZE/1024)) KB — over the push ceiling"
    grep -q 'COMFYUI_COMMIT = "49b61c3cd044fb65acd97a960467a00414694146"' "$K" \
      && green "$K carries the ComfyUI pin" || red "$K lost the ComfyUI pin"
  else
    red "the dry run produced no $K"
  fi
else
  red "engine/run_six.sh --dry-run failed — see $DRYLOG"
  tail -15 "$DRYLOG" 2>/dev/null | sed 's/^/        /'
fi
rm -rf "engine/kernel_${DRYTAG}" "data/runs/${DRYTAG}"

finish P1
