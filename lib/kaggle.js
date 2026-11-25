'use strict';

// Thin wrappers around the kaggle CLI. All parsing is pure and fixture-testable;
// command execution is injectable so tests never touch the real account.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function defaultRunner(cmd, args, opts) {
  return spawnSync(cmd, args, opts);
}

// `owner/h3-six-x has status "KernelWorkerStatus.COMPLETE"`
function parseStatus(text) {
  const raw = String(text || '');
  let m = raw.match(/KernelWorkerStatus\.([A-Za-z_]+)/);
  if (!m) m = raw.match(/status\s+["']?([A-Z][A-Z_]+)["']?/);
  if (!m) return { status: null, ok: false, raw };
  return { status: m[1].toUpperCase(), ok: true, raw };
}

// `GPU  4.50h  25.50h  30.00h  2026-11-28T00:00:00+00:00`
function parseQuota(text) {
  const raw = String(text || '');
  const line = raw.split(/\r?\n/).find((l) => /^\s*GPU\b/.test(l));
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
    raw,
  };
}

// `kaggle config view` prints `- username: <user>` once a credential exists.
function parseUsername(text) {
  const m = String(text || '').match(/^\s*-\s*username:\s*([A-Za-z0-9_.-]+)\s*$/m);
  return m ? m[1] : null;
}

// A deleted kernel and an unreachable CLI both exit non-zero, but only one of
// them means the run is over. The API answers 404 with "Not Found" for a kernel
// that no longer exists; a network or auth fault does not.
function looksGone(text) {
  const raw = String(text || '');
  if (/\b404\b/.test(raw)) return true;
  if (/not found/i.test(raw)) return true;
  if (/no such kernel|does not exist|unknown kernel/i.test(raw)) return true;
  return false;
}

// The box clock is UTC; users read SAST (UTC+2). No locale/ICU dependency.
function formatSast(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + 2 * 3600 * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${hh}:${mm} SAST`;
}

function isExecutableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

const INSTALL_HINT = 'Install it with "pip install kaggle" or "uv tool install kaggle".';

// config.kaggle_bin → H3UI_KAGGLE_BIN → `kaggle` on PATH (SPEC §7.3).
function resolveBin(config, env) {
  const e = env || process.env;
  const cfgBin = String((config && config.kaggle_bin) || '');
  const envBin = String(e.H3UI_KAGGLE_BIN || '');
  const wanted = cfgBin || envBin || 'kaggle';
  const source = cfgBin ? 'config.kaggle_bin' : (envBin ? 'H3UI_KAGGLE_BIN' : 'PATH');
  const hasDir = wanted.includes('/') || wanted.includes('\\');
  const tried = [];
  if (hasDir) {
    tried.push(path.resolve(wanted));
  } else {
    for (const dir of String(e.PATH || '').split(path.delimiter)) {
      if (dir) tried.push(path.join(dir, wanted));
    }
  }
  for (const candidate of tried) {
    if (isExecutableFile(candidate)) return { ok: true, bin: candidate, source, tried };
  }
  return {
    ok: false,
    bin: null,
    source,
    tried,
    error: `the kaggle CLI was not found (looked for "${wanted}" via ${source}). `
      + INSTALL_HINT
      + ' Or point config.kaggle_bin / H3UI_KAGGLE_BIN at an executable.',
  };
}

// Child env for every kaggle/engine call: KAGGLE_HOME when configured, and the
// binary's own directory on PATH so shell scripts reuse the same executable.
function childEnv(config, bin) {
  const env = Object.assign({}, process.env);
  if (config && config.kaggle_home) env.KAGGLE_HOME = config.kaggle_home;
  const b = bin || (config && config.kaggle_bin) || 'kaggle';
  if (b.includes('/') || b.includes('\\')) {
    const dir = path.dirname(b);
    if (dir && dir !== '.') env.PATH = dir + path.delimiter + (env.PATH || '');
  }
  return env;
}

function createClient(config, deps) {
  const cfg = config || {};
  const runner = (deps && deps.run) || defaultRunner;
  const bin = cfg.kaggle_bin || (deps && deps.bin) || 'kaggle';
  const cwd = cfg.engine_dir || cfg.cwd || process.cwd();

  function exec(args, opts) {
    const env = childEnv(cfg, bin);
    let r;
    try {
      r = runner(bin, args, Object.assign({
        cwd, env, encoding: 'utf8', timeout: 60 * 1000,
      }, opts || {}));
    } catch (e) {
      return { status: -1, stdout: '', stderr: String(e), error: String(e) };
    }
    if (r && r.error) {
      return { status: -1, stdout: r.stdout || '', stderr: String(r.error), error: String(r.error) };
    }
    return {
      status: r && r.status != null ? r.status : -1,
      stdout: (r && r.stdout) || '',
      stderr: (r && r.stderr) || '',
    };
  }

  function username() {
    const r = exec(['config', 'view']);
    if (r.status !== 0) return null;
    return parseUsername(r.stdout + r.stderr);
  }

  // config.owner wins; otherwise ask the CLI once.
  let ownerCache = cfg.owner || null;
  function owner() {
    if (!ownerCache) ownerCache = username();
    return ownerCache || null;
  }

  return {
    exec,
    username,
    owner,

    auth() {
      const r = exec(['config', 'view']);
      return r.status === 0;
    },

    status(ref, opts) {
      const r = exec(['kernels', 'status', ref], opts);
      const text = r.stdout + r.stderr;
      if (r.status !== 0) {
        return {
          ok: false, status: null, gone: looksGone(text),
          error: text.trim() || 'kaggle status failed', raw: text,
        };
      }
      const p = parseStatus(text);
      if (!p.ok) return { ok: false, status: null, gone: false, error: 'unparseable status: ' + text.trim(), raw: text };
      return { ok: true, status: p.status, gone: false, raw: text };
    },

    // Kaggle's API offers no "stop" — deleting the kernel is the only thing that
    // ends a queued or running session, and it is exactly what deleting it on
    // kaggle.com does. `gone` means it was already deleted, which is not a failure.
    delete(ref, opts) {
      const r = exec(['kernels', 'delete', ref, '-y'],
        Object.assign({ timeout: 60 * 1000 }, opts || {}));
      const text = (r.stdout + r.stderr).trim();
      const gone = r.status !== 0 && looksGone(text);
      return {
        ok: r.status === 0, gone, status: r.status,
        error: r.status === 0 ? null : (text || 'kaggle kernels delete failed'),
        output: text,
      };
    },

    quota() {
      const r = exec(['quota']);
      if (r.status !== 0) {
        return { ok: false, error: (r.stderr || r.stdout).trim() || 'kaggle quota failed' };
      }
      const q = parseQuota(r.stdout + r.stderr);
      if (!q) return { ok: false, error: 'no GPU row in kaggle quota output' };
      q.ok = true;
      q.refresh_sast = formatSast(q.refresh_at);
      return q;
    },

    output(ref, dest, opts) {
      const r = exec(['kernels', 'output', ref, '-p', dest],
        Object.assign({ timeout: 10 * 60 * 1000 }, opts || {}));
      return {
        ok: r.status === 0,
        status: r.status,
        output: (r.stdout + r.stderr).trim(),
      };
    },

    listLive(user) {
      const who = user || owner();
      if (!who) return [];
      const r = exec(['kernels', 'list', '-m', '--user=' + who]);
      if (r.status !== 0) return [];
      const prefix = String(cfg.kernel_prefix || 'h3-six-');
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('[A-Za-z0-9][A-Za-z0-9._-]*/' + escaped + '[A-Za-z0-9._-]+', 'g');
      return r.stdout.match(re) || [];
    },
  };
}

module.exports = {
  parseStatus, parseQuota, parseUsername, formatSast, looksGone,
  resolveBin, childEnv, createClient, INSTALL_HINT,
};
