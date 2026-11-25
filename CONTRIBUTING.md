# Contributing

Small codebase, one process, no build step. You can read all of it in an afternoon.

## The one rule that is not negotiable

The first-run setup is a **server-side gate**, not a splash screen. Until the licence terms and the
Kaggle terms are acknowledged and recorded in `data/setup.json`, every studio route answers
`409 {"error":"Setup is not complete."}`. That gate exists because the model licence (section V.2)
requires the operator to bind each user to protective terms *before* giving them access. A pull request
that softens it, moves it into client JavaScript, or adds a flag that bypasses it off loopback will be
closed. `H3UI_SKIP_ONBOARDING=1` is honoured only on a loopback bind for development, and even then it
is a convenience, not an exemption.

## Layout

```
server.js            HTTP server, route table, gate middleware
lib/auth.js          origin check, body caps, image magic bytes, log scrub
lib/setup.js         setup state machine, data/setup.json (atomic, 0600)
lib/kaggle-auth.js   credential probe: --config view, quota, enum results
lib/kaggle.js        the kaggle CLI as a subprocess: push, status, output, list
lib/pipeline.js      stage -> build -> push -> poll -> collect -> verify -> publish
lib/worker.js        the poller that drives a run to completion
lib/store.js         run state on disk under data/
engine/*.py *.sh     the scripts that actually build the kernel and move files
public/              the UI: no framework, no build step, vendored Swiper and GSAP
scripts/gates/       the phase gates; each one proves a claim or fails
```

## Rules

- **Node stdlib only, in the server.** No dependencies. If you need a library, that is a design
  discussion, not a PR.
- **No absolute paths.** The engine root resolves from the repo. `grep -rn '/root\|/srv' .` must be
  clean.
- **No credentials in the tree, in logs, or in responses.** The token lives at
  `$KAGGLE_HOME/access_token`, mode 0600, written atomically. If your change touches intake, add a test
  that asserts the literal token string appears in no response body.
- **Do not weaken `lib/auth.js`** — origin check on writes, 25 MB body cap, 3 MB image cap with magic
  byte check, log scrub.
- **Do not touch the pinned ComfyUI commit**, the live-kernel preflight, the quota floor, or the
  `flock` around collect. Each of those exists because of a specific failure.
- **Copy changes to the setup strings** go through the spec, not through taste. They are the mechanism
  by which the licence is acknowledged.

## Working on it

```bash
bash scripts/install.sh          # checks node/python/ffmpeg/kaggle, writes config.json
node tests/index.js              # the whole suite, no network
MOCK_KAGGLE=1 node server.js     # full UI, fake pipeline, spends no GPU quota
```

`MOCK_KAGGLE=1` is how you work on the interface. It renders a placeholder mp4 locally, banners itself
in the UI, and refuses to run on a non-loopback bind.

Spending real quota is a deliberate act: `bash engine/run_six.sh <tag> --dry-run` builds and gates the
kernel without pushing. Always dry-run first.

## Gates

Each phase has a gate that must be run and must pass before the next phase starts:

```bash
bash scripts/gate.sh P0     # tree and baseline
bash scripts/gate.sh P1     # no operator paths or names anywhere
... P6
```

`scripts/gates/_lib.sh` has the helpers. A gate prints `PASS`/`FAIL` per assertion and exits non-zero
on any failure. If you add a capability, add the assertion that proves it — a gate that cannot fail is
decoration.

## Pull requests

- One concern per PR, and say which gate it moves.
- `node tests/index.js` green, and the relevant gate green, with the output pasted.
- If you change user-visible copy, quote the before and after.
- If you change anything touching licences or the setup gate, say so in the first line of the
  description. Those get read by a human, carefully.

## Reporting security issues

Do not open a public issue for a vulnerability. Email the maintainers at the address on the
repository profile and give us a chance to fix it first.

## Licence

Contributions are accepted under the MIT licence in `LICENSE`. By opening a pull request you confirm you
have the right to contribute the code under those terms.
