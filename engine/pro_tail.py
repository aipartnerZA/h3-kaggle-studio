# =====================================================================
#  H3 PRO DRIVER (ours): builds the ComfyUI API graph locally instead of
#  calling the studio plugin's /h3/api/build, so it can express the modes
#  the plugin does not: Pika Flex (lcm + ManualSigmas), ref2va character
#  reference, and Flex-on-ref. Legacy turbo path kept as the control.
#  No tunnel, no studio page, localhost only.
# =====================================================================
import base64
import json
import math
import urllib.error
import urllib.request
import uuid

RUN_TAG = os.environ.get("H3_RUN_TAG", "probe")
OUT_DIR = FINAL_DIR / ("out_" + RUN_TAG)
OUT_DIR.mkdir(parents=True, exist_ok=True)
INPUT_DIR = COMFY_HOME / "input"
INPUT_DIR.mkdir(parents=True, exist_ok=True)
BASE_URL = "http://127.0.0.1:%d" % PORT
DEADLINE_S = float(os.environ.get("H3_DEADLINE_HOURS", "8")) * 3600.0
T0 = time.time()
RESULTS_PATH = OUT_DIR / (RUN_TAG + "_results.json")
FPS = 24

DIT_FILE = {
    "fl2va": "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    "ref2va": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
}
TEXT_ENCODER_FILE = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
VIDEO_VAE_FILE = "minimax_h3_video_vae_fp16.safetensors"
AUDIO_VAE_FILE = "minimax_h3_audio_vae_fp32.safetensors"
# mode -> (dit variant, lora file or None, steps, sampler, sigmas kind)
MODES = {
    "ctrl":     ("fl2va",  "minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors", 8, "res_multistep", "sched"),
    "ctrl4":    ("fl2va",  "minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors", 4, "res_multistep", "sched"),
    "flex":     ("fl2va",  "pika_h3_flex_fl2va_v1_bf16.safetensors", 6, "lcm", "manual"),
    "vdn":      ("fl2va",  None, 8, "euler", "sched"),
    "ref8":     ("ref2va", "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", 4, "res_multistep", "sched"),
    "flex_ref": ("ref2va", "pika_h3_flex_ref2va_v1_bf16.safetensors", 6, "lcm", "manual"),
}
VDN_STAGE_DIR = "stage-dmd-step-250-int8_convrot_comfyui"
# Pika Flex published schedule: lcm + these sigmas + CFG 1.0 (BasicGuider) + adapter strength 1.0.
FLEX_SIGMAS = "1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0"
ASPECTS = {"landscape": (16, 9), "portrait": (9, 16), "square": (1, 1)}
QUALITY = {"draft": 0.2, "standard": 0.3, "high": 0.4}


def say(msg):
    print("[%6.1f min] %s" % ((time.time() - T0) / 60.0, msg), flush=True)


def api(path, payload=None, timeout=60):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(BASE_URL + path, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


def start_comfy():
    env = os.environ.copy()
    env.update(PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True",
               H3_STUDIO_MAX_MP=str(MAX_MEGAPIXELS),
               H3_STUDIO_MAX_SECONDS=str(MAX_SECONDS),
               HF_HOME=str(WORK_ROOT / "hf_cache"))
    env.pop("H3_STUDIO_KEY", None)
    args = [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", str(PORT), "--lowvram",
            "--preview-method", "none", "--disable-api-nodes", "--disable-auto-launch",
            "--output-directory", str(GEN_DIR), "--temp-directory", str(TMP_DIR)]
    helptext = subprocess.run([sys.executable, "main.py", "--help"], cwd=COMFY_HOME, env=env,
                              capture_output=True, text=True).stdout
    if "--reserve-vram" in helptext:
        args += ["--reserve-vram", "0.8"]
    say("starting ComfyUI")
    log_fp = open(LOG_FILE, "w", encoding="utf-8")
    proc = subprocess.Popen(args, cwd=COMFY_HOME, env=env, stdout=log_fp, stderr=subprocess.STDOUT)
    t0 = time.time()
    while time.time() - t0 < 420:
        if proc.poll() is not None:
            raise RuntimeError("ComfyUI exited on startup:\n" + log_tail(120))
        try:
            api("/system_stats", timeout=5)
            say("ComfyUI ready in %.0f s" % (time.time() - t0))
            return proc, log_fp
        except Exception:
            time.sleep(3)
    raise RuntimeError("ComfyUI not ready after 7 min:\n" + log_tail(120))


def resolution(aspect, megapixels):
    wr, hr = ASPECTS[aspect]
    scale = math.sqrt(megapixels * 1024 * 1024 / (wr * hr))
    return (round(wr * scale / 32) * 32, round(hr * scale / 32) * 32)


def aligned_frames(seconds):
    frames = max(5, round(seconds * FPS))
    return frames + (5 - frames % 17) % 17


def write_images(job_id, images):
    names = {}
    for slot in ("first", "last", "ref1", "ref2"):
        if images.get(slot):
            name = "%s_%s.png" % (job_id, slot)
            (INPUT_DIR / name).write_bytes(base64.b64decode(images[slot]))
            names[slot] = name
    return names


def build_graph(job, images):
    mode = job["mode"]
    dit_key, lora_file, steps, sampler_name, sigma_kind = MODES[mode]
    width, height = resolution(job.get("aspect", "landscape"), QUALITY[job.get("quality", "standard")])
    frames = aligned_frames(job.get("seconds", 5))
    gpus = torch.cuda.device_count()
    graph = {}

    def node(name, class_type, **inputs):
        graph[name] = {"class_type": class_type, "inputs": inputs}
        return [name, 0]

    node("unet", "UNETLoader", unet_name=DIT_FILE[dit_key], weight_dtype="default")
    model = ["unet", 0]
    if mode == "vdn":
        model = node("vdn", "VDNH3Fast", model=["unet", 0], vdn_checkpoint=VDN_STAGE_DIR)
    elif lora_file:
        model = node("lora", "LoraLoaderModelOnly", model=model, lora_name=lora_file, strength_model=1.0)
    video_vae = job.get("video_vae", VIDEO_VAE_FILE)
    if gpus >= 2:
        clip = node("clip", "H3StudioTextEncoder", clip_name=TEXT_ENCODER_FILE, load_to="cuda:1")
        vae_v = node("vae_v", "H3StudioVAELoader", vae_name=video_vae, load_to="cuda:0")
        vae_a = node("vae_a", "H3StudioVAELoader", vae_name=AUDIO_VAE_FILE, load_to="cuda:0")
    else:
        clip = node("clip", "CLIPLoader", clip_name=TEXT_ENCODER_FILE, type="minimax", device="default")
        vae_v = node("vae_v", "VAELoader", vae_name=video_vae)
        vae_a = node("vae_a", "VAELoader", vae_name=AUDIO_VAE_FILE)

    if dit_key == "ref2va":
        cond_inputs = dict(clip=clip, vae=vae_v, audio_vae=vae_a, prompt=job["prompt"], width=width,
                           height=height, length=frames, ref_image_size=job.get("ref_image_size", "match"))
        refs = [images[k] for k in ("ref1", "ref2", "ref3", "ref4") if images.get(k)]
        for i, name in enumerate(refs, 1):
            cond_inputs["ref_image_%d" % i] = node("refd%d" % i, "LoadImage", image=name)
        # H3ProReferenceToVideo is ours: the upstream node's autogrow image slots
        # cannot be filled through /prompt (see h3_pro_node.py).
        node("cond", "H3ProReferenceToVideo", **cond_inputs)
    else:
        cond_inputs = dict(clip=clip, vae=vae_v, prompt=job["prompt"], width=width, height=height,
                           length=frames)
        if images.get("first"):
            cond_inputs["first_frame"] = node("first", "LoadImage", image=images["first"])
        if images.get("last"):
            cond_inputs["last_frame"] = node("last", "LoadImage", image=images["last"])
        node("cond", "MiniMaxH3ImageToVideo", **cond_inputs)

    noise = node("noise", "RandomNoise", noise_seed=job["seed"])
    guider = node("guider", "BasicGuider", model=model, conditioning=["cond", 0])
    sampler = node("sampler", "KSamplerSelect", sampler_name=sampler_name)
    if sigma_kind == "manual":
        sigmas = node("sched", "ManualSigmas", sigmas=FLEX_SIGMAS)
    else:
        sigmas = node("sched", "BasicScheduler", model=model, scheduler="simple", steps=steps, denoise=1.0)
    node("sample", "SamplerCustomAdvanced", noise=noise, guider=guider, sampler=sampler, sigmas=sigmas,
         latent_image=["cond", 1])
    picture = node("dec_v", "VAEDecode", samples=["sample", 0], vae=vae_v)
    sound = node("dec_a", "VAEDecodeAudio", samples=["sample", 0], vae=vae_a)
    video = node("video", "CreateVideo", images=picture, fps=FPS, audio=sound)
    node("save", "SaveVideo", video=video, filename_prefix="video/H3Pro", format="auto", codec="auto")

    summary = {"mode": mode, "dit": dit_key, "lora": lora_file, "sampler": sampler_name, "steps": steps,
               "sigmas": FLEX_SIGMAS if sigma_kind == "manual" else "simple/%d" % steps,
               "width": width, "height": height, "frames": frames, "video_vae": video_vae,
               "video_seconds": round(frames / FPS, 3), "gpus": gpus, "seed": job["seed"]}
    return graph, summary


def collect_outputs(history):
    found = []
    for node_out in (history.get("outputs") or {}).values():
        if not isinstance(node_out, dict):
            continue
        for value in node_out.values():
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, dict) and item.get("filename"):
                        found.append(item)
    return found


def render(job):
    job_id = job["id"]
    images = write_images(job_id, job.get("images") or {})
    t_build = time.time()
    graph, summary = build_graph(job, images)
    say("%s -> %s %dx%d %d frames (%.2fs) steps=%d sampler=%s"
        % (job_id, summary["mode"], summary["width"], summary["height"], summary["frames"],
           summary["video_seconds"], summary["steps"], summary["sampler"]))
    started = time.time()
    try:
        prompt_id = api("/prompt", {"prompt": graph, "client_id": str(uuid.uuid4())})["prompt_id"]
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")[:2000]
        say("%s QUEUE REJECTED (%s): %s" % (job_id, error.code, body))
        return {"id": job_id, "error": "queue rejected: " + body, "summary": summary}
    history = None
    while True:
        time.sleep(5)
        if SERVER.poll() is not None:
            raise RuntimeError("ComfyUI died during render:\n" + log_tail(150))
        try:
            data = api("/history/%s" % prompt_id, timeout=20)
        except Exception:
            data = {}
        if prompt_id in data:
            history = data[prompt_id]
            break
        if time.time() - started > job.get("timeout", 4200):
            say("%s TIMEOUT after %d s" % (job_id, job.get("timeout", 4200)))
            return {"id": job_id, "error": "timeout", "summary": summary}
    status = history.get("status") or {}
    files = collect_outputs(history)
    if status.get("status_str") == "error" or not files:
        say("%s RENDER ERROR %s" % (job_id, json.dumps(status)[:1500]))
        return {"id": job_id, "error": json.dumps(status)[:2000], "summary": summary}
    saved = []
    for item in files:
        src = GEN_DIR / item.get("subfolder", "") / item["filename"]
        if not src.is_file():
            continue
        dst = OUT_DIR / ("%s_%s%s" % (job_id, summary["mode"], src.suffix))
        shutil.copy2(src, dst)
        saved.append(str(dst))
    wall = round(time.time() - started, 1)
    result = {"id": job_id, "mode": summary["mode"], "wall_seconds": wall,
              "seconds_per_video_second": round(wall / summary["video_seconds"], 2),
              "build_seconds": round(started - t_build, 2), "summary": summary,
              "files": saved, "prompt": job["prompt"]}
    say("%s DONE in %.1f min (%.2f s per video second) -> %s"
        % (job_id, wall / 60.0, result["seconds_per_video_second"],
           ", ".join(os.path.basename(p) for p in saved)))
    return result


def dump_node_schema(class_type):
    """Print the real input names for a node so autogrow prefixes are confirmed, not assumed."""
    try:
        info = api("/object_info/%s" % class_type, timeout=30).get(class_type, {})
    except Exception as exc:
        say("object_info %s failed: %s" % (class_type, exc))
        return
    inp = info.get("input") or {}
    for group in ("required", "optional"):
        names = sorted((inp.get(group) or {}).keys())
        say("  %s.%s (%d): %s" % (class_type, group, len(names), ", ".join(names)))


def vae_gate():
    """Fail fast when a job names a VAE the running loader does not offer.

    A weight/commit mismatch otherwise rejects every job in about a minute
    ("VAE is invalid: None" under node vae_v, H3StudioVAELoader) and the kernel
    still reports COMPLETE, so the run looks like a code regression instead.
    """
    loader = "H3StudioVAELoader" if torch.cuda.device_count() >= 2 else "VAELoader"
    try:
        info = api("/object_info/%s" % loader, timeout=30).get(loader, {})
    except Exception as exc:
        say("VAE gate: object_info %s failed (%s) -- not blocking" % (loader, exc))
        return
    spec = (info.get("input") or {}).get("required", {}).get("vae_name") or []
    choices = list(spec[0]) if spec and isinstance(spec[0], list) else []
    say("VAE gate: %s offers %d file(s): %s" % (loader, len(choices), ", ".join(choices)))
    wanted = sorted({j.get("video_vae", VIDEO_VAE_FILE) for j in JOBS})
    missing = [n for n in wanted if n not in choices]
    if missing:
        raise RuntimeError("VAE GATE FAILED: jobs name %s, loader offers %s. Fix the weight name or the "
                           "ComfyUI pin before spending GPU time." % (", ".join(missing), ", ".join(choices)))


say("PRO probe | jobs: %d | deadline %.1f h | modes: %s"
    % (len(JOBS), DEADLINE_S / 3600.0, ", ".join(sorted({j["mode"] for j in JOBS}))))
SERVER, log_fp = start_comfy()
results = []
try:
    dump_node_schema("MiniMaxH3ReferenceToVideo")
    dump_node_schema("MiniMaxH3ImageToVideo")
    vae_gate()
    for job in JOBS:
        if time.time() - T0 > DEADLINE_S:
            say("deadline reached, skipping %s and the rest" % job["id"])
            break
        try:
            entry = render(job)
        except Exception as exc:
            say("%s CRASHED: %s" % (job["id"], exc))
            entry = {"id": job["id"], "error": "crash: %s" % exc}
        results.append(entry)
        RESULTS_PATH.write_text(json.dumps(results, indent=2), encoding="utf-8")
finally:
    if SERVER.poll() is None:
        SERVER.terminate()
        try:
            SERVER.wait(timeout=30)
        except Exception:
            SERVER.kill()
    log_fp.flush()
    try:
        shutil.copy2(LOG_FILE, OUT_DIR / "h3_comfy.log")
    except Exception:
        pass

ok = [r for r in results if r.get("files")]
bad = [r for r in results if not r.get("files")]
print("\n" + "=" * 72)
print("  PROBE RENDERED %d/%d   total wall %.1f min" % (len(ok), len(JOBS), (time.time() - T0) / 60.0))
for r in results:
    if r.get("files"):
        print("  OK   %-10s %-9s %6.1f min  %6.2f s/video-s  %s"
              % (r["id"], r["mode"], r["wall_seconds"] / 60.0, r["seconds_per_video_second"],
                 " ".join(os.path.basename(p) for p in r["files"])))
    else:
        print("  FAIL %-10s %s" % (r["id"], str(r.get("error"))[:400]))
print("=" * 72)
