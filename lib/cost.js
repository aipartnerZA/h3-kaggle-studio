'use strict';

// Pure cost maths for the H3 render UI. No I/O, no deps.
// Formulas come from SPEC §6.

const DEFAULTS = {
  seconds_per_frame: 3.3,
  setup_min: 13,
  quota_margin_h: 1.0,
};

// frames = max(5, round(seconds*24)), then snapped UP to the next 17n+5.
function snapFrames(seconds) {
  const base = Math.max(5, Math.round(seconds * 24));
  const n = Math.ceil((base - 5) / 17);
  return 17 * n + 5;
}

function actualSeconds(frames) {
  return frames / 24;
}

function renderMinutesForFrames(frames, secondsPerFrame) {
  const spf = (secondsPerFrame == null) ? DEFAULTS.seconds_per_frame : secondsPerFrame;
  return (frames * spf) / 60;
}

// Build the 10-row frame table for 6..15 s.
function frameTable(secondsPerFrame) {
  const spf = (secondsPerFrame == null) ? DEFAULTS.seconds_per_frame : secondsPerFrame;
  const rows = [];
  for (let s = 6; s <= 15; s++) {
    const f = snapFrames(s);
    rows.push({
      seconds: s,
      frames: f,
      actual_seconds: actualSeconds(f),
      render_min: Math.round(renderMinutesForFrames(f, spf) * 10) / 10,
    });
  }
  return rows;
}

// slots: array of numbers (seconds) or objects { seconds }.
function normalizeSlots(slots) {
  return (slots || []).map((x) => (typeof x === 'number' ? x : (x && x.seconds)));
}

function estimate(slots, config) {
  const cfg = config || {};
  const spf = (cfg.seconds_per_frame == null) ? DEFAULTS.seconds_per_frame : cfg.seconds_per_frame;
  const setup = (cfg.setup_min == null) ? DEFAULTS.setup_min : cfg.setup_min;
  const secs = normalizeSlots(slots);
  const perSlot = secs.map((s) => {
    const f = snapFrames(s);
    return {
      seconds: s,
      frames: f,
      actual_seconds: actualSeconds(f),
      render_min: renderMinutesForFrames(f, spf),
    };
  });
  const totalFrames = perSlot.reduce((a, b) => a + b.frames, 0);
  const totalRenderMinRaw = perSlot.reduce((a, b) => a + b.render_min, 0);
  const renderMin = Math.round(totalRenderMinRaw);
  const totalMin = renderMin + setup;
  const quotaNeeded = Math.round((totalMin / 60) * 10) / 10;
  return {
    frames: totalFrames,
    render_min: renderMin,
    setup_min: setup,
    total_min: totalMin,
    quota_needed_h: quotaNeeded,
    per_slot: perSlot,
  };
}

function quotaOk(remainingH, neededH, marginH) {
  const m = (marginH == null) ? DEFAULTS.quota_margin_h : marginH;
  return Number(remainingH) >= Number(neededH) + Number(m);
}

module.exports = {
  DEFAULTS,
  snapFrames,
  actualSeconds,
  renderMinutesForFrames,
  frameTable,
  estimate,
  quotaOk,
};