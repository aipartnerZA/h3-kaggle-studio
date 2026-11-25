'use strict';

// The single-run state machine (SPEC §5.3) and boot recovery (§5.4).
// All work is synchronous so two ticks can never interleave.

const fs = require('fs');
const path = require('path');
const cost = require('./cost');

const TERMINAL = new Set(['DONE', 'PARTIAL', 'FAILED', 'CANCELLED']);
const CANCELABLE = new Set(['QUEUED', 'STAGING', 'STAGED', 'GATING', 'BUILDING']);
const PRE_PUSH = new Set(['QUEUED', 'STAGING', 'STAGED', 'GATING', 'BUILDING']);
const POST_PUSH = new Set(['PUSHED', 'GPU_QUEUED', 'RENDERING', 'KERNEL_COMPLETE',
  'DOWNLOADING', 'VERIFYING', 'KERNEL_FAILED', 'DOWNLOADING_LOG']);

function createWorker(opts) {
  const config = opts.config;
  const base = opts.base;
  const store = opts.store;
  const pipeline = opts.pipeline;
  const kaggle = opts.kaggle || pipeline.client;
  const nowFn = opts.now || (() => Date.now());
  const immediate = opts.immediate || ((fn) => setImmediate(fn));
  const intervalFn = opts.interval || ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearInterval || ((h) => clearInterval(h));
  const logger = opts.log || (() => {});

  const iso = () => new Date(nowFn()).toISOString();
  const minutesSince = (when) => {
    if (!when) return Infinity;
    const t = Date.parse(when);
    return Number.isFinite(t) ? (nowFn() - t) / 60000 : Infinity;
  };
  const kernelRef = (tag) => `${config.owner}/${config.kernel_prefix}${tag}`;

  function note(state, msg) {
    const clean = String(msg).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
    const line = `${iso()} [${state.tag}] ${clean}`;
    state.log_tail = (state.log_tail || []).concat(line).slice(-40);
    logger(line);
    try {
      const p = pipeline.runPath(state.tag, 'logs', 'worker.log');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, line + '\n');
    } catch (e) { /* a full disk must not stop the machine */ }
  }

  function save(state) {
    state.log_tail = (state.log_tail || []).slice(-40);
    store.writeState(base, state.tag, state);
    return state;
  }

  function setPhase(state, phase, extra) {
    Object.assign(state, extra || {});
    state.phase = phase;
    state.phase_since = iso();
    note(state, 'phase -> ' + phase);
    return save(state);
  }

  function pollAfter(state, seconds) {
    state.poll_after = new Date(nowFn() + seconds * 1000).toISOString();
    save(state);
  }

  function closeRun(state) {
    if (!state.quota_after) {
      const q = kaggle.quota && kaggle.quota();
      if (q && q.ok) state.quota_after = { gpu_remaining_h: q.gpu_remaining_h, read_at: iso() };
    }
    save(state);
    try { pipeline.writeDone(state.tag, state.phase === 'DONE' ? 'done' : state.phase); } catch (e) {
      note(state, 'could not write sentinel: ' + e.message);
    }
    const active = store.readActive(base);
    if (active && active.tag === state.tag) store.clearActive(base);
    note(state, 'closed (' + state.phase + ')');
  }

  function fail(state, reason) {
    note(state, 'FAIL: ' + reason);
    setPhase(state, 'FAILED', { error: String(reason), poll_after: null });
    closeRun(state);
    return 'wait';
  }

  function mapStatus(s) {
    switch (s) {
      case 'QUEUED': return 'GPU_QUEUED';
      case 'RUNNING': return 'RENDERING';
      case 'COMPLETE': return 'KERNEL_COMPLETE';
      case 'ERROR': case 'CANCEL': case 'CANCEL_ACKNOWLEDGED': return 'KERNEL_FAILED';
      default: return null;
    }
  }

  function pollSeconds(state) {
    const override = Number(config.poll_override_ms || 0);
    if (override > 0) return override / 1000;
    if (state.phase === 'RENDERING') return 45;
    if (state.phase === 'GPU_QUEUED' || state.phase === 'PUSHED') return 60;
    return Math.max(5, Number(config.poll_busy_s || 20));
  }

  function pollDue(state) {
    if (!state.poll_after) return true;
    return nowFn() >= Date.parse(state.poll_after);
  }

  function doPoll(state) {
    const st = pipeline.poll(state.kernel_ref || kernelRef(state.tag));
    if (!st || !st.ok) {
      state.status_stale = true;
      note(state, 'status read failed: ' + ((st && st.error) || 'unknown'));
      if (minutesSince(state.kaggle_status_at) > 30) return fail(state, 'kaggle CLI unreachable');
      pollAfter(state, pollSeconds(state));
      save(state);
      return 'wait';
    }
    state.kaggle_status = st.status;
    state.kaggle_status_at = iso();
    state.status_stale = false;
    const next = mapStatus(st.status);
    if (next && next !== state.phase) {
      setPhase(state, next, { poll_after: null });
      return 'again';
    }
    pollAfter(state, pollSeconds(state));
    return 'wait';
  }

  function step(state) {
    const phase = state.phase;
    const request = store.readRequest(base, state.tag) || { slots: [] };

    if (TERMINAL.has(phase)) {
      closeRun(state);
      return 'wait';
    }

    switch (phase) {
      case 'QUEUED':
        setPhase(state, 'STAGING');
        return 'again';

      case 'STAGING': {
        if (minutesSince(state.phase_since) > 3) return fail(state, 'staging timeout after 3 min');
        const r = pipeline.stage(state.tag, request.slots);
        if (r.output) note(state, r.output.split(/\r?\n/).slice(-8).join(' | '));
        if (!r.ok) return fail(state, 'staging failed: ' + (r.error || 'python3 stage_shot.py failed'));
        setPhase(state, 'STAGED');
        return 'again';
      }

      case 'STAGED':
        setPhase(state, 'GATING');
        return 'again';

      case 'GATING':
        setPhase(state, 'BUILDING');
        return 'again';

      case 'BUILDING': {
        if (minutesSince(state.phase_since) > 5) return fail(state, 'build timeout after 5 min');
        const r = pipeline.push(state.tag);
        if (r.output) note(state, r.output.split(/\r?\n/).slice(-12).join(' | '));
        if (r.ok) {
          setPhase(state, 'PUSHED', {
            pushed_at: iso(), kernel_ref: kernelRef(state.tag), poll_after: null,
          });
          return 'again';
        }
        if (r.preflight) return fail(state, r.preflight);
        return fail(state, 'push failed (exit ' + r.status + '): ' + (r.error || 'no output'));
      }

      case 'PUSHED':
        return pollDue(state) ? doPoll(state) : 'wait';

      case 'GPU_QUEUED': {
        if (minutesSince(state.phase_since) >= (config.queue_wait_warn_min || 90)) {
          const notice = `Queued ${Math.floor(minutesSince(state.phase_since))} min. Kaggle has no published ETA. Check for another live kernel before assuming a stall.`;
          if (state.queue_notice !== notice) {
            state.queue_notice = notice;
            note(state, notice);
            save(state);
          }
        }
        return pollDue(state) ? doPoll(state) : 'wait';
      }

      case 'RENDERING': {
        const limit = Math.ceil((state.estimate && state.estimate.render_min || 0) * 2) + 60;
        if (minutesSince(state.phase_since) > limit) return fail(state, `render timeout after ${limit} min`);
        return pollDue(state) ? doPoll(state) : 'wait';
      }

      case 'KERNEL_COMPLETE':
        setPhase(state, 'DOWNLOADING');
        return 'again';

      case 'DOWNLOADING': {
        if (minutesSince(state.phase_since) > 10) return fail(state, 'download timeout after 10 min');
        // ~0.2 MB per rendered frame with a 200 MB floor; a real `df` check
        // happens in pipeline.collect (FL8). No download starts if it cannot fit.
        const needBytes = Math.max(200 * 1048576,
          ((state.estimate && state.estimate.frames) || 0) * 200000);
        const r = pipeline.collect(state.tag, { needBytes });
        if (r.output) note(state, r.output.split(/\r?\n/).slice(-10).join(' | '));
        if (r.busy) { pollAfter(state, 20); return 'wait'; }
        if (r.disk) return fail(state, r.error);
        if (r.ok) {
          setPhase(state, 'VERIFYING');
          return 'again';
        }
        const pub = pipeline.publish(state.tag, request);
        const firstFail = Object.keys(pub.fails)[0];
        if (r.status === 2) {
          return fail(state, `the kernel ended ${state.kaggle_status || 'ERROR'}. ${pub.rendered.ok} of ${pub.rendered.total} slots reported success before it stopped.`);
        }
        return fail(state, 'kernel COMPLETE but produced no mp4'
          + (firstFail ? ': ' + pub.fails[firstFail] : ''));
      }

      case 'VERIFYING': {
        if (minutesSince(state.phase_since) > 5) return fail(state, 'verify timeout after 5 min');
        const pub = pipeline.publish(state.tag, request);
        for (const sr of pub.slotResults) {
          const slot = (state.slots || []).find((s) => s.n === sr.n);
          if (slot) Object.assign(slot, sr);
        }
        const ok = pub.slotResults.filter((s) => s.result === 'ok').length;
        const failed = pub.slotResults.length - ok;
        state.rendered = pub.rendered;
        state.totals = { ok, failed };
        state.log_tail = (state.log_tail || []).concat(pub.logTail).slice(-40);
        if (ok === pub.slotResults.length && ok > 0) {
          setPhase(state, 'DONE', { totals: state.totals, error: null });
          closeRun(state);
          return 'wait';
        }
        if (ok > 0) {
          setPhase(state, 'PARTIAL', { totals: state.totals });
          closeRun(state);
          return 'wait';
        }
        const firstFail = Object.keys(pub.fails)[0];
        return fail(state, firstFail ? pub.fails[firstFail] : 'no usable clip was produced');
      }

      case 'KERNEL_FAILED':
        setPhase(state, 'DOWNLOADING_LOG');
        return 'again';

      case 'DOWNLOADING_LOG': {
        const pub = pipeline.publish(state.tag, request);
        return fail(state, `the kernel ended ${state.kaggle_status || 'ERROR'}. ${pub.rendered.ok} of ${pub.rendered.total} slots reported success before it stopped.`);
      }

      default:
        return fail(state, 'unknown phase: ' + phase);
    }
  }

  function tick() {
    const active = store.readActive(base);
    if (!active || !active.tag) return;
    const state = store.readState(base, active.tag);
    if (!state) { store.clearActive(base); return; }
    let action = 'again';
    let guard = 0;
    while (action === 'again' && guard++ < 16) action = step(state);
  }

  function submit(request, estimate, quota) {
    const tag = request.tag;
    store.ensureRun(base, tag);
    store.writeRequest(base, tag, request);
    const state = {
      tag,
      phase: 'QUEUED',
      phase_since: iso(),
      submitted_at: request.submitted_at,
      pushed_at: null,
      kernel_ref: kernelRef(tag),
      kaggle_status: null,
      kaggle_status_at: null,
      status_stale: false,
      slots: request.slots.map((s) => ({
        n: s.n, id: s.id, seconds: s.seconds,
        frames: cost.snapFrames(s.seconds), seed: s.seed,
        result: 'pending', wall_seconds: null, file: null, sheet: null, error: null,
      })),
      estimate: estimate || null,
      quota: {
        gpu_remaining_h: quota && quota.gpu_remaining_h != null ? quota.gpu_remaining_h : null,
        gpu_read_at: iso(),
      },
      quota_after: null,
      totals: { ok: 0, failed: 0 },
      error: null,
      log_tail: [],
      poll_after: null,
      queue_notice: null,
      rendered: null,
    };
    save(state);
    store.writeActive(base, { tag, since: iso() });
    note(state, 'submitted');
    save(state);
    if (config.worker_enabled !== false) immediate(() => tick());
    return state;
  }

  function cancel(tag) {
    const state = store.readState(base, tag);
    if (!state) return { conflict: false, missing: true };
    if (!CANCELABLE.has(state.phase)) return { conflict: true, phase: state.phase };
    note(state, 'cancelled by operator');
    setPhase(state, 'CANCELLED');
    closeRun(state);
    return { ok: true, phase: 'CANCELLED', tag };
  }

  function deleteRun(tag) {
    const state = store.readState(base, tag);
    if (!state) return { missing: true };
    if (!TERMINAL.has(state.phase)) return { conflict: true, phase: state.phase };
    const active = store.readActive(base);
    if (active && active.tag === tag) store.clearActive(base);
    fs.rmSync(store.runDir(base, tag), { recursive: true, force: true });
    return { ok: true, tag };
  }

  function getActive() {
    const active = store.readActive(base);
    if (!active || !active.tag) return null;
    const state = store.readState(base, active.tag);
    if (!state) { store.clearActive(base); return null; }
    if (TERMINAL.has(state.phase)) return null;
    return { tag: active.tag, phase: state.phase, since: active.since };
  }

  function boot() {
    const inv = store.bootInventory(base);
    let tag = inv.active && inv.active.tag;
    if (!tag) {
      const live = inv.runs
        .filter((r) => r.state && !TERMINAL.has(r.state.phase))
        .sort((a, b) => Date.parse(b.state.phase_since || b.state.submitted_at || 0)
          - Date.parse(a.state.phase_since || a.state.submitted_at || 0));
      if (live.length) {
        tag = live[0].tag;
        store.writeActive(base, { tag, since: iso() });
      }
    }
    if (!tag) return { adopted: null };
    const state = store.readState(base, tag);
    if (!state) { store.clearActive(base); return { adopted: null }; }

    if (TERMINAL.has(state.phase)) {
      closeRun(state);
      return { adopted: tag, phase: state.phase };
    }

    if (PRE_PUSH.has(state.phase)) {
      note(state, 'boot: resuming from STAGING');
      setPhase(state, 'STAGING');
    } else if (POST_PUSH.has(state.phase)) {
      if (!state.pushed_at) {
        note(state, 'boot: no push recorded, resuming from STAGING');
        setPhase(state, 'STAGING');
      } else if (state.phase === 'KERNEL_FAILED' || state.phase === 'DOWNLOADING_LOG') {
        setPhase(state, 'KERNEL_FAILED');
      } else if (state.phase === 'KERNEL_COMPLETE' || state.phase === 'DOWNLOADING'
                 || state.phase === 'VERIFYING') {
        setPhase(state, 'DOWNLOADING');
      } else {
        const st = pipeline.poll(state.kernel_ref || kernelRef(tag));
        if (!st || !st.ok) {
          state.status_stale = true;
          note(state, 'boot: kaggle status unavailable: ' + ((st && st.error) || 'unknown'));
          if (minutesSince(state.phase_since) > 30) {
            fail(state, 'kernel not found — the push did not land');
          } else {
            pollAfter(state, pollSeconds(state));
          }
        } else {
          state.kaggle_status = st.status;
          state.kaggle_status_at = iso();
          state.status_stale = false;
          const next = mapStatus(st.status);
          if (next) setPhase(state, next, { poll_after: null });
          else pollAfter(state, pollSeconds(state));
        }
      }
    }
    tick();
    return { adopted: tag, phase: store.readState(base, tag).phase };
  }

  let timer = null;
  function start() {
    const r = boot();
    timer = intervalFn(tick, Math.max(1000, Number(config.poll_busy_s || 20) * 1000));
    return r;
  }
  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
  }

  return {
    start, stop, tick, wake: () => immediate(() => tick()),
    submit, cancel, deleteRun, getActive, boot, step, save, setPhase, closeRun, note,
  };
}

module.exports = { createWorker, TERMINAL, CANCELABLE, PRE_PUSH, POST_PUSH };
