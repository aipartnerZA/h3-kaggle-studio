const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPipeline } = require('../lib/pipeline.js');

const appDir = path.resolve(__dirname, '..');

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-p-'));
  const engine = path.join(root, 'engine');
  fs.mkdirSync(engine, { recursive: true });
  return { root, engine };
}

function cfg(engine) {
  return { engine_dir: engine, kaggle_bin: 'kaggle', owner: 'acct', kernel_prefix: 'h3-six-' };
}

test('stage runs reset then one idempotent call per slot, with --no-image omitted correctly', () => {
  const { root, engine } = tmp();
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const p = createPipeline(cfg(engine), root, { exec });
  const slots = [
    { n: 1, id: 's1_scene', prompt: 'one', seconds: 6, image: 'images/s1_scene.jpg' },
    { n: 2, id: 's2_scene', prompt: 'two', seconds: 15, image: null },
  ];
  const r = p.stage('ui-test', slots);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, ['stage_shot.py', '--tag', 'ui-test', '--reset']);
  assert.equal(calls[0].opts.cwd, engine);
  assert.equal(calls[0].opts.env.H3_ENGINE_ROOT, engine);
  assert.equal(calls[0].opts.env.KAGGLE_OWNER, 'acct');
  assert.equal(calls[0].opts.env.KERNEL_PREFIX, 'h3-six-');
  assert.ok(calls[1].args.includes('--seconds'));
  assert.ok(calls[1].args.includes('6'));
  assert.ok(calls[1].args.includes('--image'));
  assert.ok(calls[1].args.includes('--seed'));
  assert.ok(calls[1].args.includes('813001'));
  assert.ok(!calls[2].args.includes('--image'));
  assert.ok(calls[2].args.includes('813002'));
  assert.equal(fs.readFileSync(p.runPath('ui-test', 'slot2.txt'), 'utf8').trim(), 'two');
});

test('stage surfaces a failed script', () => {
  const { root, engine } = tmp();
  const p = createPipeline(cfg(engine), root, {
    exec: () => ({ status: 2, stdout: '', stderr: 'boom' }),
  });
  const r = p.stage('ui-test', [{ n: 1, id: 's1_scene', prompt: 'x', seconds: 6 }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /boom/);
});

test('push captures the log and the verbatim PREFLIGHT FAIL line', () => {
  const { root, engine } = tmp();
  const calls = [];
  const p = createPipeline(cfg(engine), root, {
    exec: (cmd, args) => {
      calls.push(args);
      return { status: 3, stdout: '', stderr: 'PREFLIGHT FAIL: quota too low' };
    },
  });
  const r = p.push('ui-test');
  assert.equal(r.ok, false);
  assert.equal(r.status, 3);
  assert.equal(r.preflight, 'PREFLIGHT FAIL: quota too low');
  assert.deepEqual(calls[0], ['ui-test', '--no-wait']);
  assert.match(fs.readFileSync(p.runPath('ui-test', 'logs', 'push.log'), 'utf8'), /PREFLIGHT FAIL/);
});

test('collect uses flock -n on the app lock and --no-pi unconditionally', () => {
  const { root, engine } = tmp();
  let args;
  const p = createPipeline(cfg(engine), root, {
    exec: (cmd, a) => { args = { cmd, a }; return { status: 0, stdout: '', stderr: '' }; },
  });
  const r = p.collect('ui-test');
  assert.equal(r.ok, true);
  assert.equal(args.cmd, 'flock');
  assert.equal(args.a[0], '-n');
  assert.match(args.a[1], /data\/locks\/ui-test\.lock$/);
  assert.deepEqual(args.a.slice(2), ['./collect_run.sh', 'ui-test', '--no-pi']);
});

test('collect refuses a download that will not fit (FL8)', () => {
  const { root, engine } = tmp();
  const p = createPipeline(cfg(engine), root, {
    exec: () => ({ status: 0, stdout: '', stderr: '' }),
    freeBytes: () => 10 * 1048576,
  });
  const r = p.collect('ui-test', { needBytes: 500 * 1048576 });
  assert.equal(r.ok, false);
  assert.equal(r.disk, true);
  assert.equal(r.error, 'not enough disk (10 MB free, needed ~500 MB).');
});

test('publish reads results.json + kernel log and flattens clips into the served out dir', () => {
  const { root, engine } = tmp();
  const p = createPipeline(cfg(engine), root, { exec: () => ({ status: 0 }) });
  const src = p.runPath('ui-test', 'raw', 'out_probe');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'probe_results.json'), JSON.stringify([{
    id: 's1_scene', wall_seconds: 521.4,
    files: ['/kaggle/working/out_probe/s1_scene_vdn.mp4'],
    summary: { frames: 158 },
  }]));
  fs.writeFileSync(path.join(src, 's1_scene_vdn.mp4'), 'VIDEO');
  fs.writeFileSync(path.join(src, 's1_scene_vdn_sheet.png'), 'PNG');
  fs.writeFileSync(p.runPath('ui-test', 'raw', 'h3-six-ui-test.log'),
    'some noise\n  PROBE RENDERED 1/1   total wall 9.0 min\n');

  const request = { slots: [{ n: 1, id: 's1_scene', seconds: 6 }] };
  const pub = p.publish('ui-test', request);
  assert.equal(pub.resultsCount, 1);
  assert.deepEqual(pub.rendered, { ok: 1, total: 1 });
  assert.equal(pub.slotResults[0].result, 'ok');
  assert.equal(pub.slotResults[0].wall_seconds, 521.4);
  assert.equal(pub.slotResults[0].file, 's1_scene_vdn.mp4');
  assert.equal(pub.slotResults[0].sheet, 's1_scene_vdn_sheet.png');
  assert.ok(fs.existsSync(p.runPath('ui-test', 'out', 's1_scene_vdn.mp4')));
  assert.ok(pub.logTail.some((l) => l.includes('PROBE RENDERED')));
});

test('publish uses FAIL rows, not COMPLETE, to mark a slot failed', () => {
  const { root, engine } = tmp();
  const p = createPipeline(cfg(engine), root, { exec: () => ({ status: 0 }) });
  const src = p.runPath('ui-test', 'raw');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'ui-test_results.json'), JSON.stringify([{
    id: 's1_scene', error: 'node exploded', files: [],
  }]));
  fs.writeFileSync(path.join(src, 'h3-six-ui-test.log'),
    'PROBE RENDERED 0/1\n  FAIL s1_scene node exploded\n');
  const pub = p.publish('ui-test', { slots: [{ n: 1, id: 's1_scene', seconds: 6 }] });
  assert.equal(pub.slotResults[0].result, 'failed');
  assert.match(pub.fails.s1_scene, /node exploded/);
});

test('every run artefact resolves under data/runs and the engine root is inside the repo', () => {
  const engine = path.join(appDir, 'engine');
  const p = createPipeline({ kaggle_bin: 'kaggle' }, appDir, { exec: () => ({ status: 0 }) });
  assert.equal(p.engineDir, engine);
  assert.ok(p.engineDir.startsWith(appDir + path.sep));
  assert.equal(p.outDir('t'), path.join(appDir, 'data', 'runs', 't', 'raw'));
  assert.equal(p.servedDir('t'), path.join(appDir, 'data', 'runs', 't', 'out'));
  assert.equal(p.donePath('t'), path.join(appDir, 'data', 'runs', 't', 'done'));
  assert.equal(p.runPath('t', 'queue'), path.join(appDir, 'data', 'runs', 't', 'queue'));
});
