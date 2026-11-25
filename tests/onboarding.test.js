const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const appDir = path.resolve(__dirname, '..');
const GATE_COPY = 'By continuing, you agree to the Terms and Conditions listed below:';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
      // Every write is same-origin only; the panel posts from the page it was served on.
      headers.Origin = `http://127.0.0.1:${port}`;
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Nothing injected: the caller says exactly what a browser would send (Origin, Host, proto).
function rawRequest(port, method, pathname, body, extra) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = Object.assign({}, extra || {});
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function startGated(env) {
  // No H3UI_SKIP_ONBOARDING here: this suite is about the gate itself.
  // Keep the credential home inside the fixture: a token write must never touch this machine's ~/.kaggle.
  const khome = env.H3UI_KAGGLE_HOME || path.join(env.H3UI_BASE || os.tmpdir(), 'kh');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appDir,
    env: Object.assign({
      MOCK_KAGGLE: '1', H3UI_NO_WORKER: '1', H3UI_BIND: '127.0.0.1', H3UI_KAGGLE_HOME: khome,
    }, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start: ' + stderr)), 15000);
    child.stdout.on('data', (c) => {
      if (c.toString().includes('listening')) { clearTimeout(timer); resolve(child); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('server exited ' + code + ': ' + stderr)); });
  });
}

test('the setup page carries one terms gate, and the button starts disabled', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-ob-'));
  const port = await freePort();
  const child = await startGated({ H3UI_PORT: String(port), H3UI_BASE: root });
  t.after(() => child.kill());

  const page = await request(port, 'GET', '/');
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(GATE_COPY), 'the agreement sentence is not in the served page');
  assert.match(page.body, /id="ob-continue"[^>]*disabled/, 'the continue button is not disabled in the markup');
  assert.match(page.body, /id="ob-terms"/, 'there is no scrollable terms box');
  assert.match(page.body, /id="ob-excluded"/, 'the exclusion declaration is gone, so territory would be answered by silence');
  // The gate must not be a checkbox: no acknowledgement input on the setup page.
  assert.doesNotMatch(page.body, /<input[^>]+type="checkbox"/, 'a checkbox came back');
  assert.doesNotMatch(page.body, /swiper/i, 'the setup page still depends on a vendored slider');
  assert.match(page.body, /rel="icon" href="data:image\/svg\+xml/, 'the page does not carry its own icon');

  // A browser asks for a favicon unprompted; the gate must not answer it with a 409.
  const icon = await request(port, 'GET', '/favicon.ico');
  assert.equal(icon.status, 204, 'the favicon is answered inside the gate');

  const state = await request(port, 'GET', '/api/state');
  assert.equal(state.status, 409, 'the studio should refuse before setup is complete');
});

test('the licence payload the panel posts is the one the server accepts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-lic-'));
  const port = await freePort();
  const child = await startGated({ H3UI_PORT: String(port), H3UI_BASE: root });
  t.after(() => child.kill());

  const before = JSON.parse((await request(port, 'GET', '/api/setup')).body);
  assert.equal(before.state, 'new');

  // Exactly what onboarding.js sends when the terms have been read to the end.
  const accepted = await request(port, 'POST', '/api/setup/licence', {
    accepted: true, tos_ack: true, territory: 'applicable',
  });
  assert.equal(accepted.status, 200);
  assert.equal(JSON.parse(accepted.body).state, 'licence_ok');
  assert.equal(JSON.parse(accepted.body).step, 'credentials');

  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'data', 'setup.json'), 'utf8'));
  assert.ok(onDisk.licence_accepted_at, 'no licence timestamp was recorded');
  assert.ok(onDisk.kaggle_tou_ack_at, 'no Kaggle terms timestamp was recorded');
  assert.equal(onDisk.territory_attested, true);
  assert.equal(onDisk.licence_version, 'minimax-h3-2026-08-02');
  assert.equal(fs.statSync(path.join(root, 'data', 'setup.json')).mode & 0o777, 0o600);
});

test('a partial acknowledgement is refused, and an excluded territory is terminal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-lic2-'));
  const port = await freePort();
  const child = await startGated({ H3UI_PORT: String(port), H3UI_BASE: root });
  t.after(() => child.kill());

  const noTos = await request(port, 'POST', '/api/setup/licence', { accepted: true, territory: 'applicable' });
  assert.equal(noTos.status, 422);
  assert.equal(JSON.parse(noTos.body).reason, 'tos_not_acknowledged');

  const noTerritory = await request(port, 'POST', '/api/setup/licence', { accepted: true, tos_ack: true });
  assert.equal(noTerritory.status, 422);
  assert.equal(JSON.parse(noTerritory.body).reason, 'territory_not_answered');

  const excluded = await request(port, 'POST', '/api/setup/licence', {
    accepted: true, tos_ack: true, territory: 'excluded',
  });
  assert.equal(excluded.status, 451);
  assert.equal(JSON.parse(excluded.body).state, 'territory_blocked');

  const after = JSON.parse((await request(port, 'GET', '/api/setup')).body);
  assert.equal(after.state, 'territory_blocked');
  assert.equal(after.excluded, true);

  // A later credentials post must not lift the block.
  const cred = await request(port, 'POST', '/api/setup/credentials', { token: 'anything' });
  assert.notEqual(JSON.parse((await request(port, 'GET', '/api/setup')).body).state, 'ready');
  assert.ok([200, 403, 451].includes(cred.status));
});

test('a foreign origin cannot answer the terms, and the refusal names it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-origin-'));
  const port = await freePort();
  const child = await startGated({ H3UI_PORT: String(port), H3UI_BASE: root });
  t.after(() => child.kill());

  const payload = { accepted: true, tos_ack: true, territory: 'applicable' };

  // A page on someone else's site must not be able to read the licence for you.
  const foreign = await rawRequest(port, 'POST', '/api/setup/licence', payload, {
    Host: '127.0.0.1:' + port, Origin: 'https://evil.example',
  });
  assert.equal(foreign.status, 403, 'a cross-site write was accepted');
  assert.match(JSON.parse(foreign.body).error, /evil\.example/, 'the refusal does not name the origin it saw');
  assert.equal(JSON.parse((await request(port, 'GET', '/api/setup')).body).state, 'new');

  // No Origin at all is refused rather than assumed to be local.
  const bare = await rawRequest(port, 'POST', '/api/setup/licence', payload);
  assert.equal(bare.status, 403);
  assert.equal(JSON.parse((await request(port, 'GET', '/api/setup')).body).state, 'new');
});

test('the address you browsed is same-origin, whether LAN IP or proxy hostname', async (t) => {
  const lanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-lan-'));
  const lanPort = await freePort();
  const lanChild = await startGated({ H3UI_PORT: String(lanPort), H3UI_BASE: lanRoot });
  t.after(() => lanChild.kill());

  const payload = { accepted: true, tos_ack: true, territory: 'applicable' };

  // Opened at http://192.168.1.50:PORT — Host and Origin agree, so this is same-origin.
  const lan = await rawRequest(lanPort, 'POST', '/api/setup/licence', payload, {
    Host: '192.168.1.50:' + lanPort, Origin: 'http://192.168.1.50:' + lanPort,
  });
  assert.equal(lan.status, 200, 'a write from the address the page was served on was refused');

  // Behind a TLS proxy: Origin is https with no port, Host has no port, proto is forwarded.
  const proxyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-proxy-'));
  const proxyPort = await freePort();
  const proxyChild = await startGated({ H3UI_PORT: String(proxyPort), H3UI_BASE: proxyRoot });
  t.after(() => proxyChild.kill());

  const proxied = await rawRequest(proxyPort, 'POST', '/api/setup/licence', payload, {
    Host: 'studio.example', Origin: 'https://studio.example', 'X-Forwarded-Proto': 'https',
  });
  assert.equal(proxied.status, 200, 'a write through the configured proxy was refused');
});

test('a TLS proxy that forwards no proto is still same-origin, and X-Forwarded-Host counts', async (t) => {
  const payload = { accepted: true, tos_ack: true, territory: 'applicable' };
  const cases = [
    // preview.<zone> terminates TLS and forwards Host without X-Forwarded-Proto (Instabox
    // preview URLs): the browser says https, the hop said nothing. Host equality decides.
    { name: 'no forwarded proto', headers: { Host: 'studio.example', Origin: 'https://studio.example' }, expect: 200 },
    // A proxy that rewrites Host to the loopback origin and reports the public name separately.
    { name: 'x-forwarded-host', headers: { 'X-Forwarded-Host': 'studio.example', Origin: 'https://studio.example' }, expect: 200 },
    // A port that differs from every address the studio was reached on is still refused.
    { name: 'wrong port', headers: { Host: 'studio.example', Origin: 'https://studio.example:9999' }, expect: 403 },
  ];

  for (const c of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-edge-'));
    const port = await freePort();
    const child = await startGated({ H3UI_PORT: String(port), H3UI_BASE: root });
    t.after(() => child.kill());
    const headers = Object.assign({}, c.headers);
    // A proxy that rewrote Host still had to address something; default to the loopback target.
    if (!headers.Host) headers.Host = '127.0.0.1:' + port;
    const r = await rawRequest(port, 'POST', '/api/setup/licence', payload, headers);
    assert.equal(r.status, c.expect, `${c.name}: expected ${c.expect}, got ${r.status} ${r.body}`);
    const state = JSON.parse((await request(port, 'GET', '/api/setup')).body);
    assert.equal(state.state, c.expect === 200 ? 'licence_ok' : 'new', `${c.name}: state did not follow the answer`);
  }
});

test('the refusal names the host the studio was reached on, not just the origin', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-named-'));
  const port = await freePort();
  const child = await startGated({ H3UI_PORT: String(port), H3UI_BASE: root });
  t.after(() => child.kill());

  const r = await rawRequest(port, 'POST', '/api/setup/licence', { accepted: true, tos_ack: true, territory: 'applicable' }, {
    Host: 'studio.example', Origin: 'https://elsewhere.example',
  });
  assert.equal(r.status, 403);
  const error = JSON.parse(r.body).error;
  assert.match(error, /elsewhere\.example/, 'the refusal does not name the origin it saw');
  assert.match(error, /host studio\.example/, 'the refusal does not name the address the studio was reached on');
});

test('a proxy that rewrote Host cannot stop the gate: the page token is the proof', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-csrf-'));
  const port = await freePort();
  const child = await startGated({ H3UI_PORT: String(port), H3UI_BASE: root });
  t.after(() => child.kill());

  const payload = { accepted: true, tos_ack: true, territory: 'applicable' };

  // The panel is rendered with the token; GET /api/setup reports the same one.
  const page = await rawRequest(port, 'GET', '/', null, { Host: '127.0.0.1:' + port });
  const token = /"csrf":"([a-f0-9]{32,})"/.exec(page.body);
  assert.ok(token, 'the gate page does not carry a csrf token');
  const boot = JSON.parse((await request(port, 'GET', '/api/setup')).body);
  assert.equal(boot.csrf, token[1], 'the page and the API disagree on the token');

  // The browser's real address, while the proxy upstreams to loopback: Origin can never
  // match Host here, so only the token can prove the write came from our own page.
  const rewritten = {
    Host: '127.0.0.1:' + port, Origin: 'https://8804-preview.example', 'X-Setup-CSRF': token[1],
  };

  // Without the token the same shape is refused, and the state does not move.
  const hostile = await rawRequest(port, 'POST', '/api/setup/licence', payload, {
    Host: rewritten.Host, Origin: rewritten.Origin,
  });
  assert.equal(hostile.status, 403, 'a write with neither token nor matching origin was accepted');
  assert.equal(JSON.parse((await request(port, 'GET', '/api/setup')).body).state, 'new');

  const honest = await rawRequest(port, 'POST', '/api/setup/licence', payload, rewritten);
  assert.equal(honest.status, 200, 'the token from the rendered page did not unlock the write');
  assert.equal(JSON.parse((await request(port, 'GET', '/api/setup')).body).state, 'licence_ok');

  // A token that is not the one this process minted is no better than none.
  const wrong = await rawRequest(port, 'POST', '/api/setup/credentials', { token: 'x' }, {
    Host: '127.0.0.1:' + port, Origin: 'https://8804-preview.example', 'X-Setup-CSRF': 'f'.repeat(48),
  });
  assert.equal(wrong.status, 403);
});
