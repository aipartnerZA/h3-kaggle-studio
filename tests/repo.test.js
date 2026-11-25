const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createPipeline } = require('../lib/pipeline.js');

const appDir = path.resolve(__dirname, '..');

// Split at runtime so this file itself never contains the literals it forbids:
// the release tree must be free of the previous operator's name and host paths.
const BANNED = [
  'wesa' + 'ipartner',
  '/root/apps/h3' + '-kaggle',
  '/srv' + '/storage',
  '/root' + '/.local',
  'aipartner' + '.co.za',
];

// scripts/** is being rewritten by the release gates separately (the P1 brief
// forbids touching it), so this scan covers everything the studio really ships
// and executes: engine, lib, public, server.js, tests and config.
const SKIP_DIRS = new Set(['.git', 'data', 'node_modules', 'scripts', '__pycache__']);
// The P5 CI workflow carries the forbidden strings as its own leak-check pattern,
// i.e. it is the negative fixture; it belongs to another phase's file manifest.
const SKIP_FILES = new Set([path.join('.github', 'workflows', 'ci.yml')]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('kernel_')) {
        walk(path.join(dir, entry.name), out);
      }
    } else if (entry.isFile()) {
      const full = path.join(dir, entry.name);
      if (entry.name.endsWith('.pyc')) continue;
      if (!SKIP_FILES.has(path.relative(appDir, full))) out.push(full);
    }
  }
  return out;
}

test('the engine root resolves inside this repo', () => {
  const p = createPipeline({ kaggle_bin: 'kaggle' }, appDir, { exec: () => ({ status: 0 }) });
  assert.equal(p.engineDir, path.join(appDir, 'engine'));
  assert.ok(p.engineDir.startsWith(appDir + path.sep));
  for (const name of ['stage_shot.py', 'prep_still.sh', 'run_six.sh', 'collect_run.sh',
    'build_pro.py', 'build_kernel.py', 'h3_pro_node.py', 'pro_tail.py', 'verify_run.py']) {
    assert.ok(fs.existsSync(path.join(p.engineDir, name)), `${name} missing from engine/`);
  }
});

test('no shipped file names the previous operator, host path or delivery target', () => {
  const hits = [];
  for (const file of walk(appDir, [])) {
    const text = fs.readFileSync(file, 'utf8');
    for (const needle of BANNED) {
      if (text.includes(needle)) hits.push(`${path.relative(appDir, file)}: ${needle}`);
    }
  }
  assert.deepEqual(hits, []);
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
