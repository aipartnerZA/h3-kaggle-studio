'use strict';

// Credential handling and the liveness probe.
//
// The only question that matters is: does Kaggle itself say this credential works? A file on disk is
// not evidence. `kaggle config view` proves a credential exists; `kaggle quota` proves the account has
// GPU entitlement. A wrong token and a missing token are indistinguishable to the CLI (both fall
// through to "Authentication required"), so we report the difference we can prove and nothing more.
//
// Results are a closed enum so no raw CLI output can reach the browser:
//   ok | unauthenticated | forbidden | quota_empty | unreachable | old_cli

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TIMEOUT_MS = 60000;

function defaultRunner(cmd, args, opts) {
  return spawnSync(cmd, args, opts);
}

function kaggleHome(config) {
  if (config && config.kaggle_home) return config.kaggle_home;
  if (process.env.H3UI_KAGGLE_HOME) return process.env.H3UI_KAGGLE_HOME;
  if (process.env.KAGGLE_HOME) return process.env.KAGGLE_HOME;
  return path.join(os.homedir(), '.kaggle');
}

function kaggleBin(config) {
  if (config && config.kaggle_bin) return config.kaggle_bin;
  if (process.env.H3UI_KAGGLE_BIN) return process.env.H3UI_KAGGLE_BIN;
  return 'kaggle';
}

function childEnv(config) {
  const env = Object.assign({}, process.env);
  env.KAGGLE_HOME = kaggleHome(config);
  delete env.KAGGLE_API_TOKEN_PRESENT;
  return env;
}

function cliMajor(versionText) {
  const m = String(versionText || '').match(/(\d+)\.(\d+)/);
  return m ? Number(m[1]) : null;
}

// `- username: someone`
function parseUsername(text) {
  const m = String(text || '').match(/^\s*-?\s*username:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

function isAuthRequired(res) {
  const out = `${res && res.stdout ? res.stdout : ''}${res && res.stderr ? res.stderr : ''}`;
  return /Authentication required/i.test(out);
}

function isForbidden(res) {
  const out = `${res && res.stdout ? res.stdout : ''}${res && res.stderr ? res.stderr : ''}`;
  return /403|Forbidden|Authentication failed/i.test(out) && !/Authentication required/i.test(out);
}

// A GPU row from `kaggle quota`, or null when the account has no GPU entitlement yet.
function parseQuotaRow(text) {
  const line = String(text || '').split(/\r?\n/).find((l) => /^\s*GPU\b/.test(l));
  if (!line) return null;
  const cols = line.trim().split(/\s+/);
  const hours = (v) => {
    const m = String(v || '').match(/([0-9]+(?:\.[0-9]+)?)h/);
    return m ? Number(m[1]) : null;
  };
  return {
    gpu_used_h: hours(cols[1]),
    gpu_remaining_h: hours(cols[2]),
    gpu_total_h: hours(cols[3]),
    refresh_at: cols[4] || null,
  };
}

// The reset time as a short SAST label without ICU: the box clock is UTC.
function formatReset(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms + 2 * 3600 * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${hh}:${mm} SAST`;
}

function createProbe(config, deps) {
  const run = (deps && deps.run) || defaultRunner;
  const bin = kaggleBin(config);
  const env = childEnv(config);
  const timeout = (deps && deps.timeout) || TIMEOUT_MS;
  const opts = () => ({ env, timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

  // One call, normalised. Never throws.
  function call(args) {
    try {
      const res = run(bin, args, opts());
      if (!res) return { status: null, stdout: '', stderr: '', error: 'no result' };
      return {
        status: res.status,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        error: res.error ? String(res.error.code || res.error.message) : null,
      };
    } catch (e) {
      return { status: null, stdout: '', stderr: '', error: String(e.code || e.message) };
    }
  }

  function unreachableish(res) {
    return res.status === null || ['ENOENT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'].includes(res.error);
  }

  // Full probe. Returns { result, username, cli_version, quota:{remaining_h, reset_sast, ...} | null }
  function probe() {
    const v = call(['--version']);
    const major = cliMajor(v.stdout || v.stderr);
    if (v.error === 'ENOENT') return { result: 'unreachable', detail: 'cli_missing', username: null };
    if (major !== null && major < 2) {
      return { result: 'old_cli', cli_version: (v.stdout || '').trim(), username: null };
    }

    const view = call(['config', 'view']);
    if (unreachableish(view)) return { result: 'unreachable', username: null };
    if (view.status !== 0 || isAuthRequired(view)) return { result: 'unauthenticated', username: null };
    const username = parseUsername(view.stdout);

    const q = call(['quota']);
    if (isForbidden(q)) return { result: 'forbidden', username, cli_version: (v.stdout || '').trim() };
    if (unreachableish(q)) return { result: 'unreachable', username };
    if (q.status !== 0) {
      if (isAuthRequired(q)) return { result: 'unauthenticated', username };
      return { result: 'unreachable', username };
    }

    const row = parseQuotaRow(q.stdout);
    if (!row) return { result: 'quota_empty', username, cli_version: (v.stdout || '').trim(), quota: null };

    return {
      result: 'ok',
      username,
      cli_version: (v.stdout || '').trim(),
      quota: {
        remaining_h: row.gpu_remaining_h,
        used_h: row.gpu_used_h,
        total_h: row.gpu_total_h,
        reset: row.refresh_at,
        reset_sast: formatReset(row.refresh_at),
      },
    };
  }

  return { probe, bin, env: () => childEnv(config) };
}

// ---------------------------------------------------------------------------------------------
// Writing the credential. Atomic, owner-only, never echoed.

function stripToken(v) {
  return String(v == null ? '' : v).replace(/[\r\n\t ]+/g, '').trim();
}

function writeToken(config, token) {
  const clean = stripToken(token);
  if (!clean) return { ok: false, reason: 'empty' };
  if (clean.length < 8) return { ok: false, reason: 'too_short' };

  const home = kaggleHome(config);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(home, 0o700); } catch (e) { /* best effort */ }

  const target = path.join(home, 'access_token');
  const tmp = path.join(home, `.access_token.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, clean);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, 0o600); } catch (e) { /* best effort */ }
  return { ok: true, path: target };
}

// kaggle.json = {username, key}. The CLI 2.x still reads it for the legacy username+key flow.
function writeKaggleJson(config, json) {
  let obj = json;
  if (typeof json === 'string') {
    try { obj = JSON.parse(json); } catch (e) { return { ok: false, reason: 'bad_json' }; }
  }
  if (!obj || !obj.username || !obj.key) return { ok: false, reason: 'bad_json' };

  const home = kaggleHome(config);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(home, 0o700); } catch (e) { /* best effort */ }

  const target = path.join(home, 'kaggle.json');
  const tmp = path.join(home, `.kaggle.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ username: obj.username, key: obj.key }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, 0o600); } catch (e) { /* best effort */ }
  return { ok: true, path: target, username: obj.username };
}

function removeCredentials(config) {
  const home = kaggleHome(config);
  let removed = [];
  for (const f of ['access_token', 'access_token.txt']) {
    const p = path.join(home, f);
    try { fs.unlinkSync(p); removed.push(f); } catch (e) { /* not there */ }
  }
  // Deliberately not removing kaggle.json here: it is a user file that predates this app.
  return { removed };
}

// What already exists, without reading it back to the browser.
function discover(config) {
  const home = kaggleHome(config);
  const found = [];
  for (const f of ['access_token', 'access_token.txt', 'kaggle.json', 'credentials.json']) {
    try {
      const st = fs.statSync(path.join(home, f));
      if (st.isFile()) found.push({ file: f, mode: (st.mode & 0o777).toString(8), bytes: st.size });
    } catch (e) { /* absent */ }
  }
  if (process.env.KAGGLE_API_TOKEN) found.push({ file: 'KAGGLE_API_TOKEN', mode: 'env', bytes: 0 });
  if (process.env.KAGGLE_KEY && process.env.KAGGLE_USERNAME) {
    found.push({ file: 'KAGGLE_USERNAME/KAGGLE_KEY', mode: 'env', bytes: 0 });
  }
  return { home, found };
}

module.exports = {
  TIMEOUT_MS,
  createProbe, writeToken, writeKaggleJson, removeCredentials, discover,
  kaggleHome, kaggleBin, childEnv, parseUsername, parseQuotaRow, formatReset, stripToken, cliMajor,
};
