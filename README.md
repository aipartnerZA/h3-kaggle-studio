# h3-kaggle-studio

A self-hosted web studio that renders short AI video on a **free Kaggle GPU** using
**ComfyUI + MiniMax H3**, and keeps the results on your own machine.

You give it a shot list — up to 6 shots, 6 to 15 seconds each — and it submits a Kaggle kernel that
loads the model, runs your shots, and hands back the finished mp4. A run takes roughly 2 hours of
wall time and a couple of GPU-hours out of your own weekly Kaggle quota.

No accounts with us. No cloud storage. No API key of ours. It talks to Kaggle with *your* Kaggle
credentials and nothing else.

---

## Read this before you install

Three separate things are licensed differently, and two of them will bite you if you skip them.

**1. This code is MIT.** Fork it, sell it, host it, change it. See `LICENSE`.

**2. The video model is not open source.** MiniMax H3 ships under the
[MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE)
(2 August 2026). It is usable royalty-free, including commercially, **only inside the Applicable
Territory** — worldwide excluding the **European Union, the United Kingdom, South Korea and the
United States**. Section V.4 says the model *and the videos it makes* may not be used, reproduced or
displayed outside that territory. Above USD 20 million a year in revenue you need MiniMax's written
authorisation. If you are in an excluded territory, request a licence from MiniMax before you render
anything. This repository ships **no model weights** — the Kaggle kernel fetches them.

**3. Kaggle's free GPU is for personal, non-commercial use.** Kaggle's Terms of Use limit free
compute to *"your own internal, personal, non-commercial use, and not on behalf of or for the benefit
of any third party"*, and its Acceptable Use Policy bans server farming. Rendering paid client work on
Kaggle's free GPU breaks that term; Kaggle's stated consequence is termination of your account. If you
are rendering commercially, use a paid GPU or ask Kaggle for written permission. This tool cannot check
how you earn, so it tells you plainly in the setup and records that you read it.

The setup screens make you acknowledge all of the above — they are not a formality and they are not
skippable in the browser only. The server refuses to expose the studio until they are recorded.

---

## Requirements

| thing | version | why |
|---|---|---|
| Node.js | 22 or newer | the server, no npm dependencies |
| Python | 3.9+ | the engine scripts, and the Kaggle CLI |
| ffmpeg / ffprobe | any recent | post-processing and verification |
| Kaggle CLI | 2.0 or newer | token auth and kernel pushes |
| A Kaggle account | — | with **phone verification done**, or no GPU |

`bash scripts/install.sh` checks all five, tells you the exact command for anything missing, creates
`config.json` from the example, and makes `data/`. It does not install anything for you.

Linux and macOS are the tested platforms. Windows is untested — WSL2 is the sane route if you need it.

---

## Quickstart

```bash
git clone https://github.com/aipartnerZA/h3-kaggle-studio.git
cd h3-kaggle-studio
bash scripts/install.sh
node server.js
```

Open **http://127.0.0.1:8804** and follow the setup. Six screens: what this is, the model licence, the
Kaggle rules, how to get your token, where to paste it, and then you are in.

### Where the Kaggle token goes

You do not edit any file. The setup screen asks for the token and writes it itself to:

```
~/.kaggle/access_token      (mode 0600)
```

That is the file the Kaggle CLI 2.0+ reads. It is never echoed back, never logged, and never stored in
this repository. The setup screen never asks for your password.

Getting the token: sign in at [kaggle.com](https://www.kaggle.com/account/login) → settings →
**API** → *Generate New Token*. Copy the whole string; Kaggle shows it once. If you already have a
`kaggle.json` file, the setup has a drop zone for that instead.

If you would rather do it by hand, either of these works and the setup will detect it:

```bash
export KAGGLE_API_TOKEN=...                 # or a path to a file containing it
mkdir -p ~/.kaggle && printf '%s' "$TOKEN" > ~/.kaggle/access_token && chmod 600 ~/.kaggle/access_token
```

A token is only accepted once Kaggle itself answers: setup runs `kaggle config view` for the username
and `kaggle quota` for your remaining GPU hours. A wrong token and a missing token look identical to
the CLI, so the panel reports the difference it *can* prove — `authentication required`, `403 phone
verification`, `no GPU quota`, `cannot reach Kaggle` — with the fix for each.

---

## How a render runs

```
shot list + images
   │
   ├─ stage_shot.py      normalise stills, enforce size and duration limits
   ├─ run_six.sh         build the kernel: ComfyUI pinned, H3 workflow inlined
   ├─ kaggle kernels push
   ├─ kaggle kernels status     (poll until complete, with backoff)
   ├─ collect_run.sh     download outputs to data/runs/<tag>/out/
   ├─ verify_run.py      ffprobe checks: duration, codec, audio, frame count
   └─ publish            mp4 + AI-generation metadata into the run directory
```

Everything happens locally except the kernel itself. `docs/ARCHITECTURE.md` has the detail and
`docs/TROUBLESHOOTING.md` has the failure modes worth knowing before your first push.

### Cost, honestly

One run of up to 6 shots is about **2 hours** of wall time and roughly **2 to 4 GPU-hours** from your
weekly 30-hour Kaggle GPU allowance (resets weekly). The setup shows your balance before you commit.

---

## Configuration

`config.json` is optional — every key has a default and is overridable by environment variable, which
is what container users want. `config.example.json` documents every key. The ones that matter:

| env | default | meaning |
|---|---|---|
| `H3UI_PORT` | `8804` | port |
| `H3UI_BIND` | `127.0.0.1` | bind address — loopback by default, on purpose |
| `H3UI_PREFIX` | `/` | mount under a subpath, e.g. `/h3` behind a reverse proxy |
| `H3UI_KAGGLE_BIN` | `kaggle` on `PATH` | the CLI binary |
| `H3UI_KAGGLE_HOME` | `~/.kaggle` | where the token is written |
| `H3UI_SKIP_ONBOARDING` | unset | `1` skips setup **only on a loopback bind**, for development |
| `MOCK_KAGGLE` | unset | `1` serves the whole UI with a fake pipeline; nothing reaches Kaggle. Loopback only |

There is no built-in login. One operator, one machine, bound to loopback. If you need remote access,
put it behind a reverse proxy with TLS and authentication — nginx basic auth is enough, and the app
already sets `no-store` and an origin check on every write.

---

## Contributing

Issues and pull requests are welcome. `CONTRIBUTING.md` covers the layout, the no-dependencies rule and
how the gate scripts work. The short version: `node tests/index.js` must stay green, `MOCK_KAGGLE=1` is
how you exercise the UI without spending GPU quota, and the licence-compliance code paths are not
negotiable — a PR that softens the setup gate will be rejected.

---

## Attribution

Powered by MiniMax H3. Not affiliated with Kaggle or MiniMax.

Every rendered file carries an AI-generation identifier in its metadata, as the model licence asks.

## Licence

MIT — see `LICENSE`. Third-party notices, including the full obligations that attach to the model, are
in `NOTICE` and `docs/COMPLIANCE.md`.
