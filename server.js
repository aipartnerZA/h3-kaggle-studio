'use strict';

// H3 video render UI — zero-dependency HTTP server (SPEC §7, D3).
// Binds loopback by default and mounts at config.prefix / H3UI_PREFIX (default /).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/store');
const cost = require('./lib/cost');
const auth = require('./lib/auth');
const { createClient, formatSast, resolveBin } = require('./lib/kaggle');
const { createPipeline } = require('./lib/pipeline');
const { createWorker, TERMINAL } = require('./lib/worker');
const setup = require('./lib/setup');
const kaggleAuth = require('./lib/kaggle-auth');
const multipart = require('./lib/multipart');

const VERSION = '2.0.0';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const APP_DIR = __dirname;
const ENGINE_DIR = path.join(APP_DIR, 'engine');

function normalizePrefix(value) {
  let p = String(value == null ? '' : value).trim();
  if (!p || p === '/') return '/';
  if (!p.startsWith('/')) p = '/' + p;
  return p.replace(/\/+$/, '') || '/';
}

// config.json is gitignored and read only when present; config.example.json is
// the shipped template and supplies the defaults. Env overrides win (SPEC §7.3).
function loadConfig() {
  const examplePath = path.join(APP_DIR, 'config.example.json');
  let cfg = {};
  if (fs.existsSync(examplePath)) cfg = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  const wanted = path.resolve(process.cwd(), process.env.H3UI_CONFIG || 'config.json');
  if (fs.existsSync(wanted)) {
    cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(wanted, 'utf8')));
  } else if (process.env.H3UI_CONFIG) {
    console.warn(`h3ui: config file ${wanted} not found — using config.example.json defaults`);
  }
  const e = process.env;
  if (e.H3UI_PORT) cfg.port = Number(e.H3UI_PORT);
  if (e.H3UI_PREFIX) cfg.prefix = e.H3UI_PREFIX;
  if (e.H3UI_BIND) cfg.bind = e.H3UI_BIND;
  if (e.H3UI_OWNER) cfg.owner = e.H3UI_OWNER;
  if (e.H3UI_KAGGLE_BIN) cfg.kaggle_bin = e.H3UI_KAGGLE_BIN;
  if (e.H3UI_KAGGLE_HOME) cfg.kaggle_home = e.H3UI_KAGGLE_HOME;
  if (e.H3UI_POLL_MS) cfg.poll_override_ms = Number(e.H3UI_POLL_MS);
  if (e.H3UI_NO_WORKER) cfg.worker_enabled = false;
  cfg.port = Number(cfg.port || 8804);
  cfg.bind = cfg.bind || '127.0.0.1';
  cfg.prefix = normalizePrefix(cfg.prefix || '/');
  cfg.kernel_prefix = cfg.kernel_prefix || 'h3-six-';
  cfg.engine_dir = ENGINE_DIR;
  return cfg;
}

const config = loadConfig();
const base = path.resolve(process.env.H3UI_BASE || __dirname);
const publicDir = path.join(__dirname, 'public');
const prefix = config.prefix;
const prefixBase = prefix === '/' ? '' : prefix;

// A missing or non-executable kaggle CLI is a boot failure with the install line.
const kaggleBin = resolveBin(config);
if (!kaggleBin.ok) {
  if (process.env.MOCK_KAGGLE === '1') {
    console.warn('h3ui: mock mode — the kaggle CLI is not installed, which is fine here.');
  } else {
    console.error('h3ui: ' + kaggleBin.error);
    process.exit(1);
  }
}
config.kaggle_bin = kaggleBin.bin;

store.ensureDirs(base);
const kaggle = createClient(config);
if (!config.owner) {
  const who = kaggle.username();
  if (who) config.owner = who;
  else console.warn('h3ui: the Kaggle username is unknown — set "owner" in config.json or H3UI_OWNER; pushes will refuse to start until it is set.');
}
const pipeline = createPipeline(config, base, { kaggle });
const worker = createWorker({ config, base, store, pipeline, kaggle });


// ---------------------------------------------------------------------------------------------
// First-run setup. The state machine lives in lib/setup.js; this is the HTTP face of it.

const MOCK = process.env.MOCK_KAGGLE === '1';
const LOOPBACK = /^(127\.|::1$|localhost$|::ffff:127\.)/;
const onLoopback = () => LOOPBACK.test(String(config.bind || ''));
const mockBound = () => MOCK && onLoopback();
const skipOnboarding = () => process.env.H3UI_SKIP_ONBOARDING === '1' && onLoopback();

if (MOCK && !onLoopback()) {
  console.warn('h3ui: MOCK_KAGGLE is set but the bind is not loopback — mock mode is ignored.');
}
if (process.env.H3UI_SKIP_ONBOARDING === '1' && !onLoopback()) {
  console.warn('h3ui: H3UI_SKIP_ONBOARDING is set but the bind is not loopback — the flag is ignored.');
}

let lastProbe = null;   // {username, quota, at} — the last successful probe, for the UI only

function probeNow() {
  if (mockBound()) {
    return {
      result: 'ok', username: 'mock-user', cli_version: 'mock',
      quota: { remaining_h: 22.1, used_h: 7.9, total_h: 30, reset_sast: 'Sat 02:00 SAST' },
    };
  }
  return kaggleAuth.createProbe(config).probe();
}

function setupJson() {
  const body = setup.publicState(base);
  body.step = setup.stepFor(body.state);
  body.mock = mockBound();
  if (body.state === 'ready') {
    body.username = (lastProbe && lastProbe.username) || body.username || null;
    body.quota = lastProbe ? lastProbe.quota : (quota(true) ? {
      remaining_h: quota(true).remaining_h, reset_sast: formatSast(quota(true).refresh_at),
    } : null);
  }
  return body;
}

function jsonBody(raw) {
  const text = raw && raw.length ? raw.toString('utf8') : '{}';
  return JSON.parse(text || '{}');
}

async function readJsonPost(req, res) {
  const origin = auth.checkOrigin(req, config);
  if (!origin.ok) { err(res, origin.status, origin.error); return null; }
  let raw;
  try {
    raw = await auth.readBody(req, config.body_max_bytes);
  } catch (e) {
    err(res, e.status || 400, e.status === 413 ? 'Request body too large.' : 'Could not read request body.');
    return null;
  }
  try {
    return { body: jsonBody(raw), raw };
  } catch (e) {
    err(res, 400, 'Request body must be JSON.');
    return null;
  }
}

async function postLicence(req, res) {
  const parsed = await readJsonPost(req, res);
  if (!parsed) return;
  const r = setup.acceptLicence(base, parsed.body);
  if (!r.ok) {
    return json(res, 422, {
      error: 'The licence terms have not been acknowledged.',
      reason: r.reason,
      state: setup.state(base),
    });
  }
  if (r.state === 'territory_blocked') {
    return json(res, 451, {
      error: 'This studio will not render for you in an excluded territory. Request a licence from MiniMax first.',
      state: r.state,
      step: setup.stepFor(r.state),
      licence_url: 'https://platform.minimax.io/h3-license',
    });
  }
  return json(res, 200, setupJson());
}

const REASON_TEXT = {
  rejected: 'That token did not work. Kaggle answered "authentication required".',
  forbidden: 'Kaggle rejected the token with 403. Phone or identity verification is outstanding.',
  unreachable: 'Could not reach Kaggle.',
  old_cli: 'This needs the Kaggle command-line tool version 2 or later.',
};

async function postCredentials(req, res) {
  const origin = auth.checkOrigin(req, config);
  if (!origin.ok) return err(res, origin.status, origin.error);

  let raw;
  try {
    raw = await auth.readBody(req, config.body_max_bytes);
  } catch (e) {
    return err(res, e.status || 400, e.status === 413 ? 'Request body too large.' : 'Could not read request body.');
  }

  const ctype = String(req.headers['content-type'] || '');
  let wrote = { ok: false, reason: 'empty' };

  if (ctype.includes('multipart/form-data')) {
    let parts;
    try { parts = multipart.parseMultipart(raw, ctype); } catch (e) { parts = []; }
    const file = multipart.firstFile(parts);
    if (!file || !file.data || !file.data.length) return json(res, 422, { error: REASON_TEXT.rejected, reason: 'rejected' });
    wrote = kaggleAuth.writeKaggleJson(config, file.data.toString('utf8'));
    if (!wrote.ok) return json(res, 422, { error: 'That kaggle.json could not be read. It needs "username" and "key".', reason: 'rejected' });
  } else {
    let body;
    try { body = jsonBody(raw); } catch (e) { return err(res, 400, 'Request body must be JSON.'); }
    if (!body || typeof body.token !== 'string' || !body.token.trim()) {
      return json(res, 422, { error: REASON_TEXT.rejected, reason: 'rejected' });
    }
    wrote = kaggleAuth.writeToken(config, body.token);
    if (!wrote.ok) return json(res, 422, { error: REASON_TEXT.rejected, reason: 'rejected' });
  }

  const probe = probeNow();
  setup.recordProbe(base, probe);
  const st = setup.state(base);

  if (probe.result === 'ok' || probe.result === 'quota_empty') {
    lastProbe = { username: probe.username || (wrote && wrote.username) || null, quota: probe.quota || null, at: Date.now() };
    if (!config.owner && lastProbe.username) config.owner = lastProbe.username;
    quotaCache = { at: 0, value: null };
    return json(res, 200, setupJson());
  }

  const map = {
    unauthenticated: [422, 'rejected'],
    forbidden: [403, 'forbidden'],
    unreachable: [502, 'unreachable'],
    old_cli: [400, 'old_cli'],
  };
  const [code, reason] = map[probe.result] || [422, 'rejected'];
  return json(res, code, { error: REASON_TEXT[reason], reason, state: st });
}

function deleteCredentials(req, res) {
  const origin = auth.checkOrigin(req, config);
  if (!origin.ok) return err(res, origin.status, origin.error);
  kaggleAuth.removeCredentials(config);
  setup.clearCredential(base);
  lastProbe = null;
  quotaCache = { at: 0, value: null };
  return json(res, 200, setupJson());
}

let quotaCache = { at: 0, value: null };
function quota(force) {
  if (!force && quotaCache.value && Date.now() - quotaCache.at < 60000) return quotaCache.value;
  const q = kaggle.quota();
  if (q && q.ok) quotaCache = { at: Date.now(), value: q };
  return (q && q.ok) ? q : quotaCache.value;
}

function send(res, code, body, headers) {
  const h = Object.assign({}, headers || {});
  let data;
  if (body == null) data = '';
  else if (typeof body === 'string' || Buffer.isBuffer(body)) data = body;
  else { data = JSON.stringify(body); h['Content-Type'] = 'application/json; charset=utf-8'; }
  if (!h['Content-Type']) h['Content-Type'] = 'text/plain; charset=utf-8';
  h['Content-Length'] = Buffer.byteLength(data);
  h['Cache-Control'] = h['Cache-Control'] || 'no-store';
  res.writeHead(code, h);
  res.end(data);
}
const json = (res, code, obj, headers) => send(res, code, obj, headers);
function err(res, code, message, extra) {
  return json(res, code, Object.assign({ error: message }, extra || {}));
}

function tail(text, n) {
  return String(text || '').split(/\r?\n/).filter((l) => l).slice(-n).join('\n') + '\n';
}

// ---- Server-rendered first paint (SPEC §8.3: busy state is disk-backed) ------
// The browser gets the same board the API would return, plus a rendered banner,
// run panel and history. app.js takes over from there; nothing here invents a
// status that the worker did not write to disk.
function htmlEsc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function jsonForHtml(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function fmtElapsed(min) {
  if (!Number.isFinite(min)) return '?';
  const m = Math.max(0, Math.floor(min));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function fmtClock(iso) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '—';
  return `${formatSast(iso) || '—'} / ${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function boardState() {
  const q = quota();
  const active = worker.getActive();
  let live = null;
  if (active) {
    const st = store.readState(base, active.tag) || {};
    live = Object.assign({}, active, {
      kaggle_status: st.kaggle_status || null,
      kaggle_status_at: st.kaggle_status_at || null,
      status_stale: !!st.status_stale,
      phase_since: st.phase_since || null,
      submitted_at: st.submitted_at || null,
      pushed_at: st.pushed_at || null,
      estimate: st.estimate || null,
      slots: st.slots || [],
      totals: st.totals || { ok: 0, failed: 0 },
      error: st.error || null,
    });
  }
  return {
    ok: true,
    version: VERSION,
    server_time: new Date().toISOString(),
    active: live,
    runs: store.listRunTags(base).reverse().slice(0, 20).map(runSummary),
    quota: q && q.ok ? {
      gpu_remaining_h: q.gpu_remaining_h,
      gpu_used_h: q.gpu_used_h,
      refresh_at: q.refresh_at,
      refresh_sast: q.refresh_sast,
      read_at: new Date().toISOString(),
    } : null,
    config: {
      max_slots: config.max_slots,
      seconds_min: config.seconds_min,
      seconds_max: config.seconds_max,
      prompt_max_chars: config.prompt_max_chars,
      image_max_bytes: config.image_max_bytes,
      setup_min: config.setup_min,
      seconds_per_frame: config.seconds_per_frame,
      allow_text_only: config.allow_text_only !== false,
      keep_runs: config.keep_runs,
      poll_busy_s: config.poll_busy_s,
      poll_idle_s: config.poll_idle_s,
      queue_wait_warn_min: config.queue_wait_warn_min,
    },
  };
}

function busyDetail(board, nowMs) {
  const a = board.active;
  const elapsed = a.phase_since ? (nowMs - Date.parse(a.phase_since)) / 60000 : 0;
  const planned = (a.estimate && a.estimate.total_min) || 0;
  const eta = planned ? Math.max(0, planned - elapsed) : null;
  const totals = a.totals || { ok: 0, failed: 0 };
  let detail = `${a.tag} · Status: ${a.kaggle_status || 'WAITING'}`
    + ` · elapsed ${fmtElapsed(elapsed)} · ~${eta == null ? '?' : fmtElapsed(eta)} left`
    + ` · ${totals.ok}/${(a.slots || []).length} slots done`;
  const age = a.kaggle_status_at ? (nowMs - Date.parse(a.kaggle_status_at)) / 1000 : Infinity;
  if (a.status_stale || age > 120) {
    const mins = Number.isFinite(age) ? Math.floor(age / 60) : '?';
    detail += ` (status may be stale — last read ${mins} min ago)`;
  }
  return detail;
}

function bannerHtml(board, nowMs) {
  if (board.active) {
    return `<strong>RENDER IN PROGRESS</strong><span>${htmlEsc(busyDetail(board, nowMs))}</span>`;
  }
  const last = board.runs.find((r) => TERMINAL.has(r.phase));
  if (last) {
    const head = last.phase === 'DONE'
      ? `Last run DONE — ${last.totals.ok}/${last.slots} clips`
      : 'Last run FAILED — reason below';
    return `<strong>${htmlEsc(head)}</strong><span>${htmlEsc(last.tag)} · ${htmlEsc(last.phase)}</span>`;
  }
  const q = board.quota;
  const line = `GPU quota ${q ? q.gpu_remaining_h : '?'} h left · resets ${(q && q.refresh_sast) || '? SAST'}`;
  return `<strong>Idle. No job running.</strong><span>${htmlEsc(line)}</span>`;
}

function fileSizeMb(tag, name) {
  try { return (fs.statSync(path.join(store.runDir(base, tag), 'out', name)).size / 1048576).toFixed(1); } catch (e) { return '?'; }
}

function fileCell(tag, name, label) {
  const href = `${prefixBase}/api/runs/${encodeURIComponent(tag)}/files/${encodeURIComponent(name)}`;
  return `<a class="download-link" href="${htmlEsc(href)}">${htmlEsc(label)}</a>`;
}

function runPanelHtml(board) {
  const tag = board.active ? board.active.tag
    : ((board.runs.find((r) => r.files && r.files.length) || {}).tag);
  if (!tag) return '';
  const st = store.readState(base, tag) || {};
  const downloads = (st.slots || []).filter((s) => s.file).map((s) => {
    const secs = s.frames ? (s.frames / 24).toFixed(2) : String(s.seconds);
    return fileCell(tag, s.file, `Download slot ${s.n} · ${secs} s · ${fileSizeMb(tag, s.file)} MB`);
  });
  const sheets = (st.slots || []).filter((s) => s.sheet).map((s) =>
    fileCell(tag, s.sheet, `Contact sheet for slot ${s.n}`));
  if (!downloads.length && !sheets.length && !board.active) return '';
  return `<h3>${htmlEsc(tag)} · ${htmlEsc(st.phase || '')}</h3>`
    + `<div class="downloads">${downloads.concat(sheets).join('')}</div>`;
}

function historyHtml(board) {
  return board.runs.map((r) => {
    const totals = r.totals || { ok: 0, failed: 0 };
    const when = fmtClock(r.submitted_at);
    const cost = r.quota_cost_h == null ? '?' : r.quota_cost_h;
    const downloads = (r.files || []).map((f) => fileCell(r.tag, f.name,
      `Download slot ${f.n} · ${Number(f.seconds).toFixed(2)} s · ${f.mb} MB`));
    return `<li><a href="${htmlEsc(`${prefixBase}/api/runs/${encodeURIComponent(r.tag)}`)}">${htmlEsc(r.tag)}</a>`
      + ` · ${htmlEsc(when)} · ${htmlEsc(r.phase || '?')} · ${totals.ok}/${totals.slots}`
      + ` · ${htmlEsc(cost)} h GPU${downloads.length ? ' · ' + downloads.join(' · ') : ''}</li>`;
  }).join('');
}

function renderIndex() {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const board = boardState();
  const nowMs = Date.now();
  return html
    .replace('<!--H3_BOOTSTRAP-->', `<template id="h3-bootstrap">${jsonForHtml(board)}</template>`)
    .replace('<!--H3_BANNER-->', bannerHtml(board, nowMs))
    .replace('<!--H3_RUNPANEL-->', runPanelHtml(board))
    .replace('<!--H3_HISTORY-->', historyHtml(board))
    .replace(/<meta name="h3-prefix" content="[^"]*">/,
      `<meta name="h3-prefix" content="${htmlEsc(prefixBase)}">`)
    .replace(/(href|src)="\/assets\//g, (m, attr) => `${attr}="${prefixBase}/assets/`);
}

function renderOnboarding() {
  const html = fs.readFileSync(path.join(publicDir, 'onboarding.html'), 'utf8');
  const st = setupJson();
  const payload = Object.assign({ prefix: prefixBase }, st);
  return html
    .replace('<!--H3_ONBOARDING-->', jsonForHtml(payload))
    .replace(/(href|src)="\/(vendor|assets)\//g, (m, attr, dir) => `${attr}="${prefixBase}/${dir}/`)
    .replace(/(href|src)="\/(onboarding\.(?:js|css)|style\.css)"/g, (m, attr, f) => `${attr}="${prefixBase}/${f}"`);
}

function runSummary(tag) {
  const st = store.readState(base, tag) || {};
  const req = store.readRequest(base, tag) || {};
  const before = st.quota && st.quota.gpu_remaining_h;
  const after = st.quota_after && st.quota_after.gpu_remaining_h;
  return {
    tag,
    phase: st.phase || null,
    phase_since: st.phase_since || null,
    submitted_at: st.submitted_at || req.submitted_at || null,
    kaggle_status: st.kaggle_status || null,
    status_stale: !!st.status_stale,
    totals: st.totals || { ok: 0, failed: 0 },
    quota_cost_h: (before != null && after != null) ? Math.round((before - after) * 100) / 100 : null,
    error: st.error || null,
    slots: (st.slots || []).length,
    files: (st.slots || []).filter((s) => s.file).map((s) => ({
      n: s.n, name: s.file, sheet: s.sheet || null,
      seconds: s.frames ? s.frames / 24 : s.seconds, mb: fileSizeMb(tag, s.file),
    })),
  };
}

function makeTag() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  for (let i = 0; i < 16; i++) {
    const tag = `ui-${day}-${crypto.randomBytes(2).toString('hex')}`;
    if (!fs.existsSync(store.runDir(base, tag))) return tag;
  }
  return null;
}

let lastAcceptedAt = 0;

async function postSubmission(req, res) {
  const origin = auth.checkOrigin(req, config);
  if (!origin.ok) return err(res, origin.status, origin.error);

  let raw;
  try {
    raw = await auth.readBody(req, config.body_max_bytes);
  } catch (e) {
    return err(res, e.status || 400, e.status === 413 ? 'Request body too large.' : 'Could not read request body.');
  }
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (e) {
    return err(res, 400, 'Request body must be JSON.');
  }

  const v = auth.validateSlots(body, config);
  if (!v.ok) return err(res, v.status, v.error);
  const submissionId = String((body && body.submission_id) || '').trim();
  if (!submissionId || submissionId.length > 200) return err(res, 400, 'submission_id is required.');
  if (!config.owner) {
    return err(res, 503, 'The Kaggle username is unknown. Run `kaggle config view` or set "owner" in config.json.');
  }

  const busy = worker.getActive();
  if (busy) {
    for (const tag of store.listRunTags(base)) {
      const request = store.readRequest(base, tag);
      if (request && request.submission_id === submissionId) {
        const state = store.readState(base, tag) || {};
        return json(res, 200, { tag, phase: state.phase || 'QUEUED', estimate: state.estimate || null });
      }
    }
    return err(res, 409, 'A render is already running. Wait for it to finish, then submit again.', {
      error_code: 'busy', active_tag: busy.tag, phase: busy.phase,
    });
  }

  if (config.allow_text_only === false && v.slots.some((s) => !s._image)) {
    const slot = v.slots.find((s) => !s._image);
    return err(res, 422, `Image is required for slot ${slot.n}.`);
  }

  const estimate = cost.estimate(v.slots, config);
  const q = quota(true);
  if (!q || !q.ok || q.gpu_remaining_h == null) return err(res, 503, 'kaggle CLI unreachable');
  if (!cost.quotaOk(q.gpu_remaining_h, estimate.quota_needed_h, config.quota_margin_h)) {
    return err(res, 422, `Not enough GPU quota: this run needs about ${estimate.quota_needed_h} h and ${q.gpu_remaining_h} h is left.`, {
      need_h: estimate.quota_needed_h, left_h: q.gpu_remaining_h,
    });
  }
  if (lastAcceptedAt && Date.now() - lastAcceptedAt < 60 * 1000) {
    return err(res, 429, 'Too many submissions. Wait a minute and try again.');
  }

  const tag = makeTag();
  if (!tag) return err(res, 503, 'Could not allocate a run tag.');
  const runDir = store.ensureRun(base, tag);
  const reqSlots = v.slots.map((s) => {
    const copy = Object.assign({}, s);
    delete copy._image;
    if (s._image) {
      const name = `s${s.n}_${s.id}.${s._image.ext}`;
      fs.writeFileSync(path.join(runDir, 'images', name), s._image.bytes);
      copy.image = `images/${name}`;
      copy.image_bytes = s._image.bytes.length;
      copy.image_name = path.basename(String(body.slots.find((x) => x.n === s.n).image_name || 'upload'))
        .replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    }
    return copy;
  });

  const request = {
    tag,
    submitted_at: new Date().toISOString(),
    submission_id: submissionId,
    note: String((body && body.note) || '').slice(0, 500),
    slots: reqSlots,
  };
  const state = worker.submit(request, estimate, q);
  lastAcceptedAt = Date.now();
  return json(res, 201, { tag, phase: state.phase, estimate, slots: state.slots });
}

function serveFile(res, file, contentType) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return err(res, 404, 'Not found.'); }
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  };
  return send(res, 200, buf, headers);
}

function vendorRoute(res, pathname) {
  const m = pathname.match(VENDOR_ROUTE);
  if (!m) return err(res, 404, 'Not found.');
  const rel = decodeURIComponent(m[1]);
  if (rel.includes('..') || rel.startsWith('/')) return err(res, 404, 'Not found.');
  const root = path.join(publicDir, 'vendor');
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return err(res, 404, 'Not found.');
  const type = full.endsWith('.js') ? 'application/javascript; charset=utf-8'
    : full.endsWith('.css') ? 'text/css; charset=utf-8'
    : full.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
  return serveFile(res, full, type);
}

function staticRoute(res, pathname) {
  const rel = pathname.slice(prefix.length).replace(/^\/+/, '') || 'index.html';
  if (rel.includes('..')) return err(res, 404, 'Not found.');
  const map = {
    'index.html': 'index.html',
    'app.js': 'app.js',
    'assets/app.js': 'app.js',
    'onboarding.js': 'onboarding.js',
    'assets/onboarding.js': 'onboarding.js',
    'onboarding.css': 'onboarding.css',
    'assets/onboarding.css': 'onboarding.css',
    'style.css': 'style.css',
    'assets/style.css': 'style.css',
    'gsap.min.js': 'gsap.min.js',
    'assets/gsap.min.js': 'gsap.min.js',
  };
  const file = map[rel];
  if (!file) return err(res, 404, 'Not found.');
  if (file === 'index.html') {
    const usable = setup.state(base) === 'ready' || skipOnboarding();
    return send(res, 200, usable ? renderIndex() : renderOnboarding(), {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP,
    });
  }
  const type = file.endsWith('.js') ? 'application/javascript; charset=utf-8'
    : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
  return serveFile(res, path.join(publicDir, file), type);
}

function fileRoute(req, res, tag, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(mp4|png)$/.test(name)) return err(res, 404, 'Not found.');
  const state = store.readState(base, tag);
  if (!state) return err(res, 404, 'Run not found.');
  const allowed = new Set();
  for (const s of state.slots || []) {
    if (s.file) allowed.add(s.file);
    if (s.sheet) allowed.add(s.sheet);
  }
  if (!allowed.has(name)) return err(res, 404, 'File not found in this run.');
  const dir = path.resolve(store.runDir(base, tag), 'out');
  const full = path.resolve(dir, name);
  if (!full.startsWith(dir + path.sep)) return err(res, 404, 'Not found.');
  let stat;
  try { stat = fs.statSync(full); } catch (e) { return err(res, 404, 'File not found.'); }

  let start = 0;
  let end = stat.size - 1;
  let code = 200;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    start = Math.min(Number(m[1]), end);
    if (m[2]) end = Math.min(Number(m[2]), end);
    code = 206;
  }
  const headers = {
    'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'image/png',
    'Content-Length': Math.max(0, end - start + 1),
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename="${tag}_${name}"`,
    'Cache-Control': 'private, no-store',
  };
  if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(full, { start, end }).pipe(res);
}

function logRoute(res, tag, which) {
  const state = store.readState(base, tag);
  if (!state) return err(res, 404, 'Run not found.');
  let text = null;
  if (which === 'push') {
    const f = path.join(store.runDir(base, tag), 'logs', 'push.log');
    if (fs.existsSync(f)) text = fs.readFileSync(f, 'utf8');
  } else {
    const dir = pipeline.outDir(tag);
    if (fs.existsSync(dir)) {
      const logs = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
      if (logs.length) text = fs.readFileSync(path.join(dir, logs[logs.length - 1]), 'utf8');
    }
  }
  if (text == null) return err(res, 404, 'Log not found.');
  return send(res, 200, tail(auth.scrub(text), 200), { 'Content-Type': 'text/plain; charset=utf-8' });
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const runRoute = (suffix) => new RegExp('^' + escRe(prefixBase) + '/api/runs/([A-Za-z0-9-]+)' + suffix);
const RUN_FILES = runRoute('/files/([^/]+)$');
const RUN_LOG = runRoute('/log$');
const RUN_ACTION = runRoute('/(cancel|delete)$');
const RUN_ONE = runRoute('$');
const ASSET_ROUTE = new RegExp('^' + escRe(prefixBase) + '/(assets/)?(app\\.js|onboarding\\.js|onboarding\\.css|style\\.css|gsap\\.min\\.js)$');
const VENDOR_ROUTE = new RegExp('^' + escRe(prefixBase) + '/vendor/(.+)$');

async function handle(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  const method = req.method || 'GET';
  const api = `${prefixBase}/api`;

  if (prefixBase && p !== prefixBase && !p.startsWith(prefixBase + '/')) return err(res, 404, 'Not found.');

  const setupState = setup.state(base);

  // ---- setup API: open while the studio is not ready ----
  if (p === `${api}/setup` && method === 'GET') return json(res, 200, setupJson());
  if (p === `${api}/setup/licence` && method === 'POST') return postLicence(req, res);
  if (p === `${api}/setup/credentials` && method === 'POST') return postCredentials(req, res);
  if (p === `${api}/setup/credentials` && method === 'DELETE') return deleteCredentials(req, res);

  if (p === `${api}/health` && method === 'GET') {
    const active = worker.getActive();
    const kauth = kaggle.auth();
    const ready = setupState === 'ready' || skipOnboarding();
    return json(res, ready ? 200 : 503, {
      ok: ready,
      version: VERSION,
      active: active ? active.tag : null,
      kaggle_auth: kauth,
      setup_state: setupState,
    });
  }

  // ---- the gate. Server-side, ahead of every studio route. ----
  if (setupState !== 'ready' && !skipOnboarding()) {
    const isPage = method === 'GET' && (p === prefix || p === prefix + '/');
    const isAsset = method === 'GET' && (ASSET_ROUTE.test(p) || VENDOR_ROUTE.test(p));
    if (!isPage && !isAsset) {
      return json(res, 409, {
        error: 'Setup is not complete.',
        state: setupState,
        step: setup.stepFor(setupState),
      });
    }
  }

  if (p === `${api}/state` && method === 'GET') return json(res, 200, boardState());

  if (p === `${api}/submissions` && method === 'POST') return postSubmission(req, res);

  let m = p.match(RUN_FILES);
  if (m && method === 'GET') return fileRoute(req, res, m[1], decodeURIComponent(m[2]));

  m = p.match(RUN_LOG);
  if (m && method === 'GET') return logRoute(res, m[1], u.searchParams.get('which') === 'push' ? 'push' : 'render');

  m = p.match(RUN_ACTION);
  if (m && method === 'POST') {
    const origin = auth.checkOrigin(req, config);
    if (!origin.ok) return err(res, origin.status, origin.error);
    const result = m[2] === 'cancel' ? worker.cancel(m[1]) : worker.deleteRun(m[1]);
    if (result.missing) return err(res, 404, 'Run not found.');
    if (result.conflict) return err(res, 409, m[2] === 'cancel'
      ? 'Already pushed — the render service exposes no cancel. Let it finish.'
      : 'Only finished runs can be deleted.', { phase: result.phase });
    return json(res, 200, result);
  }

  m = p.match(RUN_ONE);
  if (m && method === 'GET') {
    const tag = m[1];
    const request = store.readRequest(base, tag);
    const state = store.readState(base, tag);
    if (!request || !state) return err(res, 404, 'Run not found.');
    const byN = new Map((request.slots || []).map((s) => [s.n, s]));
    return json(res, 200, {
      request,
      state,
      slots: (state.slots || []).map((s) => Object.assign({}, s, {
        prompt: byN.get(s.n) ? byN.get(s.n).prompt : '',
        image_name: byN.get(s.n) ? byN.get(s.n).image_name : null,
      })),
      files: (state.slots || []).filter((s) => s.file).map((s) => ({
        n: s.n,
        name: s.file,
        sheet: s.sheet || null,
        seconds: s.frames ? s.frames / 24 : s.seconds,
        mb: fileSizeMb(tag, s.file),
      })),
      terminal: TERMINAL.has(state.phase),
    });
  }

  if (method === 'GET' && (p === prefix || p === prefix + '/')) return staticRoute(res, p);
  if (method === 'GET' && VENDOR_ROUTE.test(p)) return vendorRoute(res, p);
  if (method === 'GET' && ASSET_ROUTE.test(p)) return staticRoute(res, p);

  return err(res, 404, 'Not found.');
}

const server = http.createServer((req, res) => {
  Promise.resolve().then(() => handle(req, res)).catch((e) => {
    if (!res.headersSent) err(res, 500, 'Internal error: ' + String(e && e.message || e));
    else res.end();
  });
});

if (config.worker_enabled !== false) worker.start();
server.listen(config.port, config.bind, () => {
  console.log(`h3ui ${VERSION} listening on ${config.bind}:${config.port} (base ${base}, prefix ${prefix})`);
});

module.exports = { server, worker, config, base, prefix };
