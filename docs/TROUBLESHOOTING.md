# Troubleshooting

The app fails loudly and in specific ways on purpose. Find your symptom, do the one thing it says.

## Setup and credentials

**`kaggle config view` exits 1 straight after pasting a token**
Older Kaggle CLI, or the token got a trailing newline when it was copied. This app strips whitespace
before writing; if the CLI is below 2.0 it does not read `access_token` at all and the panel says so.
Fix: `pip install --upgrade kaggle` (or `uv tool install kaggle`), then `bash scripts/install.sh`.

**Verify says the token did not work**
Kaggle answered "authentication required", which is also what it answers when there is no token. The
token is incomplete (Kaggle shows it once, and it is long), or it was revoked when you generated a new
one. Go to kaggle.com/settings/api and copy the whole thing again.

**Verify says 403**
That is phone or identity verification, not the token. Finish it at kaggle.com/settings, then press
Verify. Retrying does nothing until then; the panel stops polling on purpose.

**Quota shows zero GPU hours**
A new account sometimes has a token that works but no GPU entitlement yet. The studio stays unlocked
and warns once on Submit. Check `kaggle quota`; the weekly allowance is 30 hours and resets weekly.

**"Could not reach Kaggle"**
DNS or egress. `curl -sS https://www.kaggle.com/api/v1/hello` from the same shell the server runs in.
Behind a proxy, set `HTTPS_PROXY` in the service environment, not in the browser.

## Renders

**Kernel ERRORs within a minute, at `vae_v`**
The ComfyUI commit pin is missing or was relaxed. The int8 VAE only builds on the pinned commit. Do not
edit the pin; re-pull the repo.

**Push fails with 400 / "SaveKernel" and the script is around 1 MB**
Too many shots with inlined start images. Each image is base64'd into the kernel script. Keep the batch
at 6 and prep images smaller; the preflight refuses above ~800 KB of base64 for this reason.

**"a six-shot kernel is still live"**
One run at a time per account. `kaggle kernels list -m --user=<you>` shows what is running; cancel it or
wait. Two live kernels also means two GPU sessions counted against one quota.

**I deleted the kernel at kaggle.com — the page still said RENDER IN PROGRESS**
It should not, and now it does not: every page load and `/api/state` re-reads Kaggle when the last
status is older than 10 s. A `404` from `kaggle kernels status` closes the run as `FAILED` with
"`<ref>` is gone from Kaggle". If the page still insists, check `data/runs/<tag>/state.json`:
`pushed_at` older than 3 minutes plus a `404` is what triggers it. A `401`/`5xx`/network failure is a
different answer and keeps the run live for up to 30 minutes, because "cannot read" is not "gone".

**How do I stop a render?**
Open the run panel and use the quiet "Stop this render…" link at the bottom of it. Type the run tag in
the box; the button stays disabled until it matches. Past the push, the studio deletes the Kaggle
kernel (that is the only stop Kaggle offers) and says so before you confirm. If Kaggle refuses the
delete, the run stays live and the refusal is shown — delete it at `kaggle.com/code/<ref>` instead,
and the page follows within a minute.

**Still QUEUED after 20 minutes**
Kaggle's GPU queue, not a fault. It will run. The watcher keeps polling with backoff.

**Kernel COMPLETE but nothing arrived**
`kaggle kernels output <user>/<kernel> -p data/runs/<tag>/out` by hand — that is exactly what the
collector does. If it is empty, the kernel wrote outside `/kaggle/working`.

**`ffmpeg: not found`**
`bash scripts/install.sh` prints the exact apt/brew line. It exits 2 rather than continuing, because a
missing ffmpeg produces silent, empty audio.

**A render finished but the file has no AI-generation metadata**
Check `ffprobe -v quiet -print_format json -show_format data/runs/<tag>/out/*.mp4 | grep comment`. If it
is absent the publish step was bypassed — a file copied straight out of `/kaggle/working` will not have
it. The licence requires the identifier, so re-publish through the app.

## Running it

**Port already in use**
`H3UI_PORT=8810 node server.js`.

**Studio returns 409 with a state name**
That is the gate working. Open `/` and finish setup, or check `GET /api/setup` for which step is
outstanding.

**`H3UI_SKIP_ONBOARDING=1` is ignored**
It only applies on a loopback bind. On `0.0.0.0` it is deliberately ignored and a warning is logged
once at boot — the model licence requires binding each user before access, and a remote bind means
someone other than you can reach it. Skipping the setup also does not skip your obligations.

**Nothing happens in mock mode**
`MOCK_KAGGLE=1` renders a placeholder mp4 locally and never contacts Kaggle. It is loopback-only, it is
bannered in the UI, and it is for working on the interface without spending quota.

**403 when I press Continue on the terms**
Every write is checked twice, and either check passing is enough:

1. **The page token.** The gate (and the studio) is rendered with a random token for that server run;
the page posts it back in `X-Setup-CSRF`, and the server compares it to its own. Only a page this
server rendered can read the token, and a page on another site cannot set that header (there is no
CORS approval here, so the browser refuses the preflight). This is what makes the studio work behind
a proxy that rewrites `Host` — a case where the `Origin` header can never match the `Host` header.
A token from a previous run is refused; reload the page.
2. **Same-origin.** With no token (a deliberate `curl`), the `Origin` must name the address you
reached the studio on. `127.0.0.1`, `localhost`, `[::1]`, a LAN IP and a hostname you browsed are all
accepted: the check compares `Origin` against `Host` and any `X-Forwarded-Host`, plus
`X-Forwarded-Proto`. Ports are compared only when they are knowable — a proxy that terminates TLS
but forwards no proto is treated as host-equal. An `allowed_origins` entry in `config.json` always
wins. The panel prints the exact origin and host the server saw, so read that line before changing
anything.

A missing `Origin` header with no token is refused — nothing but a non-browser client omits both.

**`/favicon.ico` returned 409 in the console**
That was the setup gate answering a request the browser makes unprompted. It now returns 204, and the
pages carry an inline icon, so nothing is requested at all.

**Behind nginx**
Set `H3UI_PREFIX=/h3`, proxy `/h3/` to `127.0.0.1:8804`, and keep `proxy_set_header Host $host` and
`X-Forwarded-Proto $scheme`: with those the origin check passes as-is. If your config rewrites `Host`,
add your public origin to `allowed_origins` in `config.json` — writes are origin-checked and will 403
otherwise. WebSocket is not used; long polls are plain HTTP. Put basic auth or mTLS in front; the app
has no login of its own. Note that same-origin checks do not stop DNS rebinding — the defence there is
that the studio binds loopback by default and, when exposed, sits behind a proxy that authenticates.

## Legal, not technical

**"I am in the EU / UK / South Korea / USA"**
The app will not render for you. The model licence excludes those territories and its section V.4 also
covers the outputs. Request a licence from MiniMax first. This is not a bug and there is no flag.

**"Can I render client work on the free GPU?"**
Kaggle's Terms of Use say free compute is for your own internal, personal, non-commercial use, not on
behalf of a third party. The studio states this and records that you read it. It cannot audit you.
`docs/COMPLIANCE.md` quotes the clause.
