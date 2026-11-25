#!/usr/bin/env python3
"""Stage one 15 s shot into data/runs/<tag>/jobs.json and prep its start image.

    ./stage_shot.py --id s1_foo --image /path/in.png --prompt-file /tmp/p.txt [--seed 813001]
    ./stage_shot.py --id s1_foo --image /path/in.png --prompt "one line prompt"
    ./stage_shot.py --tag 20261109 --id s1_foo --image ... --prompt ...   # a new run
    ./stage_shot.py --tag 20261109 --reset                               # empty the batch

The engine root defaults to the directory holding this script (or to
H3_ENGINE_ROOT when a parent process sets it); pass --root to override. Run
artefacts stay inside the tree: data/runs/<tag>/jobs.json and
data/runs/<tag>/queue/prep/.

Defaults match the proven 15 s recipe: mode vdn, landscape, standard, 15 s,
Sol int8 VAE, start_image prepped to 736x416 JPEG (~80 KB) by prep_still.sh.
Re-running with the same --id replaces that shot in place; a new --tag starts
an independent batch, so a previous run's shots can never leak into the next one.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

DEFAULT_ROOT = Path(os.environ.get("H3_ENGINE_ROOT") or Path(__file__).resolve().parent)
VAE = "minimax_h3_sol_vae_int8_convrot.safetensors"


def paths(root: Path, tag: str) -> tuple[Path, Path]:
    run = root.parent / "data" / "runs" / tag
    queue = run / "jobs.json"
    prep = run / "queue" / "prep"
    prep.mkdir(parents=True, exist_ok=True)
    return queue, prep


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(DEFAULT_ROOT),
                    help="engine root (the directory holding this script)")
    ap.add_argument("--tag", default="six", help="run tag (default: six)")
    ap.add_argument("--id")
    ap.add_argument("--image")
    ap.add_argument("--prompt-file")
    ap.add_argument("--prompt")
    ap.add_argument("--seed", type=int)
    ap.add_argument("--seconds", type=int, default=15, help="duration in seconds (default 15)")
    ap.add_argument("--reset", action="store_true", help="empty this tag's batch before staging")
    a = ap.parse_args()

    root = Path(a.root).resolve()
    queue, prep = paths(root, a.tag)

    if a.reset:
        queue.write_text(json.dumps({"note": "run %s" % a.tag, "jobs": []}, indent=2) + "\n")
        for old in prep.glob("*.jpg"):
            old.unlink()
        print("reset %s: 0 shot(s), prep cleared" % a.tag)
        if not a.id:
            return 0

    if not a.id:
        print("ERROR: need --id (or use --reset alone)")
        return 2

    if a.prompt_file:
        prompt = Path(a.prompt_file).read_text().strip()
    elif a.prompt:
        prompt = a.prompt.strip()
    else:
        print("ERROR: need --prompt-file or --prompt")
        return 2
    if not prompt:
        print("ERROR: empty prompt")
        return 2

    out = None
    if a.image:
        src = Path(a.image).expanduser()
        if not src.is_file():
            print(f"ERROR: image not found: {src}")
            return 2
        out = prep / f"{a.id}.jpg"
        r = subprocess.run(["bash", str(root / "prep_still.sh"), str(src), str(out), "80"],
                           capture_output=True, text=True)
        print(r.stdout.strip() or r.stderr.strip())
        if r.returncode != 0:
            return r.returncode

    if queue.is_file():
        data = json.loads(queue.read_text())
    else:
        data = {"note": "run %s" % a.tag, "jobs": []}
    jobs = data["jobs"]
    seed = a.seed if a.seed is not None else 813001 + len(jobs)
    job = {
        "id": a.id,
        "mode": "vdn",
        "prompt": prompt,
        "aspect": "landscape",
        "quality": "standard",
        "seconds": a.seconds,
        "seed": seed,
        "video_vae": VAE,
    }
    if out is not None:
        job["start_image"] = str(out)
    for i, j in enumerate(jobs):
        if j["id"] == a.id:
            jobs[i] = job
            break
    else:
        jobs.append(job)
    queue.write_text(json.dumps(data, indent=2) + "\n")

    total_b64 = sum((p.stat().st_size + 2) // 3 * 4 for p in prep.glob("*.jpg"))
    print(f"staged {len(jobs)} shot(s) for tag {a.tag}: " + ", ".join(j["id"] for j in jobs))
    print(f"prepped images: ~{total_b64 // 1024} KB base64 total "
          f"({len(list(prep.glob('*.jpg')))} files) in {queue.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
