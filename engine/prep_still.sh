#!/bin/bash
# prep_still.sh IN OUT [targetKB]
set -euo pipefail
IN="$1"; OUT="$2"; TARGET="${3:-80}"
W=736; H=416
cp "$IN" /tmp/_s.png 2>/dev/null || true
# scale to fill 16:9 then centre-crop, so no letterboxing
ffmpeg -v error -y -i "$IN" -vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},unsharp=5:5:0.6:5:5:0.0" -q:v 3 "$OUT"
sz=$(stat -c%s "$OUT")
if [ "$sz" -gt $((TARGET*1024)) ]; then
  for q in 5 7 9 12 15 18 22; do
    ffmpeg -v error -y -i "$IN" -vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},unsharp=5:5:0.6:5:5:0.0" -q:v $q "$OUT"
    sz=$(stat -c%s "$OUT"); [ "$sz" -le $((TARGET*1024)) ] && break
  done
fi
b64=$(( (sz+2)/3*4 ))
echo "$(basename "$OUT"): $(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$OUT") $((sz/1024))KB jpg -> $((b64/1024))KB base64"
