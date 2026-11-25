'use strict';

const fs = require('fs');
const path = require('path');

function dataDir(base) { return path.join(base, 'data'); }
function runsDir(base) { return path.join(dataDir(base), 'runs'); }
function locksDir(base) { return path.join(dataDir(base), 'locks'); }
function runDir(base, tag) { return path.join(runsDir(base), tag); }
function activePath(base) { return path.join(dataDir(base), 'active.json'); }

function ensureDirs(base) {
  for (const d of [dataDir(base), runsDir(base), locksDir(base)]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  const data = JSON.stringify(obj, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, filePath);
}

function ensureRun(base, tag) {
  const rd = runDir(base, tag);
  for (const sub of ['', 'images', 'raw', 'out', 'logs']) {
    fs.mkdirSync(path.join(rd, sub), { recursive: true });
  }
  return rd;
}

function requestPath(base, tag) { return path.join(runDir(base, tag), 'request.json'); }
function statePath(base, tag) { return path.join(runDir(base, tag), 'state.json'); }

function readRequest(base, tag) { return readJson(requestPath(base, tag)); }
function writeRequest(base, tag, obj) { ensureRun(base, tag); writeAtomic(requestPath(base, tag), obj); }
function readState(base, tag) { return readJson(statePath(base, tag)); }
function writeState(base, tag, obj) { ensureRun(base, tag); writeAtomic(statePath(base, tag), obj); }

function readActive(base) { return readJson(activePath(base)); }
function writeActive(base, lease) { ensureDirs(base); writeAtomic(activePath(base), lease); }
function clearActive(base) {
  try { fs.unlinkSync(activePath(base)); } catch (e) { /* ignore */ }
}

function listRunTags(base) {
  const rd = runsDir(base);
  try {
    return fs.readdirSync(rd, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (e) {
    return [];
  }
}

function bootInventory(base) {
  ensureDirs(base);
  const active = readActive(base);
  const runs = listRunTags(base).map((tag) => {
    const st = readState(base, tag);
    return { tag, phase: st ? st.phase : null, state: st };
  });
  return { active, runs };
}

// Remove run dirs beyond keepRuns (by mtime, oldest first). Returns removed tags.
function prune(base, keepRuns) {
  const keep = (keepRuns == null) ? 40 : keepRuns;
  const tags = listRunTags(base);
  if (tags.length <= keep) return [];
  // sort by state submitted_at or dir mtime
  const withTime = tags.map((t) => {
    const st = readState(base, t);
    const mtime = fs.statSync(runDir(base, t)).mtimeMs;
    return { tag: t, t: (st && st.submitted_at) ? Date.parse(st.submitted_at) : mtime };
  }).sort((a, b) => a.t - b.t);
  const toRemove = withTime.slice(0, withTime.length - keep);
  const removed = [];
  for (const r of toRemove) {
    try {
      fs.rmSync(runDir(base, r.tag), { recursive: true, force: true });
      removed.push(r.tag);
    } catch (e) { /* ignore */ }
  }
  return removed;
}

module.exports = {
  dataDir, runsDir, locksDir, runDir, activePath,
  ensureDirs, ensureRun,
  readJson, writeAtomic,
  requestPath, statePath,
  readRequest, writeRequest, readState, writeState,
  readActive, writeActive, clearActive,
  listRunTags, bootInventory, prune,
};