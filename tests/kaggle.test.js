const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const k = require('../lib/kaggle.js');

test('parseStatus reads the CLI line', () => {
  const s = k.parseStatus('acct/h3-six-ui-1 has status "KernelWorkerStatus.COMPLETE"\n');
  assert.equal(s.ok, true);
  assert.equal(s.status, 'COMPLETE');
});

test('parseStatus handles QUEUED, RUNNING, ERROR and CANCEL_ACKNOWLEDGED', () => {
  for (const raw of ['QUEUED', 'RUNNING', 'ERROR', 'CANCEL_ACKNOWLEDGED']) {
    const s = k.parseStatus(`kernel has status "KernelWorkerStatus.${raw}"`);
    assert.equal(s.status, raw);
  }
});

test('parseStatus rejects unparseable output', () => {
  const s = k.parseStatus('some random CLI noise');
  assert.equal(s.ok, false);
  assert.equal(s.status, null);
});

test('parseQuota reads the real GPU row', () => {
  const text = [
    'resource  used   remaining  total   refreshAt',
    '--------  -----  ---------  ------  -------------------------',
    'GPU       4.50h  25.50h     30.00h  2026-11-28T00:00:00+00:00',
    'TPU       0.00h  20.00h     20.00h  2026-11-28T00:00:00+00:00',
  ].join('\n');
  const q = k.parseQuota(text);
  assert.equal(q.gpu_used_h, 4.5);
  assert.equal(q.gpu_remaining_h, 25.5);
  assert.equal(q.gpu_total_h, 30);
  assert.equal(q.refresh_at, '2026-11-28T00:00:00+00:00');
});

test('parseQuota returns null with no GPU row', () => {
  assert.equal(k.parseQuota('resource used\nTPU 0.00h 20.00h'), null);
});

test('formatSast converts UTC to SAST without ICU', () => {
  assert.equal(k.formatSast('2026-11-28T00:00:00+00:00'), 'Sat 02:00 SAST');
  assert.equal(k.formatSast(null), null);
});

test('parseUsername reads the config view line, never a token', () => {
  assert.equal(k.parseUsername('path: /home/u/.kaggle\n- username: acct\n'), 'acct');
  assert.equal(k.parseUsername('Authentication required to call the Kaggle API.'), null);
});

test('resolveBin prefers config, then env, then PATH, and explains a miss', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-bin-'));
  const bin = path.join(root, 'kaggle');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(k.resolveBin({ kaggle_bin: bin }, { PATH: '' }).bin, bin);
  assert.equal(k.resolveBin({}, { H3UI_KAGGLE_BIN: bin, PATH: '' }).bin, bin);
  assert.equal(k.resolveBin({}, { PATH: root }).bin, bin);

  const plain = path.join(root, 'not-executable');
  fs.writeFileSync(plain, 'nope\n', { mode: 0o644 });
  assert.equal(k.resolveBin({ kaggle_bin: plain }, { PATH: '' }).ok, false);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'h3ui-nobin-'));
  const miss = k.resolveBin({}, { PATH: empty });
  assert.equal(miss.ok, false);
  assert.equal(miss.bin, null);
  assert.match(miss.error, /pip install kaggle/);
  assert.match(miss.error, /uv tool install kaggle/);
});

test('createClient uses the configured binary path and parses status/quota', () => {
  const calls = [];
  const run = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (args[0] === 'quota') {
      return { status: 0, stdout: 'GPU 4.50h 25.50h 30.00h 2026-11-28T00:00:00+00:00', stderr: '' };
    }
    return { status: 0, stdout: 'k has status "KernelWorkerStatus.RUNNING"', stderr: '' };
  };
  const c = k.createClient({ kaggle_bin: '/opt/kaggle/bin/kaggle', engine_dir: '/tmp' }, { run });
  const st = c.status('acct/h3-six-x');
  assert.equal(st.status, 'RUNNING');
  assert.deepEqual(calls[0].args, ['kernels', 'status', 'acct/h3-six-x']);
  assert.match(calls[0].opts.env.PATH, /^\/opt\/kaggle\/bin:/);
  const q = c.quota();
  assert.equal(q.gpu_remaining_h, 25.5);
  assert.equal(q.refresh_sast, 'Sat 02:00 SAST');
});

test('createClient reports a failed status as stale, not a status', () => {
  const c = k.createClient({ kaggle_bin: 'kaggle' }, {
    run: () => ({ status: 1, stdout: '', stderr: '401 Unauthorized' }),
  });
  const st = c.status('x');
  assert.equal(st.ok, false);
  assert.equal(st.status, null);
  assert.match(st.error, /401/);
});

test('username drives listLive; no owner means no live list and no query', () => {
  const calls = [];
  const run = (bin, args) => {
    calls.push(args);
    if (args[0] === 'config') {
      return { status: 0, stdout: 'path: /home/u/.kaggle\n- username: acct\n', stderr: '' };
    }
    return { status: 0, stdout: 'acct/h3-six-a acct/h3-six-b\n', stderr: '' };
  };
  const c = k.createClient({ kaggle_bin: 'kaggle' }, { run });
  assert.equal(c.username(), 'acct');
  assert.deepEqual(c.listLive(), ['acct/h3-six-a', 'acct/h3-six-b']);
  assert.deepEqual(calls[calls.length - 1], ['kernels', 'list', '-m', '--user=acct']);

  const bare = k.createClient({ kaggle_bin: 'kaggle' }, {
    run: () => ({ status: 1, stdout: '', stderr: 'Authentication required' }),
  });
  assert.deepEqual(bare.listLive(), []);
});

test('a status that says the kernel does not exist is flagged gone, a fault is not', () => {
  assert.equal(k.looksGone('404 Client Error: Not Found for url: https://api.kaggle.com/...'), true);
  assert.equal(k.looksGone('The resource was not found.'), true);
  assert.equal(k.looksGone('401 Unauthorized'), false);
  assert.equal(k.looksGone('500 Server Error: This is a problem on Kaggle\'s side'), false);
  assert.equal(k.looksGone(''), false);
});

test('createClient marks a 404 status read as gone', () => {
  const c = k.createClient({ kaggle_bin: 'kaggle' }, {
    run: () => ({
      status: 1, stdout: '',
      stderr: '404 Client Error: Not Found for url: https://api.kaggle.com/v1/kernels/sessions\n\nThe resource was not found.',
    }),
  });
  const st = c.status('acct/h3-six-ui-1');
  assert.equal(st.ok, false);
  assert.equal(st.gone, true);
  assert.match(st.error, /404/);
});

test('delete asks the CLI to delete the kernel without a prompt', () => {
  const calls = [];
  const c = k.createClient({ kaggle_bin: 'kaggle' }, {
    run: (bin, args) => {
      calls.push(args);
      return { status: 0, stdout: 'Kernel acct/h3-six-ui-1 deleted successfully\n', stderr: '' };
    },
  });
  const r = c.delete('acct/h3-six-ui-1');
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], ['kernels', 'delete', 'acct/h3-six-ui-1', '-y']);
});

test('delete on an already deleted kernel is gone, not an error to show', () => {
  const c = k.createClient({ kaggle_bin: 'kaggle' }, {
    run: () => ({ status: 1, stdout: '', stderr: '404 Client Error: Not Found for url: ...' }),
  });
  const r = c.delete('acct/h3-six-ui-1');
  assert.equal(r.ok, false);
  assert.equal(r.gone, true);
});

test('delete reports a permission failure as an error worth showing', () => {
  const c = k.createClient({ kaggle_bin: 'kaggle' }, {
    run: () => ({ status: 1, stdout: '', stderr: '403 Client Error: Forbidden for url: ...' }),
  });
  const r = c.delete('acct/h3-six-ui-1');
  assert.equal(r.ok, false);
  assert.equal(r.gone, false);
  assert.match(r.error, /403/);
});
