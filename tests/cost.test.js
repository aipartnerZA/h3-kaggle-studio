const test = require('node:test');
const assert = require('node:assert/strict');
const cost = require('../lib/cost.js');

test('snapFrames: 6..15 matches the spec table', () => {
  const expected = { 6: 158, 7: 175, 8: 192, 9: 226, 10: 243, 11: 277, 12: 294, 13: 328, 14: 345, 15: 362 };
  for (let s = 6; s <= 15; s++) {
    assert.equal(cost.snapFrames(s), expected[s], `slot ${s}s`);
  }
});

test('snapFrames: nothing below 6 is reachable; floor at 5 frames min', () => {
  assert.equal(cost.snapFrames(1), 39); // max(5,24) then snap up to 39
  assert.equal(cost.snapFrames(0), 5);
  assert.equal(cost.snapFrames(5 / 24), 5);
});

test('actualSeconds', () => {
  assert.equal(cost.actualSeconds(158), 158 / 24);
  assert.equal(Math.round(cost.actualSeconds(362) * 1000) / 1000, 15.083);
});

test('renderMinutesForFrames ~3.3s per frame', () => {
  assert.ok(Math.abs(cost.renderMinutesForFrames(158, 3.3) - 8.69) < 0.01);
  assert.ok(Math.abs(cost.renderMinutesForFrames(362, 3.3) - 19.91) < 0.01);
});

test('frameTable has 10 rows 6..15 with snapped labels', () => {
  const t = cost.frameTable();
  assert.equal(t.length, 10);
  assert.equal(t[0].seconds, 6);
  assert.equal(t[9].seconds, 15);
  assert.equal(t[1].frames, 175);
  assert.equal(t[1].actual_seconds, 175 / 24);
});

test('estimate for the Phase 6.2 batch', () => {
  const e = cost.estimate([6, 7, 8, 9, 10, 11], { seconds_per_frame: 3.3, setup_min: 13 });
  assert.equal(e.frames, 1271);
  assert.equal(e.render_min, 70);
  assert.equal(e.setup_min, 13);
  assert.equal(e.total_min, 83);
  assert.equal(e.quota_needed_h, 1.4);
});

test('estimate accepts slot objects', () => {
  const e = cost.estimate([{ seconds: 15 }, { seconds: 15 }], { setup_min: 13 });
  assert.equal(e.frames, 724);
});

test('quotaOk', () => {
  assert.equal(cost.quotaOk(25.5, 1.4, 1.0), true);
  assert.equal(cost.quotaOk(2.0, 1.4, 1.0), false);
  assert.equal(cost.quotaOk(2.3, 1.4, 1.0), false);
  assert.equal(cost.quotaOk(2.5, 1.4, 1.0), true);
});