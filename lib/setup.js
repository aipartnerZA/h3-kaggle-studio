'use strict';

// The first-run state machine. `data/setup.json` is the single source of truth for whether the
// studio is allowed to exist yet. The browser is told the state; it never decides it.
//
// Nothing in this file ever holds, returns or logs the Kaggle token. The token lives only at
// $KAGGLE_HOME/access_token, mode 0600 (see lib/kaggle-auth.js).

const fs = require('fs');
const path = require('path');

const SCHEMA = 1;
const LICENCE_VERSION = 'minimax-h3-2026-08-02';
const TOU_VERSION = '2025-06-22';

const STATES = [
  'new', 'licence_ok', 'ready',
  'token_rejected', 'forbidden', 'quota_empty', 'unreachable', 'old_cli',
  'territory_blocked',
];

// The probe results that mean "a credential exists and Kaggle answered".
const PROBE_OK = new Set(['ok', 'quota_empty']);

function setupPath(base) {
  return path.join(base, 'data', 'setup.json');
}

function blank() {
  return {
    schema: SCHEMA,
    licence_version: LICENCE_VERSION,
    licence_accepted_at: null,
    territory_attested: false,
    kaggle_tou_ack_at: null,
    kaggle_tou_version: TOU_VERSION,
    username: null,
    kaggle_cli_version: null,
    last_probe_at: null,
    last_probe_result: null,
  };
}

function read(base) {
  const p = setupPath(base);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    if (raw.schema !== SCHEMA) return null; // an older schema is re-onboarded, never guessed at
    // Defensive: a token must never have been written here, but if one was, drop it on read.
    delete raw.token;
    delete raw.kaggle_token;
    delete raw.access_token;
    return Object.assign(blank(), raw);
  } catch (e) {
    return null;
  }
}

function write(base, obj) {
  const p = setupPath(base);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.setup.${process.pid}.${Date.now()}.tmp`);
  const data = JSON.stringify(obj, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (e) { /* best effort on odd filesystems */ }
  return obj;
}

// The state the server gates on. Derived, never stored, so it cannot go stale.
function state(base) {
  const s = read(base);
  if (!s) return 'new';
  if (s.territory_blocked) return 'territory_blocked';
  if (!s.licence_accepted_at || !s.kaggle_tou_ack_at || !s.territory_attested) return 'new';
  const probe = s.last_probe_result;
  if (!probe) return 'licence_ok';
  if (probe === 'ok') return 'ready';
  if (probe === 'quota_empty') return 'ready'; // a valid account with no GPU hours is still configured
  if (probe === 'unauthenticated') return 'token_rejected';
  if (probe === 'forbidden') return 'forbidden';
  if (probe === 'unreachable') return 'unreachable';
  if (probe === 'old_cli') return 'old_cli';
  return 'licence_ok';
}

function isReady(base) {
  return state(base) === 'ready';
}

// Called when the user accepts the licence + territory answer + Kaggle terms.
// Returns { ok:true, state } or { ok:false, reason }.
function acceptLicence(base, body) {
  const b = body || {};
  if (b.accepted !== true) return { ok: false, reason: 'licence_not_accepted' };
  if (b.tos_ack !== true) return { ok: false, reason: 'tos_not_acknowledged' };
  if (b.territory !== 'applicable' && b.territory !== 'excluded') {
    return { ok: false, reason: 'territory_not_answered' };
  }

  const now = new Date().toISOString();
  const s = read(base) || blank();

  if (b.territory === 'excluded') {
    // Terminal until they re-attest. Recorded, so a later probe cannot quietly clear it.
    s.territory_attested = false;
    s.territory_blocked = true;
    s.territory_answered = 'excluded';
    s.territory_answered_at = now;
    write(base, s);
    return { ok: true, state: 'territory_blocked' };
  }

  s.licence_version = LICENCE_VERSION;
  s.licence_accepted_at = s.licence_accepted_at || now;
  s.kaggle_tou_version = TOU_VERSION;
  s.kaggle_tou_ack_at = s.kaggle_tou_ack_at || now;
  s.territory_attested = true;
  s.territory_blocked = false;
  s.territory_answered = 'applicable';
  s.territory_answered_at = now;
  write(base, s);
  return { ok: true, state: state(base) };
}

// Record what a probe found. `probe` is an enum result, never raw CLI output.
function recordProbe(base, probe) {
  const s = read(base) || blank();
  s.last_probe_at = new Date().toISOString();
  s.last_probe_result = probe && probe.result ? probe.result : 'unreachable';
  if (probe && probe.username) s.username = probe.username;
  if (probe && probe.cli_version) s.kaggle_cli_version = probe.cli_version;
  if (probe && probe.result === 'unauthenticated') {
    // The credential is gone or was rejected: drop the remembered username, keep the licence.
    s.username = null;
  }
  write(base, s);
  return state(base);
}

// Forget the credential but keep the licence acceptance — the terms do not become untrue when a
// token is removed.
function clearCredential(base) {
  const s = read(base) || blank();
  s.username = null;
  s.last_probe_result = null;
  s.last_probe_at = null;
  write(base, s);
  return state(base);
}

function forgetAll(base) {
  try { fs.unlinkSync(setupPath(base)); } catch (e) { /* already gone */ }
  return 'new';
}

// What the browser is allowed to know.
function publicState(base) {
  const s = read(base) || blank();
  const st = state(base);
  return {
    state: st,
    step: stepFor(st),
    username: st === 'ready' || st === 'licence_ok' ? s.username : null,
    excluded: Boolean(s.territory_blocked),
    licence_version: s.licence_version,
    quota: null, // filled in by the caller from the last probe, never stored here
    setup_min: 0,
  };
}

function stepFor(st) {
  switch (st) {
    case 'new': return 'licence';
    case 'territory_blocked': return 'territory';
    case 'licence_ok': return 'credentials';
    case 'ready': return 'done';
    default: return 'credentials';
  }
}

module.exports = {
  SCHEMA, LICENCE_VERSION, TOU_VERSION, STATES, PROBE_OK,
  setupPath, blank, read, write, state, isReady, acceptLicence, recordProbe,
  clearCredential, forgetAll, publicState, stepFor,
};
