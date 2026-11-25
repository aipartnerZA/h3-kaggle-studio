"""Verify rendered H3 clips: geometry, rate, frames, audio, loudness, contact sheet.

Usage: python3 tools/verify_run.py <dir-or-files...>
Writes <clip>_sheet.png next to each clip and prints one row per clip.
"""
import json
import os
import subprocess
import sys


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format",
                          "-show_streams", path], capture_output=True, text=True).stdout
    return json.loads(out or "{}")


def volume(path):
    out = subprocess.run(["ffmpeg", "-hide_banner", "-i", path, "-af", "volumedetect",
                          "-f", "null", "-"], capture_output=True, text=True).stderr
    mean = max_db = None
    for line in out.splitlines():
        if "mean_volume:" in line:
            mean = line.split("mean_volume:")[1].strip()
        if "max_volume:" in line:
            max_db = line.split("max_volume:")[1].strip()
    return mean, max_db


def sheet(path, frames=4):
    info = probe(path)
    v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    if not v:
        return None
    n = int(v.get("nb_frames") or 0)
    picks = [0, n // 3, (2 * n) // 3, max(0, n - 5)]
    expr = "+".join("eq(n\\,%d)" % f for f in picks)
    out = os.path.splitext(path)[0] + "_sheet.png"
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-vf",
           "select='%s',scale=368:-2,tile=2x2" % expr, "-frames:v", "1", out]
    subprocess.run(cmd, capture_output=True)
    return out if os.path.isfile(out) else None


def main():
    targets = []
    for a in sys.argv[1:]:
        if os.path.isdir(a):
            targets += [os.path.join(a, f) for f in sorted(os.listdir(a)) if f.endswith(".mp4")]
        else:
            targets.append(a)
    print("%-34s %-10s %5s %7s %8s  %-22s %-9s %s" %
          ("file", "geometry", "fps", "frames", "seconds", "audio", "mean/max dB", "sheet"))
    for path in targets:
        info = probe(path)
        v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
        a = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), {})
        num, den = (v.get("r_frame_rate") or "0/1").split("/")
        fps = float(num) / float(den or 1)
        frames = v.get("nb_frames") or "?"
        dur = float((info.get("format") or {}).get("duration") or 0)
        audio = "%s %sHz %sch" % (a.get("codec_name"), a.get("sample_rate"), a.get("channels")) if a else "NONE"
        mean, max_db = volume(path) if a else ("-", "-")
        sh = sheet(path)
        print("%-34s %-10s %5.1f %7s %8.3f  %-22s %-9s %s" %
              (os.path.basename(path), "%sx%s" % (v.get("width"), v.get("height")), fps, frames, dur,
               audio, "%s/%s" % (mean, max_db), os.path.basename(sh) if sh else "FAILED"))


if __name__ == "__main__":
    main()
