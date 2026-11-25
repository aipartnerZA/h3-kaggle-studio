const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store.js');
const { createWorker } = require('../lib/worker.js');

function env(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-w-'));
  let clock = o.now == null ? Date.parse('2026-11-25T10:00:00Z') : o.now;
  const now = () => clock;
  const advance = (min) => { clock += min * 60000; };
  const calls = { stage: 0, push: 0, poll: 0, collect: 0, publish: 0, done: [] };
  const pipeline = {
    runPath: (tag, ...parts) => path.join(root, 'data', 'runs', tag, ...parts),
    writeDone: (tag, content) => calls.done.push({ tag, content }),
    client: {},
    stage: () => { calls.stage++; return { ok: true, output: 'staged' }; },
    push: () => { calls.push++; return { ok: true, status: 0, output: 'pushed' }; },
    poll: () => { calls.poll++; return o.status || { ok: true, status: 'COMPLETE' }; },
    collect: () => { calls.collect++; return o.collect || { ok: true, status: 0, output: '' }; },
    publish: () => {
      calls.publish++;
      return o.publish || {
        slotResults: [{ n: 1, id: 's1_scene', result: 'ok', wall_seconds: 521,
          file: 's1_scene_vdn.mp4', sheet: 's1_scene_vdn_sheet.png', error: null }],
        rendered: { ok: 1, total: 1 },
        fails: {}, files: [], logTail: [], resultsCount: 1,
      };
    },
  };
  const kaggle = { quota: () => ({ ok: true, gpu_remaining_h: 25.5 }) };
  const worker = createWorker({
    config: Object.assign({ poll_busy_s: 20, queue_wait_warn_min: 90, owner: 'acct',
      kernel_prefix: 'h3-six-', setup_min: 13 }, o.config),
    base: root, store, pipeline, kaggle, now,
    immediate: () => {}, interval: () => null, clearInterval: () => {},
  });
  const request = (tag) => ({
    tag, submitted_at: new Date(now()).toISOString(), submission_id: 'abc',
    note: '', slots: [{ n: 1, id: 's1_scene', prompt: 'a calm lake', seconds: 6, seed: 813001 }],
  });
  const estimate = { frames: 158, render_min: 9, setup_min: 13, total_min: 22, quota_needed_h: 0.4 };
  return { root, worker, calls, now, advance, request, estimate, pipeline, kaggle };
}

function runToEnd(worker, advance, max) {
  for (let i = 0; i < (max || 30); i++) { worker.tick(); advance(1); }
}

test('a submission drives QUEUED -> DONE and closes the run', () => {
  const e = env();
  const state = e.worker.submit(e.request('ui-test'), e.estimate, { gpu_remaining_h: 25.5 });
  assert.equal(state.phase, 'QUEUED');
  runToEnd(e.worker, e.advance);
  const done = store.readState(e.root, 'ui-test');
  assert.equal(done.phase, 'DONE');
  assert.equal(done.kernel_ref, 'acct/h3-six-ui-test');
  assert.deepEqual(done.totals, { ok: 1, failed: 0 });
  assert.equal(done.slots[0].file, 's1_scene_vdn.mp4');
  assert.equal(done.slots[0].result, 'ok');
  assert.equal(e.calls.stage, 1);
  assert.equal(e.calls.push, 1);
  assert.equal(e.calls.collect, 1);
  assert.ok(e.calls.done.some((d) => d.tag === 'ui-test'));
  assert.equal(store.readActive(e.root), null);
  assert.equal(e.worker.getActive(), null);
});

test('a COMPLETE kernel with no usable clip is FAILED, never DONE', () => {
  const e = env({
    publish: {
      slotResults: [{ n: 1, id: 's1_scene', result: 'failed', error: 'node exploded', file: null }],
      rendered: { ok: 0, total: 1 }, fails: { s1_scene: 'node exploded' },
      files: [], logTail: [], resultsCount: 0,
    },
  });
  e.worker.submit(e.request('ui-test'), e.estimate, { gpu_remaining_h: 25.5 });
  runToEnd(e.worker, e.advance);
  const done = store.readState(e.root, 'ui-test');
  assert.equal(done.phase, 'FAILED');
  assert.match(done.error, /node exploded/);
  assert.equal(done.totals.ok, 0);
});

test('a full disk during download fails with the df numbers (FL8)', () => {
  const message = 'not enough disk (10 MB free, needed ~500 MB).';
  const e = env({ collect: { ok: false, disk: true, error: message, output: '' } });
  e.worker.submit(e.request('ui-test'), e.estimate, { gpu_remaining_h: 25.5 });
  runToEnd(e.worker, e.advance);
  const s = store.readState(e.root, 'ui-test');
  assert.equal(s.phase, 'FAILED');
  assert.equal(s.error, message);
  assert.equal(e.calls.publish, 0, 'no publish after a disk refusal');
});

test('boot recovery resumes a pre-push run from STAGING', () => {
  const e = env();
  e.worker.submit(e.request('ui-test'), e.estimate, { gpu_remaining_h: 25.5 });
  store.writeState(e.root, 'ui-test', Object.assign(store.readState(e.root, 'ui-test'), { phase: 'BUILDING' }));
  store.writeActive(e.root, { tag: 'ui-test', since: new Date(e.now()).toISOString() });
  e.worker.boot();
  assert.equal(store.readState(e.root, 'ui-test').phase, 'DONE');
});

test('boot recovery adopts a pushed run and verifies it via the CLI', () => {
  const e = env();
  e.worker.submit(e.request('ui-test'), e.estimate, { gpu_remaining_h: 25.5 });
  store.writeState(e.root, 'ui-test', Object.assign(store.readState(e.root, 'ui-test'), {
    phase: 'RENDERING', pushed_at: new Date(e.now()).toISOString(),
  }));
  store.writeActive(e.root, { tag: 'ui-test', since: new Date(e.now()).toISOString() });
  e.worker.boot();
  assert.equal(store.readState(e.root, 'ui-test').phase, 'DONE');
  assert.ok(e.calls.poll >= 1);
});

test('cancel works before push and conflicts after', () => {
  const e = env();
  e.worker.submit(e.request('ui-test'), e.estimate, { gpu_remaining_h: 25.5 });
  const r = e.worker.cancel('ui-test');
  assert.equal(r.ok, true);
  assert.equal(store.readState(e.root, 'ui-test').phase, 'CANCELLED');
  assert.equal(store.readActive(e.root), null);
  assert.equal(store.readState(e.root, 'ui-test').quota_after.gpu_remaining_h, 25.5);

  const e2 = env();
  e2.worker.submit(e2.request('ui-test'), e2.estimate, { gpu_remaining_h: 25.5 });
  store.writeState(e2.root, 'ui-test', Object.assign(store.readState(e2.root, 'ui-test'), {
    phase: 'RENDERING', pushed_at: new Date(e2.now()).toISOString(),
  }));
  const r2 = e2.worker.cancel('ui-test');
  assert.equal(r2.conflict, true);
});

test('FL6: an unreadable status older than 30 min fails with kaggle CLI unreachable', () => {
  const e = env({ status: { ok: false, status: null, error: '401 Unauthorized' } });
  e.worker.submit(e.request('ui-test'), e.estimate, { gpu_remaining_h: 25.5 });
  store.writeState(e.root, 'ui-test', Object.assign(store.readState(e.root, 'ui-test'), {
    phase: 'RENDERING', pushed_at: new Date(e.now()).toISOString(),
    kaggle_status: 'RUNNING',
    kaggle_status_at: new Date(e.now() - 31 * 60000).toISOString(),
  }));
  e.worker.tick();
  const st = store.readState(e.root, 'ui-test');
  assert.equal(st.phase, 'FAILED');
  assert.equal(st.error, 'kaggle CLI unreachable');
});

test('FL3: a long queue produces the honest notice, not a fake ETA', () => {
  const e = env({ status: { ok: true, status: 'QUEUED' } });
  e.worker.submit(e.request('ui-test'), e.estimate, { gpu_remaining_h: 25.5 });
  for (let i = 0; i < 10 && store.readState(e.root, 'ui-test').phase !== 'GPU_QUEUED'; i++) {
    e.worker.tick();
  }
  e.advance(91);
  e.worker.tick();
  const st = store.readState(e.root, 'ui-test');
  assert.equal(st.phase, 'GPU_QUEUED');
  assert.match(st.queue_notice, /no published ETA/);
});
