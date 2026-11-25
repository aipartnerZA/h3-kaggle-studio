const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const appDir = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function request(port, method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: Object.assign({}, headers || {}, data ? {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
      } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function fakeKaggle(root) {
  const bin = path.join(root, 'fake-kaggle');
  fs.writeFileSync(bin, [
    '#!/bin/bash',
    'case "$1" in',
    '  config) echo "- username: acct"; exit 0 ;;',
    '  quota) echo "GPU 4.50h 25.50h 30.00h 2026-11-28T00:00:00+00:00"; exit 0 ;;',
    'esac',
    'exit 1',
  ].join('\n') + '\n', { mode: 0o755 });
  return bin;
}

function startServer(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appDir,
    // The suite exercises the studio, not the onboarding: bypass the gate on loopback.
    env: Object.assign({ H3UI_SKIP_ONBOARDING: '1' }, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start: ' + stderr)), 10000);
    child.stdout.on('data', (c) => {
      if (c.toString().includes('listening')) { clearTimeout(timer); resolve(child); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('server exited ' + code + ': ' + stderr)); });
  });
}

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]).toString('base64');

test('HTTP surface: health, state, validation, dedupe, busy, files and logs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-a-'));
  const fakeBin = fakeKaggle(root);
  const port = await freePort();
  const child = await startServer({
    H3UI_CONFIG: path.join(root, 'config.json'),
    H3UI_BASE: root,
    H3UI_PORT: String(port),
    H3UI_KAGGLE_BIN: fakeBin,
    H3UI_NO_WORKER: '1',
  });
  t.after(() => child.kill('SIGTERM'));

  const origin = { Origin: 'http://127.0.0.1:' + port };

  let r = await request(port, 'GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);

  r = await request(port, 'GET', '/api/state');
  assert.equal(r.status, 200);
  const board = JSON.parse(r.body);
  assert.equal(board.config.seconds_min, 6);
  assert.equal(board.config.seconds_max, 15);
  assert.equal(board.quota.gpu_remaining_h, 25.5);

  // Default prefix is "/" and the page carries no /h3 URL.
  r = await request(port, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /<meta name="h3-prefix" content="">/);
  assert.match(r.body, /src="\/assets\/app\.js"/);
  assert.ok(!r.body.includes('/h3/assets/'));

  const payload = {
    submission_id: 'test-sub-1', note: 'api test',
    slots: [{ n: 1, prompt: 'a calm lake', seconds: 6, image_base64: jpeg, image_name: 'lake.jpg' }],
  };
  r = await request(port, 'POST', '/api/submissions', payload, origin);
  assert.equal(r.status, 201);
  const created = JSON.parse(r.body);
  assert.match(created.tag, /^ui-\d{8}-[0-9a-f]{4}$/);
  assert.equal(created.estimate.frames, 158);
  assert.equal(created.phase, 'QUEUED');
  assert.ok(fs.existsSync(path.join(root, 'data', 'runs', created.tag, 'images')));

  // Same submission id is an idempotent retry; a different one is refused while busy.
  r = await request(port, 'POST', '/api/submissions', payload, origin);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).tag, created.tag);
  r = await request(port, 'POST', '/api/submissions',
    Object.assign({}, payload, { submission_id: 'test-sub-2' }), origin);
  assert.equal(r.status, 409);
  assert.equal(JSON.parse(r.body).error, 'A render is already running. Wait for it to finish, then submit again.');

  // Origin guard.
  r = await request(port, 'POST', '/api/submissions', payload, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);

  // Validation strings are exact (§8.2) and run before the busy check.
  r = await request(port, 'POST', '/api/submissions', {
    submission_id: 'x1', slots: [{ n: 1, prompt: 'x', seconds: 5 }],
  }, origin);
  assert.equal(r.status, 422);
  assert.equal(JSON.parse(r.body).error, 'Seconds must be a whole number from 6 to 15 for slot 1.');
  r = await request(port, 'POST', '/api/submissions', {
    submission_id: 'x2', slots: [{ n: 1, prompt: '  ', seconds: 6 }],
  }, origin);
  assert.equal(JSON.parse(r.body).error, 'Prompt is required for slot 1.');
  r = await request(port, 'POST', '/api/submissions', {
    submission_id: 'x3', slots: [{ n: 1, prompt: 'x', seconds: 6, image_base64: Buffer.from('not an image').toString('base64') }],
  }, origin);
  assert.equal(JSON.parse(r.body).error, 'Slot 1: only JPG, PNG or WEBP images are accepted.');

  // A fixture DONE run exercises the merged run view and the authenticated file route.
  const tag = 'ui-fixture';
  const runDir = path.join(root, 'data', 'runs', tag);
  fs.mkdirSync(path.join(runDir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'request.json'), JSON.stringify({
    tag, submitted_at: '2026-11-25T10:00:00Z', submission_id: 'fix',
    slots: [{ n: 1, id: 's1_scene', prompt: 'lake', seconds: 6 }],
  }));
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
    tag, phase: 'DONE', slots: [{ n: 1, id: 's1_scene', seconds: 6, frames: 158,
      result: 'ok', file: 's1_scene_vdn.mp4', sheet: null }], totals: { ok: 1, failed: 0 },
  }));
  fs.writeFileSync(path.join(runDir, 'out', 's1_scene_vdn.mp4'), '0123456789');
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'logs', 'push.log'), 'PREFLIGHT FAIL: no\n' + 'x'.repeat(60) + '\n');

  r = await request(port, 'GET', '/api/runs/' + tag);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).slots[0].prompt, 'lake');

  r = await request(port, 'GET', '/api/runs/' + tag + '/files/s1_scene_vdn.mp4');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-disposition'], /attachment/);
  assert.equal(r.headers['content-type'], 'video/mp4');
  assert.equal(r.body, '0123456789');

  r = await request(port, 'GET', '/api/runs/' + tag + '/files/s1_scene_vdn.mp4', null, { Range: 'bytes=2-5' });
  assert.equal(r.status, 206);
  assert.equal(r.body, '2345');
  assert.equal(r.headers['content-range'], 'bytes 2-5/10');

  r = await request(port, 'GET', '/api/runs/' + tag + '/files/secret.txt');
  assert.equal(r.status, 404);

  r = await request(port, 'GET', '/api/runs/' + tag + '/log?which=push');
  assert.equal(r.status, 200);
  assert.ok(!r.body.includes('x'.repeat(60)), 'long tokens are scrubbed');

  r = await request(port, 'POST', '/api/runs/' + tag + '/delete', {}, origin);
  assert.equal(r.status, 200);
  assert.equal(fs.existsSync(runDir), false);
});

test('H3UI_PREFIX=/h3 mounts the whole app under the old prefix', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-b-'));
  const fakeBin = fakeKaggle(root);
  const port = await freePort();
  const child = await startServer({
    H3UI_CONFIG: path.join(root, 'config.json'),
    H3UI_BASE: root,
    H3UI_PORT: String(port),
    H3UI_PREFIX: '/h3',
    H3UI_KAGGLE_BIN: fakeBin,
    H3UI_NO_WORKER: '1',
  });
  t.after(() => child.kill('SIGTERM'));

  let r = await request(port, 'GET', '/h3/api/health');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);

  r = await request(port, 'GET', '/api/health');
  assert.equal(r.status, 404);

  r = await request(port, 'GET', '/h3/');
  assert.equal(r.status, 200);
  assert.match(r.body, /<meta name="h3-prefix" content="\/h3">/);
  assert.match(r.body, /src="\/h3\/assets\/app\.js"/);

  r = await request(port, 'GET', '/h3/assets/app.js');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /javascript/);
});

test('server fails at boot when the kaggle CLI cannot be executed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-boot-'));
  const r = spawnSync(process.execPath, ['server.js'], {
    cwd: appDir,
    env: Object.assign({}, process.env, {
      H3UI_CONFIG: path.join(root, 'config.json'),
      H3UI_BASE: root,
      H3UI_KAGGLE_BIN: path.join(root, 'missing-kaggle'),
      H3UI_NO_WORKER: '1',
    }),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pip install kaggle/);
  assert.match(r.stderr, /uv tool install kaggle/);
});

// ---- The truth on a page load, and stopping a run ---------------------------

function fakeKaggleControl(root, opts) {
  const o = opts || {};
  const bin = path.join(root, 'fake-kaggle-control');
  const status = o.status === 'gone'
    ? 'echo "404 Client Error: Not Found for url: https://api.kaggle.com/v1/kernels/sessions" >&2; exit 1'
    : 'echo "acct/h3-six-x has status \\"KernelWorkerStatus.QUEUED\\""; exit 0';
  const del = o.delete === 'refuse'
    ? 'echo "403 Client Error: Forbidden for url: https://api.kaggle.com" >&2; exit 1'
    : 'echo "Kernel $3 deleted successfully"; exit 0';
  fs.writeFileSync(bin, [
    '#!/bin/bash',
    'case "$1" in',
    '  config) echo "- username: acct"; exit 0 ;;',
    '  quota) echo "GPU 4.50h 25.50h 30.00h 2026-11-28T00:00:00+00:00"; exit 0 ;;',
    '  kernels)',
    '    case "$2" in',
    '      status) ' + status + ' ;;',
    '      delete) ' + del + ' ;;',
    '    esac',
    '    exit 1 ;;',
    'esac',
    'exit 1',
  ].join('\n') + '\n', { mode: 0o755 });
  return bin;
}

function writeLiveRun(root, tag, fields) {
  const runDir = path.join(root, 'data', 'runs', tag);
  fs.mkdirSync(path.join(runDir, 'out'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'request.json'), JSON.stringify({
    tag, submitted_at: '2026-11-25T10:00:00Z', submission_id: 'live',
    slots: [{ n: 1, id: 's1_scene', prompt: 'a calm lake', seconds: 6, seed: 813001 }],
  }));
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(Object.assign({
    tag,
    phase: 'RENDERING',
    phase_since: new Date(Date.now() - 5 * 60000).toISOString(),
    submitted_at: '2026-11-25T10:00:00Z',
    pushed_at: new Date(Date.now() - 10 * 60000).toISOString(),
    kernel_ref: 'acct/h3-six-' + tag,
    kaggle_status: 'RUNNING',
    kaggle_status_at: new Date(Date.now() - 3 * 60000).toISOString(),
    status_stale: false,
    slots: [{ n: 1, id: 's1_scene', seconds: 6, frames: 158, result: 'pending' }],
    totals: { ok: 0, failed: 0 },
    error: null,
    log_tail: [],
  }, fields || {})));
  fs.writeFileSync(path.join(root, 'data', 'active.json'), JSON.stringify({
    tag, since: new Date().toISOString(),
  }));
}

async function withControlServer(t, opts, ready) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-c-'));
  const bin = fakeKaggleControl(root, opts);
  const port = await freePort();
  const child = await startServer({
    H3UI_CONFIG: path.join(root, 'config.json'),
    H3UI_BASE: root,
    H3UI_PORT: String(port),
    H3UI_KAGGLE_BIN: bin,
    H3UI_NO_WORKER: '1',
  });
  t.after(() => child.kill('SIGTERM'));
  return ready({ root, port, origin: { Origin: 'http://127.0.0.1:' + port } });
}

test('a kernel deleted at Kaggle stops claiming a render, on the load itself', async (t) => {
  await withControlServer(t, { status: 'gone' }, async ({ root, port }) => {
    const tag = 'ui-gone-1';
    writeLiveRun(root, tag);

    let r = await request(port, 'GET', '/api/state');
    assert.equal(r.status, 200);
    let board = JSON.parse(r.body);
    assert.equal(board.active, null, 'the run is over, so nothing is active');
    const run = board.runs.find((x) => x.tag === tag);
    assert.equal(run.phase, 'FAILED');
    assert.match(run.error, /gone from Kaggle/);

    r = await request(port, 'GET', '/');
    const banner = (r.body.match(/<div id="status-banner"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
    assert.ok(!/RENDER IN PROGRESS/.test(banner), 'the banner must not claim a render');
    assert.match(banner, /Last run FAILED/);
    assert.match(r.body, /gone from Kaggle/, 'the reason travels with the page state');
  });
});

test('a live run keeps its phase when Kaggle still reports it', async (t) => {
  await withControlServer(t, {}, async ({ root, port }) => {
    const tag = 'ui-live-1';
    writeLiveRun(root, tag);
    const r = await request(port, 'GET', '/api/state');
    const board = JSON.parse(r.body);
    assert.equal(board.active.tag, tag);
    assert.equal(board.active.phase, 'GPU_QUEUED', 'the fresher Kaggle answer wins');
    assert.equal(board.active.status_stale, false);
  });
});

test('cancel deletes the Kaggle kernel and closes the run', async (t) => {
  await withControlServer(t, {}, async ({ root, port, origin }) => {
    const tag = 'ui-cancel-1';
    writeLiveRun(root, tag, { kaggle_status_at: new Date().toISOString() });
    let r = await request(port, 'GET', '/api/state');
    assert.equal(JSON.parse(r.body).active.tag, tag);

    r = await request(port, 'POST', '/api/runs/' + tag + '/cancel', {}, origin);
    assert.equal(r.status, 200);
    const out = JSON.parse(r.body);
    assert.equal(out.phase, 'CANCELLED');
    assert.equal(out.remote.ok, true);

    r = await request(port, 'GET', '/api/state');
    const board = JSON.parse(r.body);
    assert.equal(board.active, null);
    assert.equal(board.runs.find((x) => x.tag === tag).phase, 'CANCELLED');
  });
});

test('a cancel Kaggle refuses is refused here too, with the reason', async (t) => {
  await withControlServer(t, { delete: 'refuse' }, async ({ root, port, origin }) => {
    const tag = 'ui-cancel-2';
    writeLiveRun(root, tag, { kaggle_status_at: new Date().toISOString() });

    const r = await request(port, 'POST', '/api/runs/' + tag + '/cancel', {}, origin);
    assert.equal(r.status, 409);
    const body = JSON.parse(r.body);
    assert.match(body.error, /Kaggle would not delete acct\/h3-six-ui-cancel-2/);
    assert.match(body.error, /403 Client Error/);

    const state = JSON.parse(fs.readFileSync(
      path.join(root, 'data', 'runs', tag, 'state.json'), 'utf8'));
    assert.equal(state.phase, 'RENDERING', 'the job is still running, so the run is still live');
  });
});
