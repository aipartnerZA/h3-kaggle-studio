"""Assemble an H3 PRO kernel.

Notebook cells 2/4/6/8/11/13 verbatim (as in build_one.py), plus:
  * an override block after cell 2 (VDN off, optional ComfyUI re-pin),
  * an extra-download block after cell 11 for the ref2va checkpoint, the Pika
    Flex adapters and any other pinned file, with byte sizes and SHA256,
  * pro_tail.py as the driver: it builds the API graph itself (ctrl/flex/ref).

Usage: python3 build_pro.py <jobs.json> <out_dir> <kernel_id> <title> [options.json]
jobs.json: {"jobs":[{id,prompt,mode,aspect,quality,seconds,seed,start_image,ref_images,
                     ref_image_size,video_vae,timeout}]}
options.json: {"comfy_commit": "...", "extra_downloads": [[repo, path, size, sha, folder], ...],
               "driver": "pro_tail.py"}
"""
import base64
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_kernel as bk

# Default set: ref2va checkpoint + Pika Flex adapters + ref turbo LoRA.
# (repo, path in repo, size in bytes, sha256, folder or None)
# Use folder=None with the FULL repo path for Comfy-Org files: fetch() strips the
# directory when folder is set, which only works for repos whose files sit at the root
# (lightx2v). With folder="loras" the request became /resolve/main/<name> -> 404.
DEFAULT_DOWNLOADS = [
    ("Comfy-Org/MiniMax-H3", "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
     20970379616, "9255f52b6677845ad238f20dfaafa94727053694127ab7f255c048f0f9365779", None),
    ("Comfy-Org/MiniMax-H3", "loras/pika_h3_flex_fl2va_v1_bf16.safetensors",
     1956172304, "cc5453aeecd6189468409003fe4cf1b57e52ff3a830a0a154b87decbe07358b7", None),
    ("Comfy-Org/MiniMax-H3", "loras/pika_h3_flex_ref2va_v1_bf16.safetensors",
     1956172304, "de3745ceb7d8d5c20898dd8fa3a05f1c0b00089ccd55297b2a8bab95c766b0e0", None),
    ("Comfy-Org/MiniMax-H3", "loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
     1956193000, "5b9ab5ade15d0775676d01a907268a69a1468dc6033b3b0d3ded5502f3ebb84c", None),
]


def main():
    jobs_file, out_dir, kernel_id, title = sys.argv[1:5]
    options = {}
    if len(sys.argv) > 5:
        options = json.load(open(sys.argv[5], encoding="utf-8"))
    # options "extra_downloads" EXTENDS the default set; "replace_downloads" overrides it outright.
    downloads = options.get("replace_downloads") or (DEFAULT_DOWNLOADS + options.get("extra_downloads", []))
    driver = options.get("driver", "pro_tail.py")
    commit = options.get("comfy_commit")
    install_vdn = bool(options.get("install_vdn", False))

    spec = json.load(open(jobs_file, encoding="utf-8"))

    # A non-default VAE is a weight + commit contract, not a label. The quantised VAEs
    # (Sol int8 convrot) only build on the v0.44.1 pin; on v0.34.0 comfy.sd.VAE returns
    # None and every job dies at node vae_v with "VAE is invalid: None" in ~1 min.
    default_vae = "minimax_h3_video_vae_fp16.safetensors"
    custom_vae = sorted({j["video_vae"] for j in spec["jobs"]
                         if j.get("video_vae") and j["video_vae"] != default_vae})
    if custom_vae and not commit:
        raise SystemExit("build_pro: jobs name non-default VAE(s) %s but no comfy_commit in %s. "
                         "Add the v0.44.1 pin (options_prod.json / options_scene.json) -- an unpinned "
                         "build runs v0.34.0 and fails every job." % (", ".join(custom_vae), sys.argv[5]))
    if custom_vae:
        paths = " ".join(str(d[1]) for d in downloads)
        missing = [n for n in custom_vae if n not in paths]
        if missing:
            raise SystemExit("build_pro: jobs name %s but the download list never fetches it." % ", ".join(missing))

    override = ["# ---- PRO kernel overrides (ours, after cell 2) ----",
                "# VDN: %s" % ("installed (this probe measures it as a baseline)"
                               if install_vdn else "kept off so setup does not pay ~4 GB of downloads"),
                "INSTALL_VDN_EXPERIMENT = %s" % install_vdn]
    if commit:
        override.append("# Re-pinned ComfyUI commit for this probe.")
        override.append('COMFYUI_COMMIT = "%s"' % commit)
    override_src = "\n".join(override) + "\n"

    node_src = open(os.path.join(HERE, "h3_pro_node.py"), encoding="utf-8").read()
    extra_node = ("\n# ---- PRO extra node (ours, after cell 8) ----\n"
                  "PRO_NODE_SRC = %r\n"
                  'PRO_NODE_DIR = COMFY_HOME / "custom_nodes" / "h3_pro"\n'
                  "PRO_NODE_DIR.mkdir(parents=True, exist_ok=True)\n"
                  '(PRO_NODE_DIR / "__init__.py").write_text(PRO_NODE_SRC, encoding="utf-8")\n'
                  'print("written:", PRO_NODE_DIR / "__init__.py")\n') % (node_src,)

    extra_fetch = ("\n# ---- PRO extra downloads (ours, after cell 11) ----\n"
                   "EXTRA_DOWNLOADS = %r\n"
                   "for _repo, _rel, _size, _digest, _folder in EXTRA_DOWNLOADS:\n"
                   "    fetch(_repo, _rel, _size, _digest, folder=_folder)\n"
                   'print("\\n  PRO extra files ready")\n') % (downloads,)

    spec = json.load(open(jobs_file, encoding="utf-8"))
    out = os.path.join(HERE, out_dir)
    os.makedirs(out, exist_ok=True)

    b64 = {}
    image_key = {}

    def blob(path):
        """One base64 constant per distinct start image, keyed by path, so a
        multi-job kernel can give each job its own first frame."""
        if path not in image_key:
            key = "IMG%d_B64" % (len(image_key) + 1)
            image_key[path] = key
            b64[key] = base64.b64encode(open(path, "rb").read()).decode()
        return image_key[path]

    lines = ["JOBS = ["]
    for job in spec["jobs"]:
        start = job.get("start_image")
        refs = job.get("ref_images") or []
        start_key = blob(start) if start else None
        ref_keys = [blob(p) for p in refs]
        lines.append("    {")
        for field in ("id", "prompt", "mode", "aspect", "quality", "seconds", "seed",
                      "ref_image_size", "video_vae", "timeout"):
            if field in job:
                lines.append('        "%s": %r,' % (field, job[field]))
        if start:
            lines.append('        "images": {"first": %s},' % start_key)
        elif ref_keys:
            slots = ", ".join('"ref%d": %s' % (i, k) for i, k in enumerate(ref_keys, 1))
            lines.append('        "images": {%s},' % slots)
        lines.append("    },")
    lines.append("]")
    jobs_src = "\n".join(lines) + "\n"

    nb = json.load(open(bk.NB, encoding="utf-8"))
    parts = [bk.BANNER]
    for idx in (2, 4, 6, 8, 11, 13):
        parts.append(bk.cell(nb, idx))
        if idx == 2:
            parts.append(override_src)
        if idx == 8:
            parts.append(extra_node)
        if idx == 11:
            parts.append(extra_fetch)
    parts.append(bk.FOOTER_NOTE)
    for key, val in b64.items():
        parts.append('%s = "%s"\n\n' % (key, val))
    parts.append(jobs_src + "\n")
    parts.append(open(os.path.join(HERE, driver), encoding="utf-8").read())

    src = "".join(parts)
    path = os.path.join(out, "h3-pro.py")
    open(path, "w", encoding="utf-8").write(src)
    meta = {"id": kernel_id, "title": title, "code_file": "h3-pro.py", "language": "python",
            "kernel_type": "script", "is_private": True, "enable_gpu": True, "enable_tpu": False,
            "enable_internet": True, "keywords": [], "dataset_sources": [], "kernel_sources": [],
            "competition_sources": [], "model_sources": [], "machine_shape": "NvidiaTeslaT4"}
    json.dump(meta, open(os.path.join(out, "kernel-metadata.json"), "w"), indent=2)
    print("wrote %s (%d chars, %.0f KB); commit=%s; b64 keys: %s"
          % (path, len(src), len(src) / 1024.0, commit or "pinned-in-cell-2",
             ", ".join(sorted(b64))))


if __name__ == "__main__":
    main()
