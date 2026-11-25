# Architecture

One Node process, one browser tab, one Kaggle kernel at a time.

```
browser ──HTTP──> server.js ──> lib/worker.js ──> lib/pipeline.js ──> engine/*.sh,*.py
                     │                │                  │                    │
                  lib/auth.js    lib/store.js       lib/kaggle.js        kaggle CLI
                     │                │                  │                    │
                 origin/body/     data/runs/<tag>/     subprocess         Kaggle API
                 image/scrub       logs, state         wrapper            GPU kernel
```

No framework, no build step, no npm dependencies. `node server.js` is the whole runtime. State lives on
disk under `data/`, so a restart does not lose a run in flight — the worker re-adopts it.

## The render pipeline, in execution order

| stage | who | what it does | what it refuses |
|---|---|---|---|
| **stage** | `lib/pipeline.js::stage`, `engine/stage_shot.py`, `engine/prep_still.sh` | writes `data/runs/<tag>/jobs.json`, normalises each start image into `data/runs/<tag>/images/` | more than 6 slots, a duration outside 6–15 s, an image over 3 MB or not a real image (magic bytes), an empty prompt, more than 2000 characters |
| **build** | `engine/build_pro.py` | assembles `engine/kernel_<tag>/h3-pro.py` and `kernel-metadata.json` from the workflow template, inlining prompts and base64 images | a script over the ~1 MB push ceiling, a batch with more than 8 jobs, more base64 than fits |
| **gate** | `engine/run_six.sh` (preflight) | checks the built script: ComfyUI commit pin present, every job id present, every VAE referenced, metadata says T4 and GPU on, image constants match distinct images | a missing pin, a stale live kernel, less than the quota floor (this run needs ~2.2 h) |
| **push** | `lib/kaggle.js::push`, `engine/run_six.sh` | `kaggle kernels push -p kernel_<tag>` | a push that does not report success |
| **poll** | `lib/worker.js::step`, `lib/kaggle.js::status` | `kaggle kernels status` with backoff (busy 20 s, idle 60 s), maps the status to a phase | more than one live kernel; a run that is terminal is closed, not retried |
| **collect** | `lib/pipeline.js::collect`, `engine/collect_run.sh` | `kaggle kernels output` into `data/runs/<tag>/raw/`, under a `flock` so two workers cannot collect into one directory | a second concurrent collect on the same tag |
| **verify** | `engine/verify_run.py` | `ffprobe` on each output: duration, codec, frame count, audio stream | a file that fails the expected shape |
| **publish** | `lib/pipeline.js::publish` | moves the verified files into `data/runs/<tag>/out/`, rewrites the mp4 metadata with the AI-generation identifier, writes `done` | publishing twice from the same tag |

## The first-run gate

Before anything is rendered, `lib/setup.js` owns the state machine and `server.js` enforces it ahead of
the route table:

```
new ──terms read to the end, then Continue──> licence_ok ──probe ok──> ready
 │                                                  │
 └──declares an excluded territory──> territory_blocked   └──probe fails──> token_rejected | forbidden
                                                                       | quota_empty | unreachable
                                                                       | old_cli
```

`data/setup.json` records the licence version, the timestamps and the last probe enum — never the token.
The token is written by `lib/kaggle-auth.js` to `$KAGGLE_HOME/access_token`, 0600, inside a 0700
directory, via a temp file and `rename`. Nothing reads it back out: the probe only asks the CLI.

While the state is not `ready`, every route except `/`, `/assets/*`, `/api/setup*` and
`/api/health` answers `409`. This is the licence's requirement (section V.2), so it is server-side and
it is not a splash screen.

## The probe

`lib/kaggle-auth.js` runs three commands, in order, with a 60 s timeout and an injectable runner so
tests never touch the network:

1. `kaggle --version` — below 2.0 is `old_cli`, because those versions cannot read `access_token`.
2. `kaggle config view` — exit 0 and a parsed `- username:` means a credential exists.
3. `kaggle quota` — a GPU row means the account has entitlement; a 403 means phone verification is
   outstanding, which is reported as its own state, not as "invalid token".

A wrong token and a missing token are indistinguishable to the CLI (both fall through to
"Authentication required"), so the UI says exactly that rather than pretending to know more.

## Where state lives

```
data/
├── setup.json                     first-run state machine (0600, no token)
├── active.json                    the run the worker is currently driving
├── logs/                          server + worker logs
└── runs/<tag>/
    ├── jobs.json                  the submitted shot list (as accepted)
    ├── images/                    normalised start images
    ├── raw/                       kernel output as downloaded
    ├── out/                       published, metadata-stamped files served to the browser
    ├── logs/                      stage, build, push, poll, collect logs
    └── done                       written once, after a successful publish
```

`data/` is gitignored. `engine/kernel_<tag>/` is the build output and is also gitignored.

## Guardrails, and why each exists

| guard | where | the failure it prevents |
|---|---|---|
| origin check on every write | `lib/auth.js` | a page on another origin driving your Kaggle account through your loopback server |
| body cap 25 MB, image cap 3 MB, magic bytes | `lib/auth.js` | a renamed 40 MB file discovering the limit inside the kernel, after a push |
| kernel script ceiling | `engine/run_six.sh` | Kaggle's ~1 MB `SaveKernel` limit, hit after the GPU is queued |
| `COMFYUI_COMMIT` pin | `engine/run_six.sh`, template | the int8 VAE failing at `vae_v` a minute into a run on a moved ComfyUI |
| live-kernel preflight | `engine/run_six.sh` | two kernels running at once: two GPU sessions, one quota, 409s on push |
| quota floor | `engine/run_six.sh` | starting a 2.2 h run with 1 h left, which dies at 90 minutes |
| `flock` around collect | `engine/collect_run.sh` | two collectors writing the same `out/` directory |
| log scrub | `lib/auth.js` | a token in a log file that gets pasted into an issue |
| `no-store` | `server.js` | a render URL surviving in a shared browser cache |

## What is deliberately not here

No database (JSON files are enough for one operator), no queue beyond one active run, no auth of its
own (bind to loopback; put a proxy in front if you need remote access), no multi-user, no weights.
