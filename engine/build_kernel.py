"""Assemble the H3 batch kernel: notebook cells 2/4/6/8/11/13 verbatim + our batch driver."""
import base64
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
NB = os.path.join(HERE, "ref", "nb_flf.ipynb")
KERNEL_DIR = os.path.join(HERE, "kernel")
OWNER = os.environ.get("KAGGLE_OWNER", "").strip()
KERNEL_ID = (OWNER + "/h3-batch") if OWNER else "h3-batch"
KERNEL_TITLE = "h3-batch"

BANNER = '''# -*- coding: utf-8 -*-
# MiniMax H3 batch renderer on Kaggle T4 x2  --  A.I Partner
# Setup cells 2/4/6/8/11/13 are taken verbatim from the published notebook
# (github.com/cafermutluozkan/free-ai-notebooks, minimax-h3-fast-video-generator-kaggle-t4x2),
# every model, commit and LoRA SHA256-pinned. The studio page, the access key and the
# cloudflared public tunnel are dropped: this is a headless batch renderer, localhost only.
import os
import sys
import time

'''

FOOTER_NOTE = '''
# ---------------------------------------------------------------------
# JOBS: edit this block to change what gets rendered. quality is
# "draft" (0.2MP) / "standard" (0.3MP) / "high" (0.4MP); seconds 2-15.
# images: "first" and/or "last", base64 PNG/JPG. speed_modes: leave out
# to use VDN -> turbo8_768 -> turbo4 -> slow 20-step fallback chain.
# ---------------------------------------------------------------------
'''

JOBS = '''JOBS = [
    {
        "id": "t2v",
        "prompt": "A slow cinematic push-in on a single red ceramic cube standing in a "
                  "field of dry golden grass at sunset, distant blue hills, warm rim light, "
                  "gentle wind moving the grass, shallow depth of field, 35mm film look.",
        "aspect": "landscape", "quality": "draft", "seconds": 5, "seed": 20261026,
        "images": {},
    },
    {
        "id": "i2v",
        "prompt": "The sun sinks slowly toward the horizon, long shadows stretch across the "
                  "field, the red cube stays fixed in place as the camera drifts steadily to "
                  "the right, warm golden hour light, cinematic.",
        "aspect": "landscape", "quality": "draft", "seconds": 5, "seed": 770001,
        "images": {"first": FIRST_B64},
    },
    {
        "id": "flf",
        "prompt": "A smooth steady camera pan from left to right across a golden field while "
                  "the sun sits low in the sky and the red cube slides out of frame, "
                  "warm sunset tones, cinematic 35mm.",
        "aspect": "landscape", "quality": "draft", "seconds": 5, "seed": 770002,
        "images": {"first": FIRST_B64, "last": LAST_B64},
    },
]
'''


def cell(nb, index):
    src = "".join(nb["cells"][index]["source"]).rstrip("\n")
    return "# " + "=" * 67 + "\n#  notebook cell %d\n# " % index + "=" * 67 + "\n" + src + "\n\n"


def main():
    nb = json.load(open(NB, encoding="utf-8"))
    os.makedirs(KERNEL_DIR, exist_ok=True)

    assets = os.path.join(HERE, "assets")
    first = base64.b64encode(open(os.path.join(assets, "first.png"), "rb").read()).decode()
    last = base64.b64encode(open(os.path.join(assets, "last.png"), "rb").read()).decode()

    parts = [BANNER]
    for idx in (2, 4, 6, 8, 11, 13):
        parts.append(cell(nb, idx))
    parts.append(FOOTER_NOTE)
    parts.append('FIRST_B64 = "%s"\nLAST_B64 = "%s"\n\n' % (first, last))
    parts.append(JOBS + "\n")
    parts.append(open(os.path.join(HERE, "driver_tail.py"), encoding="utf-8").read())

    src = "".join(parts)
    path = os.path.join(KERNEL_DIR, "h3-batch.py")
    open(path, "w", encoding="utf-8").write(src)

    meta = {
        "id": KERNEL_ID,
        "title": KERNEL_TITLE,
        "code_file": "h3-batch.py",
        "language": "python",
        "kernel_type": "script",
        "is_private": True,
        "enable_gpu": True,
        "enable_tpu": False,
        "enable_internet": True,
        "keywords": [],
        "dataset_sources": [],
        "kernel_sources": [],
        "competition_sources": [],
        "model_sources": [],
        "machine_shape": "NvidiaTeslaT4",
    }
    json.dump(meta, open(os.path.join(KERNEL_DIR, "kernel-metadata.json"), "w"), indent=2)
    print("wrote", path, len(src), "chars")


if __name__ == "__main__":
    main()
