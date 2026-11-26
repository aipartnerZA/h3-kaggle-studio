'use strict';

// H3 Render UI — no framework, no inline JS, no dynamic code execution (SPEC §8, CSP script-src 'self').
// The board comes from the server; this file renders it and drives the form.
// Motion uses GSAP from assets/gsap.min.js. If it is missing, or the visitor prefers reduced
// motion, every animation is skipped and the page still works (CSS handles the state changes).
(function () {
  // The server injects the mount prefix (default "/") into this meta tag; every API
  // URL is built from it so a deployment under /h3 keeps working.
  const PREFIX = ((document.querySelector('meta[name="h3-prefix"]') || {}).content || '')
    .replace(/\/+$/, '');
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const TERMINAL = ['DONE', 'PARTIAL', 'FAILED', 'CANCELLED'];
  const PHASE_KEY = {
    QUEUED: 'phase_staging', STAGING: 'phase_staging', STAGED: 'phase_gating',
    GATING: 'phase_gating', BUILDING: 'phase_building', PUSHED: 'phase_pushed',
    GPU_QUEUED: 'phase_gpu_queued', RENDERING: 'phase_rendering',
    KERNEL_COMPLETE: 'phase_downloading', DOWNLOADING: 'phase_downloading',
    VERIFYING: 'phase_verifying',
  };
  document.documentElement.dataset.appReady = '1';

  // ---- Motion helpers --------------------------------------------------------
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const G = (!reduceMotion && window.gsap) ? window.gsap : null;
  function fx(fn) { if (!G) return; try { fn(G); } catch (e) { /* animation must never break the app */ } }
  const SMOOTH = reduceMotion ? 'auto' : 'smooth';

  const S = Object.create(null);
  const strings = $('#h3-strings');
  (strings && strings.content ? strings.content.querySelectorAll('[data-s]') : [])
    .forEach((node) => { S[node.dataset.s] = node.textContent; });
  function t(key, vars) {
    const raw = S[key] == null ? key : S[key];
    return raw.replace(/\{([^}]+)\}/g, (match, k) =>
      (vars && vars[k] != null ? String(vars[k]) : match));
  }
  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function link(href, text, cls) {
    const a = node('a', cls || null, text);
    a.href = href;
    return a;
  }
  function pill(text) {
    const p = node('span', 'pill', text);
    p.dataset.r = String(text == null ? '' : text).toLowerCase();
    return p;
  }

  // Small clipboard icon. Prompt text is selectable; everything else is not.
  const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
    + '<path d="M5 1h6a1 1 0 0 1 1 1v1h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h1V2a1 1 0 0 1 1-1zm0 2h6V2H5v1zM4 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H4z"/></svg>';
  function copyButton(label) {
    const b = node('button', 'copy-prompt');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = COPY_ICON;
    return b;
  }
  async function copyPrompt(text, button) {
    if (!text) return;
    let done = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        done = true;
      }
    } catch (e) { /* fall through to the selection fallback */ }
    if (!done) {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.top = '-1000px';
      helper.style.userSelect = 'text';
      document.body.appendChild(helper);
      helper.select();
      try { done = document.execCommand('copy'); } catch (e) { /* no clipboard permission */ }
      helper.remove();
    }
    if (button && done) {
      button.classList.add('copied');
      button.setAttribute('aria-label', 'Copied');
      const old = button.title;
      button.title = 'Copied';
      setTimeout(() => {
        button.classList.remove('copied');
        button.setAttribute('aria-label', old);
        button.title = old;
      }, 1200);
    }
  }
  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  let board;
  try {
    const bootEl = $('#h3-bootstrap');
    const raw = bootEl && bootEl.content ? bootEl.content.textContent : (bootEl ? bootEl.textContent : '');
    board = JSON.parse(raw || '{}');
  } catch (e) { board = {}; }

  // Every write carries the token this page was rendered with. Behind a proxy that
  // rewrote Host, an Origin match alone cannot prove the write came from here.
  function writeHeaders(extra) {
    return Object.assign({ 'X-Setup-CSRF': (board && board.csrf) || '' }, extra || {});
  }
  board.config = board.config || {};
  const cfg = board.config;
  const MIN = Number(cfg.seconds_min) || 6;
  const MAX = Number(cfg.seconds_max) || 15;
  const SPF = Number(cfg.seconds_per_frame) || 3.3;
  const SETUP = cfg.setup_min == null ? 13 : Number(cfg.setup_min);
  const MAXCHARS = Number(cfg.prompt_max_chars) || 2000;
  const MAXBYTES = Number(cfg.image_max_bytes) || 3145728;
  const BUSY_MS = 5000;  // SPEC §8.3
  const IDLE_MS = 60000; // SPEC §8.3

  // A submission leaves this page before the server has answered, and the server
  // spends that window reading live GPU quota from Kaggle. `submitting` is the
  // local record of that window: from the click until the server rules on it the
  // form, the dock and anything that could start or disturb a run stay locked.
  // `boardFloorAt` marks the moment a run was accepted, so a poll issued before
  // it cannot unlock the form with a board that predates the run.
  let submitting = null;      // ms timestamp of the click, or null
  let submitTicker = null;    // 1 s clock that keeps the banner alive while waiting
  let pollSeq = 0;
  let boardFloorAt = 0;
  function locked() { return !!board.active || !!submitting; }

  function snapFrames(seconds) {
    const base = Math.max(5, Math.round(seconds * 24));
    return 17 * Math.ceil((base - 5) / 17) + 5;
  }
  function renderMinutes(frames) { return Math.round((frames * SPF) / 60); }
  function fmtDuration(minutes) {
    if (!isFinite(minutes)) return '?';
    const m = Math.max(0, Math.floor(minutes));
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
  }
  // §6/§8.1 write the estimate total as 1h23 / 2h05 (no trailing m).
  function fmtTotal(minutes) {
    if (!isFinite(minutes)) return '?';
    const m = Math.max(0, Math.floor(minutes));
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  }
  // Plain-language version for the big headline: "1 h 13 min".
  function fmtFriendly(minutes) {
    if (!isFinite(minutes)) return '?';
    const m = Math.max(0, Math.round(minutes));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  // Wall-clock elapsed for the per-slot table. Real time from the browser
  // clock, not a fabricated progress bar; frozen when the run is terminal.
  let elapsedStartMs = null;
  function fmtHMS(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  function tickElapsed() {
    if (elapsedStartMs == null) return;
    const text = fmtHMS(Date.now() - elapsedStartMs);
    $$('[data-elapsed]').forEach((cell) => { cell.textContent = text; });
  }
  setInterval(tickElapsed, 1000);

  function secondsLabel(seconds) {
    return `${seconds} s · ~${renderMinutes(snapFrames(seconds))} min`;
  }
  function secondsDetail(seconds) {
    const frames = snapFrames(seconds);
    return `Renders as ${(frames / 24).toFixed(2)} s (${frames} frames)`;
  }
  function fmtStamp(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const opts = { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false };
    const sast = new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: 'Africa/Johannesburg' }, opts)).format(d);
    const utc = new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: 'UTC' }, opts)).format(d);
    return `${sast} SAST / ${utc} UTC`;
  }

  const cards = $$('.slot-card');
  const slots = cards.map((card) => ({ n: Number(card.dataset.slot), file: null, name: '' }));
  let booted = false;
  function byN(n) { return slots.find((s) => s.n === n); }
  function cardEl(n) { return $(`.slot-card[data-slot="${n}"]`); }
  function promptEl(n) { return $(`[data-prompt="${n}"]`); }
  function secondsEl(n) { return $(`[data-seconds="${n}"]`); }
  function errorEl(n) { return $(`[data-error="${n}"]`); }
  function seconds(n) { return Number(secondsEl(n).value); }
  function filled(s) { return promptEl(s.n).value.trim().length > 0 || !!s.file; }

  function setSlotError(n, message) {
    const target = errorEl(n);
    const card = cardEl(n);
    const wasShown = !target.hidden;
    target.textContent = message || '';
    target.hidden = !message;
    card.classList.toggle('invalid', !!message);
    if (message && !wasShown) {
      fx((g) => {
        g.fromTo(card, { x: -9 }, { x: 0, duration: .7, ease: 'elastic.out(1, .32)', clearProps: 'transform' });
        g.from(target, { opacity: 0, y: -6, duration: .3, ease: 'power2.out', clearProps: 'transform,opacity' });
      });
    }
  }
  function showFormError(message) {
    const target = $('#form-error');
    const wasShown = !target.hidden;
    target.textContent = message || '';
    target.hidden = !message;
    if (message && !wasShown) {
      fx((g) => g.from(target, { opacity: 0, y: 8, duration: .3, ease: 'power2.out', clearProps: 'transform,opacity' }));
    }
  }
  function showHistoryNote(message) {
    const target = $('#history-note');
    target.textContent = message || '';
    target.hidden = !message;
  }

  // ---- Banner ---------------------------------------------------------------
  function activeDetail(a) {
    const now = Date.now();
    const started = a.phase_since ? Date.parse(a.phase_since) : NaN;
    const elapsed = isFinite(started) ? (now - started) / 60000 : 0;
    const planned = (a.estimate && a.estimate.total_min) || 0;
    const eta = planned ? Math.max(0, planned - elapsed) : null;
    const totals = a.totals || { ok: 0, failed: 0 };
    let detail = t('busy_detail', {
      tag: a.tag, status: a.kaggle_status || 'WAITING', e: fmtDuration(elapsed),
      eta: eta == null ? '?' : fmtDuration(eta), n: totals.ok,
      m: (a.slots || []).length,
    });
    const at = a.kaggle_status_at ? Date.parse(a.kaggle_status_at) : NaN;
    const age = isFinite(at) ? (now - at) / 1000 : Infinity;
    if (a.status_stale || age > 120) {
      const mins = isFinite(age) ? Math.floor(age / 60) : '?';
      detail += ` (status may be stale — last read ${mins} min ago)`;
    }
    return detail;
  }

  // Update text in place. Replacing the children every 5 s makes the banner
  // flicker; only the words need to change while the state stays the same.
  let dotTween = null;
  let bannerSeen = false;
  function setBanner(cls, head, detail) {
    const banner = $('#status-banner');
    const wanted = 'banner ' + cls;
    if (banner.className !== wanted || !banner.querySelector('.dot')) {
      if (dotTween) { dotTween.kill(); dotTween = null; }
      banner.className = wanted;
      const dot = node('i', 'dot');
      banner.replaceChildren(dot, node('strong'), node('span'));
      if (bannerSeen) {
        fx((g) => g.from([banner.children[1], banner.children[2]],
          { y: -8, opacity: 0, duration: .45, stagger: .06, ease: 'power2.out', clearProps: 'transform,opacity' }));
      }
      if (cls === 'busy') {
        fx((g) => { dotTween = g.to(dot, { scale: 1.8, opacity: .35, duration: .85, repeat: -1, yoyo: true, ease: 'sine.inOut' }); });
      } else if (cls === 'done') {
        fx((g) => g.fromTo(dot, { scale: 0 }, { scale: 1, duration: .6, ease: 'back.out(3)', clearProps: 'transform' }));
      }
      bannerSeen = true;
    }
    banner.querySelector('strong').textContent = head;
    banner.querySelector('span').textContent = detail;
  }

  // The wait between the click and Kaggle's answer. The seconds count is the
  // proof of life: it changes every second even while no request can complete.
  function submitElapsed() {
    return submitting ? Math.max(0, Math.round((Date.now() - submitting) / 1000)) : 0;
  }
  function submittingDetail() {
    const s = submitElapsed();
    return s < 12 ? t('submitting_detail', { s }) : t('submitting_detail_slow', { s });
  }

  function renderBanner() {
    if (submitting) {
      setBanner('submitting', t('submitting_head'), submittingDetail());
      return;
    }
    if (board.active) {
      setBanner('busy', t('busy_head'), activeDetail(board.active));
      return;
    }
    const last = (board.runs || []).find((r) => TERMINAL.indexOf(r.phase) !== -1);
    if (last) {
      if (last.phase === 'CANCELLED') {
        setBanner('idle', t('last_cancelled'), `${last.tag} · CANCELLED`);
        return;
      }
      const done = last.phase === 'DONE';
      setBanner(done ? 'done' : 'failed',
        done ? t('last_done', { ok: (last.totals || {}).ok, n: last.slots }) : t('last_failed'),
        `${last.tag} · ${last.phase}`);
      return;
    }
    const q = board.quota;
    setBanner('idle', t('idle_banner'), t('quota_line', {
      h: q ? q.gpu_remaining_h : '?',
      day: (q && q.refresh_sast) ? q.refresh_sast.split(' ')[0] : '?',
      hh: (q && q.refresh_sast) ? q.refresh_sast.split(' ')[1] : '?',
      'hh:mm': (q && q.refresh_sast) ? q.refresh_sast.split(' ')[1] : '?',
    }));
  }

  // ---- Form -----------------------------------------------------------------
  // Locked means: a run is live on the server, or this page is waiting to hear
  // whether one was accepted. The second case matters — the POST can take several
  // seconds, and re-enabling the form (or the button) in that window is how a
  // second submission, or a paste that rewrites a slot the payload already read,
  // gets in.
  function renderFormLock() {
    const busy = locked();
    const sending = !!submitting;
    $('#form-fields').disabled = busy;
    const button = $('#submit-button');
    button.disabled = busy;
    button.classList.toggle('is-submitting', sending);
    button.setAttribute('aria-busy', sending ? 'true' : 'false');
    const label = $('#submit-label');
    if (label) label.textContent = sending ? t('submit_working') : t('submit_button');
    const caption = $('#submit-caption');
    caption.hidden = !busy;
    caption.textContent = !busy ? ''
      : sending ? t('submit_caption_working')
      : t('submit_disabled', { tag: (board.active && board.active.tag) || '' });
    $('#dock-summary').hidden = busy;
    document.body.classList.toggle('is-busy', !!board.active);
    if (!busy) showFormError('');
  }

  // Big friendly total counts up/down to the new value instead of jumping.
  const estShown = { v: NaN };
  function showEstimateTime(el, minutes) {
    if (!G || !Number.isFinite(estShown.v)) {
      estShown.v = minutes;
      el.textContent = fmtFriendly(minutes);
      return;
    }
    G.to(estShown, {
      v: minutes, duration: .5, ease: 'power2.out', overwrite: true,
      onUpdate: () => { el.textContent = fmtFriendly(estShown.v); },
      onComplete: () => { el.textContent = fmtFriendly(minutes); },
    });
  }
  function ensureEstimate() {
    const card = $('#estimate');
    if (card.dataset.built) return card;
    const main = node('div', 'estimate-main');
    main.appendChild(node('strong', 'est-time'));
    main.appendChild(node('span', 'est-for'));
    card.replaceChildren(main, node('span', 'estimate-extra'), node('span', 'estimate-extra'), node('span', 'estimate-extra'));
    card.dataset.built = '1';
    return card;
  }

  function renderEstimate() {
    const active = slots.filter(filled);
    let frames = 0;
    active.forEach((s) => { frames += snapFrames(seconds(s.n)); });
    const render = Math.round(active.reduce((sum, s) =>
      sum + (snapFrames(seconds(s.n)) * SPF) / 60, 0));
    const total = render + SETUP;
    const need = Math.round((total / 60) * 10) / 10;
    const card = ensureEstimate();
    const left = board.quota ? board.quota.gpu_remaining_h : '?';
    const timeEl = $('.est-time', card);
    const forEl = $('.est-for', card);
    const extra = $$('.estimate-extra', card);

    if (active.length) {
      showEstimateTime(timeEl, total);
      forEl.textContent = `for ${plural(active.length, 'video')}`;
      $('#dock-summary').textContent = `${plural(active.length, 'video')} · about ${fmtFriendly(total)}`;
    } else {
      if (G) G.killTweensOf(estShown);
      estShown.v = NaN;
      timeEl.textContent = '—';
      forEl.textContent = 'Add a prompt to see how long it takes';
      $('#dock-summary').textContent = 'Add a prompt to begin';
    }
    extra[0].textContent = t('estimate', {
      slots: active.length, frames, rm: render, sm: SETUP, total: fmtTotal(total),
    });
    extra[1].textContent =
      `~${need} h GPU of ${left} h left${board.quota && board.quota.refresh_sast ? ` · resets ${board.quota.refresh_sast}` : ''}`;
    const fullFrames = 6 * snapFrames(MAX);
    const fullTotal = renderMinutes(fullFrames) + SETUP;
    extra[2].textContent =
      `Six × ${MAX} s = ${fullFrames} frames ≈ ${fmtTotal(fullTotal)} (~${Math.round((fullTotal / 60) * 10) / 10} h GPU)`;
  }

  // ---- Per-slot state (empty / needs a prompt / ready) and the batch strip ----
  let lastReady = 0;
  function updateBatch() {
    const ready = slots.filter((s) => cardEl(s.n).dataset.state === 'ready').length;
    const total = slots.length;
    $('#batch-count').textContent = `${ready} of ${total} ready`;
    let hint;
    if (ready === 0) hint = 'One video works. Six is the sweet spot: setup only happens once.';
    else if (ready === 1) hint = 'Nice start. Add more and they all share one setup.';
    else if (ready < total) hint = `Room for ${total - ready} more. Setup only happens once.`;
    else hint = 'Full batch. All six share one setup.';
    $('#batch-hint').textContent = hint;
    if (booted && lastReady === 0 && ready > 0 && !board.active) {
      fx((g) => g.fromTo('#submit-button', { scale: 1 },
        { scale: 1.07, duration: .18, yoyo: true, repeat: 1, ease: 'power2.out', overwrite: 'auto', clearProps: 'transform' }));
    }
    lastReady = ready;
  }

  function refreshSlot(n) {
    const card = cardEl(n);
    const hasPrompt = promptEl(n).value.trim().length > 0;
    const state = hasPrompt ? 'ready' : (byN(n).file ? 'partial' : 'empty');
    if (card.dataset.state === state) return;
    card.dataset.state = state;
    const chip = $(`[data-chip="${n}"]`);
    chip.hidden = state === 'empty';
    chip.textContent = state === 'ready' ? 'Ready' : 'Needs a prompt';
    const pip = $(`[data-pip="${n}"]`);
    pip.classList.toggle('ready', state === 'ready');
    pip.classList.toggle('partial', state === 'partial');
    if (booted) {
      fx((g) => {
        if (state !== 'empty') {
          g.fromTo(chip, { scale: .6, opacity: 0 }, { scale: 1, opacity: 1, duration: .4, ease: 'back.out(3)', clearProps: 'transform,opacity' });
        }
        g.fromTo(pip, { scale: .7 }, { scale: 1, duration: .5, ease: 'back.out(3)', clearProps: 'transform' });
      });
    }
    updateBatch();
  }

  function autoGrow(n) {
    const el = promptEl(n);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 3, 240)}px`;
  }

  function updateSlotUI(n) {
    const len = promptEl(n).value.length;
    const counter = $(`[data-counter="${n}"]`);
    counter.textContent = `${len} / ${MAXCHARS}`;
    counter.classList.toggle('warn', len > 800);
    const range = secondsEl(n);
    const labelEl = $(`[data-label="${n}"]`);
    labelEl.textContent = secondsLabel(seconds(n));
    labelEl.title = secondsDetail(seconds(n));
    const pct = Math.max(0, Math.min(1, (seconds(n) - MIN) / Math.max(1, MAX - MIN)));
    range.style.setProperty('--p', `calc(${(pct * 100).toFixed(2)}% + ${((0.5 - pct) * 24).toFixed(2)}px)`);
    refreshSlot(n);
  }
  function updateCounters() {
    slots.forEach((s) => { updateSlotUI(s.n); autoGrow(s.n); });
    renderEstimate();
  }

  // ---- Active run panel and history ----------------------------------------
  let renderSeq = 0;
  let panelSig = '';

  async function renderRunPanel() {
    const seq = ++renderSeq;
    const panel = $('#run-panel');
    const active = board.active;
    const recent = (board.runs || []).find((r) =>
      TERMINAL.indexOf(r.phase) !== -1
      && ((r.files && r.files.length)
        || r.phase === 'CANCELLED' || r.phase === 'FAILED'));
    const tag = active ? active.tag : (recent ? recent.tag : null);
    $('#run-ssr').replaceChildren();
    if (!tag) {
      panel.hidden = true;
      panelSig = '';
      elapsedStartMs = null;
      renderStopZone(null, null, null);
      $('#run-summary').replaceChildren();
      $('#slot-table-wrap').replaceChildren();
      $('#downloads').replaceChildren();
      $('#log-links').replaceChildren();
      return;
    }
    const wasHidden = panel.hidden;
    panel.hidden = false;
    $('#run-title').textContent = active ? 'Rendering now' : 'Latest render';
    if (wasHidden && booted) {
      fx((g) => g.from(panel, { y: 26, opacity: 0, duration: .6, ease: 'power3.out', clearProps: 'transform,opacity' }));
    }

    let detail = null;
    try {
      const r = await fetch(`${PREFIX}/api/runs/${encodeURIComponent(tag)}`, { cache: 'no-store' });
      if (r.ok) detail = await r.json();
    } catch (e) { /* keep server-rendered data if the fetch fails */ }
    if (seq !== renderSeq) return;

    const stateObj = (detail && detail.state) || active || {};
    const phase = stateObj.phase || (active && active.phase) || 'QUEUED';
    const totals = stateObj.totals || (active && active.totals) || { ok: 0, failed: 0 };
    const slotRows = (detail && detail.slots) || stateObj.slots || [];
    const files = (detail && detail.files) || [];
    const slotCount = Array.isArray(stateObj.slots) ? stateObj.slots.length : (slotRows.length || Number(stateObj.slots) || 0);
    const runStart = Date.parse(stateObj.pushed_at || stateObj.submitted_at || stateObj.phase_since || '');
    const isLive = TERMINAL.indexOf(phase) === -1 && Number.isFinite(runStart);
    elapsedStartMs = isLive ? runStart : null;
    const finalMs = Number.isFinite(runStart)
      ? Math.max(0, Date.parse(stateObj.phase_since || '') - runStart) : 0;
    panel.dataset.phase = phase;
    renderStopZone(phase, tag, stateObj);

    // Elapsed time and the ETA bar advance between polls. Update only those,
    // and leave the slot table / video players untouched unless real data changed.
    const planned = (stateObj.estimate && stateObj.estimate.total_min) || 0;
    const started = stateObj.phase_since ? Date.parse(stateObj.phase_since) : NaN;
    const elapsed = isFinite(started) ? (Date.now() - started) / 60000 : 0;
    const pct = TERMINAL.indexOf(phase) !== -1 ? 100
      : (planned ? Math.max(2, Math.min(98, Math.round((elapsed / planned) * 100))) : 2);
    $('#eta-bar').style.width = `${pct}%`;

    const signature = JSON.stringify([
      tag, phase, runStart, stateObj.kaggle_status, stateObj.status_stale, totals,
      slotRows.map((s) => [s.n, s.result, s.file, s.sheet]),
      files.map((f) => [f.name, f.mb]),
    ]);
    if (signature === panelSig) return;
    panelSig = signature;

    $('#run-summary').replaceChildren();
    $('#slot-table-wrap').replaceChildren();
    $('#downloads').replaceChildren();
    $('#log-links').replaceChildren();

    const line = node('p', 'phase-line');
    if (phase === 'DONE') line.textContent = t('done', { ok: totals.ok, n: slotCount });
    else if (phase === 'PARTIAL') line.textContent = t('partial', { f: totals.failed });
    else if (phase === 'FAILED') line.textContent = t('failed', { reason: stateObj.error || 'unknown' });
    else if (phase === 'CANCELLED') line.textContent = t('cancelled', { reason: stateObj.error || 'stopped by the operator' });
    else line.textContent = t(PHASE_KEY[phase] || 'phase_staging');
    const meta = node('p', 'run-meta');
    meta.appendChild(pill(phase));
    meta.appendChild(document.createTextNode(` ${tag}`));
    $('#run-summary').appendChild(line);
    $('#run-summary').appendChild(meta);

    if (slotRows.length) {
      const table = node('table', 'slot-table');
      const thead = node('thead');
      const hrow = node('tr');
      const heads = ['Slot', 'Prompt', 'Duration', 'Time elapsed', 'Result'];
      heads.forEach((h) => hrow.appendChild(node('th', null, h)));
      thead.appendChild(hrow);
      table.appendChild(thead);
      const tbody = node('tbody');
      slotRows.forEach((s) => {
        const row = node('tr');
        const prompt = s.prompt || '';
        const shown = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
        const secs = s.frames ? (s.frames / 24).toFixed(2) : s.seconds;
        const slotTd = node('td', null, s.n);
        slotTd.dataset.th = heads[0];
        row.appendChild(slotTd);

        const promptTd = node('td', 'prompt-cell');
        promptTd.dataset.th = heads[1];
        promptTd.appendChild(node('span', 'prompt-text', shown));
        if (prompt) {
          const btn = copyButton(`Copy prompt for slot ${s.n}`);
          btn.addEventListener('click', () => copyPrompt(prompt, btn));
          promptTd.appendChild(btn);
        }
        row.appendChild(promptTd);

        const durTd = node('td', null, `${secs} s`);
        durTd.dataset.th = heads[2];
        row.appendChild(durTd);
        const elapsedCell = node('td', 'elapsed', isLive
          ? fmtHMS(Date.now() - runStart)
          : (s.wall_seconds != null ? fmtHMS(Number(s.wall_seconds) * 1000)
            : (finalMs > 0 ? fmtHMS(finalMs) : '—')));
        elapsedCell.dataset.th = heads[3];
        if (isLive) elapsedCell.dataset.elapsed = '1';
        row.appendChild(elapsedCell);
        const resultCell = node('td');
        resultCell.dataset.th = heads[4];
        resultCell.appendChild(pill(s.result || 'pending'));
        row.appendChild(resultCell);
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      $('#slot-table-wrap').appendChild(table);
    }

    files.forEach((f) => {
      const href = `${PREFIX}/api/runs/${encodeURIComponent(tag)}/files/${encodeURIComponent(f.name)}`;
      const clip = node('figure', 'clip');
      const player = document.createElement('video');
      player.controls = true;
      player.preload = 'metadata';
      player.src = href;
      player.className = 'clip-player';
      clip.appendChild(player);
      const links = node('div', 'clip-links');
      links.appendChild(link(href,
        t('download_row', { n: f.n, s: Number(f.seconds).toFixed(2), mb: f.mb }), 'download-link'));
      if (f.sheet) {
        const sheet = `${PREFIX}/api/runs/${encodeURIComponent(tag)}/files/${encodeURIComponent(f.sheet)}`;
        links.appendChild(link(sheet, `Contact sheet for slot ${f.n}`, 'sheet-link'));
      }
      clip.appendChild(links);
      $('#downloads').appendChild(clip);
    });
    if (files.length) {
      fx((g) => g.from('#downloads .clip',
        { y: 20, opacity: 0, duration: .55, stagger: .09, ease: 'power3.out', clearProps: 'transform,opacity' }));
    }
    $('#log-links').appendChild(
      link(`${PREFIX}/api/runs/${encodeURIComponent(tag)}/log?which=push`, 'Push log'));
    $('#log-links').appendChild(
      link(`${PREFIX}/api/runs/${encodeURIComponent(tag)}/log?which=render`, 'Render log'));
  }

  let historySig = '';

  function renderHistory() {
    const runs = board.runs || [];
    const sig = JSON.stringify(runs.map((r) => [
      r.tag, r.phase, r.totals && r.totals.ok, r.totals && r.totals.failed,
      r.quota_cost_h, (r.files || []).map((f) => f.name),
    ]));
    if (sig === historySig) return;
    historySig = sig;
    const list = $('#history-list');
    list.replaceChildren();
    if (!runs.length) {
      list.appendChild(node('li', 'hist-empty', 'No renders yet. Your finished videos will show up here.'));
      return;
    }
    runs.forEach((r) => {
      const li = node('li');
      const totals = r.totals || { ok: 0, failed: 0 };
      const enc = encodeURIComponent(r.tag);
      const top = node('div', 'hist-top');
      top.appendChild(link(`${PREFIX}/api/runs/${enc}`, r.tag, 'hist-tag'));
      top.appendChild(pill(r.phase || '?'));
      top.appendChild(node('span', 'hist-meta',
        `${fmtStamp(r.submitted_at)} · ${totals.ok}/${r.slots} clips · ${r.quota_cost_h == null ? '?' : r.quota_cost_h} h GPU`));
      li.appendChild(top);
      const actions = node('div', 'hist-actions');
      (r.files || []).forEach((f) => {
        actions.appendChild(link(
          `${PREFIX}/api/runs/${enc}/files/${encodeURIComponent(f.name)}`,
          t('download_row', { n: f.n, s: Number(f.seconds).toFixed(2), mb: f.mb }),
          'download-link'));
      });
      actions.appendChild(link(`${PREFIX}/api/runs/${enc}/log?which=render`, 'log'));
      if (TERMINAL.indexOf(r.phase) !== -1) {
        const del = node('button', 'danger small', 'Delete');
        del.type = 'button';
        del.addEventListener('click', () => removeRun(r.tag));
        actions.appendChild(del);
      }
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  async function removeRun(tag) {
    if (!window.confirm(`Delete ${tag} and its clips from this server?`)) return;
    try {
      const r = await fetch(`${PREFIX}/api/runs/${encodeURIComponent(tag)}/delete`, { method: 'POST', headers: writeHeaders() });
      if (!r.ok) throw new Error('delete refused');
      showHistoryNote(t('deleted'));
      await pollNow();
    } catch (e) { showHistoryNote(`Could not delete ${tag}: ${e.message}`); }
  }

  function renderAll() {
    renderBanner();
    renderFormLock();
    renderEstimate();
    renderRunPanel();
    renderHistory();
  }

  // ---- Polling (SPEC §8.3) --------------------------------------------------
  let timer = null;
  async function pollNow() {
    // Reading the board while a submission is in flight can only return a board
    // that predates it — and applying that board would unlock the form mid-push.
    if (submitting) { schedulePoll(); return; }
    const seq = ++pollSeq;
    const startedAt = Date.now();
    try {
      const r = await fetch(PREFIX + '/api/state', { cache: 'no-store' });
      // Drop an answer that a newer poll replaced, or that was requested before a
      // run was accepted: both are older than what this page already knows.
      const stale = seq !== pollSeq || !!submitting || startedAt < boardFloorAt;
      if (!stale && r.ok) { board = await r.json(); board.config = board.config || cfg; renderAll(); }
    } catch (e) { /* keep the last known board; never invent a status */ }
    clearTimeout(timer);
    timer = setTimeout(pollNow, board.active ? BUSY_MS : IDLE_MS);
  }
  function schedulePoll() {
    clearTimeout(timer);
    timer = setTimeout(pollNow, board.active ? BUSY_MS : IDLE_MS);
  }

  // ---- Slot interactions ----------------------------------------------------
  function validImage(buffer) {
    const b = new Uint8Array(buffer);
    if (b[0] === 0xff && b[1] === 0xd8) return true;
    if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((v, i) => b[i] === v)) return true;
    if (b.length >= 12 && String.fromCharCode.apply(null, b.subarray(0, 4)) === 'RIFF'
      && String.fromCharCode.apply(null, b.subarray(8, 12)) === 'WEBP') return true;
    return false;
  }

  // A data URL (not blob:) keeps the preview inside the nginx CSP's img-src.
  function preview(n, file) {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const canvas = $(`[data-canvas="${n}"]`);
        const ctx = canvas.getContext('2d');
        const ratio = canvas.width / canvas.height;
        let sx = 0, sy = 0, sw = image.naturalWidth, sh = image.naturalHeight;
        if (sw / sh > ratio) { const keep = sh * ratio; sx = (sw - keep) / 2; sw = keep; }
        else { const keep = sw / ratio; sy = (sh - keep) / 2; sh = keep; }
        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        canvas.hidden = false;
        $(`[data-drop="${n}"]`).classList.add('has-image');
        fx((g) => {
          g.fromTo(canvas, { scale: 1.1, opacity: 0 }, { scale: 1, opacity: 1, duration: .6, ease: 'power3.out', clearProps: 'transform,opacity' });
          g.fromTo(cardEl(n), { scale: .985 }, { scale: 1, duration: .55, ease: 'back.out(3)', clearProps: 'transform' });
        });
      };
      image.onerror = () => setSlotError(n, t('image_wrong_type', { n }));
      image.src = String(reader.result);
    };
    reader.onerror = () => setSlotError(n, t('image_wrong_type', { n }));
    reader.readAsDataURL(file);
  }

  function acceptFile(n, file) {
    // A drop can land on the card even while the fieldset is disabled, and the
    // payload for a submission already in flight has been read.
    if (!file || locked()) return;
    if (file.size > MAXBYTES) {
      setSlotError(n, t('image_too_big', { n, mb: (file.size / 1048576).toFixed(1) }));
      return;
    }
    file.arrayBuffer().then((buf) => {
      if (!validImage(buf)) {
        setSlotError(n, t('image_wrong_type', { n }));
        return;
      }
      const slot = byN(n);
      slot.file = file;
      slot.name = file.name;
      setSlotError(n, '');
      $(`[data-imagename="${n}"]`).textContent = file.name;
      preview(n, file);
      refreshSlot(n);
      renderEstimate();
    }).catch(() => setSlotError(n, t('image_wrong_type', { n })));
  }

  function clearSlot(n) {
    const slot = byN(n);
    slot.file = null;
    slot.name = '';
    promptEl(n).value = '';
    $(`[data-imagename="${n}"]`).textContent = '';
    $(`[data-drop="${n}"]`).classList.remove('has-image');
    const canvas = $(`[data-canvas="${n}"]`);
    canvas.hidden = true;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    const input = $(`[data-file="${n}"]`);
    input.value = '';
    setSlotError(n, '');
    updateSlotUI(n);
    autoGrow(n);
    renderEstimate();
    fx((g) => g.fromTo(cardEl(n), { opacity: .45 }, { opacity: 1, duration: .45, ease: 'power2.out', clearProps: 'opacity' }));
  }

  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('could not read image'));
      reader.readAsDataURL(file);
    });
  }

  function validate() {
    let ok = true;
    slots.forEach((s) => {
      const n = s.n;
      const prompt = promptEl(n).value;
      const secs = seconds(n);
      if (!prompt.trim() && !s.file) { setSlotError(n, ''); return; }
      if (!prompt.trim()) { setSlotError(n, t('prompt_required', { n })); ok = false; return; }
      if (prompt.trim().length > MAXCHARS) {
        setSlotError(n, t('prompt_long', { n }));
        ok = false;
        return;
      }
      if (!Number.isInteger(secs) || secs < MIN || secs > MAX) {
        setSlotError(n, t('seconds_range', { n }));
        ok = false;
        return;
      }
      setSlotError(n, '');
    });
    if (!slots.some(filled)) { showFormError('Fill at least one slot.'); return false; }
    return ok;
  }

  // ---- Submitting ------------------------------------------------------------
  // The click has to change the page before anything is awaited: the POST below
  // spends seconds waiting on the server's live quota read, and silence in that
  // window is what makes people click again or reload mid-push.
  function beginSubmit() {
    submitting = Date.now();
    showFormError('');
    renderAll();
    window.scrollTo({ top: 0, behavior: SMOOTH });
    clearInterval(submitTicker);
    submitTicker = setInterval(renderBanner, 1000);
  }
  function endSubmit() {
    clearInterval(submitTicker);
    submitTicker = null;
    submitting = null;
  }

  async function submit(event) {
    event.preventDefault();
    if (locked()) return;
    if (!validate()) {
      const bad = $('.slot-card.invalid');
      if (bad) bad.scrollIntoView({ behavior: SMOOTH, block: 'center' });
      else promptEl(1).focus();
      return;
    }
    beginSubmit();
    let accepted = null;
    let failure = '';
    try {
      const active = slots.filter(filled);
      const payloadSlots = [];
      for (const s of active) {
        const item = { n: s.n, prompt: promptEl(s.n).value.trim(), seconds: seconds(s.n) };
        if (s.file) {
          item.image_base64 = await toBase64(s.file);
          item.image_name = s.name;
        }
        payloadSlots.push(item);
      }
      const submissionId = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const payload = {
        submission_id: submissionId, note: $('#run-note').value, slots: payloadSlots,
      };
      let r, data;
      try {
        r = await fetch(PREFIX + '/api/submissions', {
          method: 'POST', headers: writeHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(payload),
        });
        data = await r.json().catch(() => ({}));
      } catch (e) {
        // The answer never arrived, so whether a run started is unknown. The form
        // unlocks (a dead page helps nobody) and the message says to check: the
        // server still refuses a duplicate through its busy check and its
        // one-a-minute rule, so a retry cannot quietly start the same work twice.
        failure = `Submit failed: ${e.message}. Reload the page to see whether the run started before trying again.`;
        return;
      }
      if (r.status === 409) {
        failure = t('busy_409');
        board.active = { tag: data.active_tag || '', phase: data.phase || 'QUEUED' };
        boardFloorAt = Date.now();
        return;
      }
      if (r.status === 422 && data.need_h != null) {
        failure = t('quota_422', { need: data.need_h, left: data.left_h });
        return;
      }
      if (!r.ok) { failure = data.error || `Submit failed (${r.status}).`; return; }
      accepted = data;
    } finally {
      endSubmit();
      if (accepted) {
        board.active = { tag: accepted.tag, phase: accepted.phase || 'QUEUED' };
        boardFloorAt = Date.now();
        $('#run-note').value = '';
        window.scrollTo({ top: 0, behavior: SMOOTH });
      }
      renderAll();
      // renderAll() clears a stale error when the form is free, so the message for
      // this attempt has to be written after it, not before.
      if (failure) showFormError(failure);
      // A fresh board right away: the submit response carries only the tag and the
      // phase, so without this the banner would read "0/0 slots" for five seconds.
      if (accepted) { clearTimeout(timer); pollNow(); } else schedulePoll();
    }
  }

  async function cancel(tag, phase) {
    if (!tag) return;
    const finished = phase === 'KERNEL_COMPLETE' || phase === 'DOWNLOADING' || phase === 'VERIFYING';
    const confirmBtn = $('#stop-confirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = t('stop_working');
    try {
      const r = await fetch(`${PREFIX}/api/runs/${encodeURIComponent(tag)}/cancel`,
        { method: 'POST', headers: writeHeaders() });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `cancel refused (${r.status})`);
      closeStopDialog();
      const done = data.remote
        ? (data.remote.gone ? t('stop_ok_gone') : t('stop_ok_remote'))
        : (finished ? t('stop_ok_finished') : t('stop_ok_local'));
      showStopMsg(done);
      await pollNow();
    } catch (e) {
      // The server refused to fake it: the run is still live and the message says
      // what to do instead. Keep the box open so it can be read.
      const box = $('#stop-error');
      box.textContent = e.message;
      box.hidden = false;
      confirmBtn.textContent = t('stop_button');
      confirmBtn.disabled = $('#stop-input').value.trim().toLowerCase() !== tag.toLowerCase();
    }
  }

  function showStopMsg(message) {
    const el = $('#stop-msg');
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  function closeStopDialog() {
    const dialog = $('#stop-dialog');
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  // Stopping is not a button in the dock any more: it sits at the bottom of the
  // run panel as a quiet text link and asks for the run tag, because a cancel
  // that deletes a Kaggle kernel should never be one stray click away.
  let stopTarget = { tag: null, phase: null, ref: null };

  function renderStopZone(phase, tag, stateObj) {
    const zone = $('#stop-zone');
    if (!zone) return;
    const live = !!tag && TERMINAL.indexOf(phase) === -1;
    if (!live) {
      zone.hidden = true;
      zone.replaceChildren();
      zone.dataset.tag = '';
      stopTarget = { tag: null, phase: null, ref: null };
      return;
    }
    if (zone.dataset.tag !== tag) showStopMsg('');
    zone.dataset.tag = tag;
    stopTarget = {
      tag, phase,
      ref: (stateObj && stateObj.kernel_ref) || tag,
    };
    if (!zone.firstChild) {
      const btn = node('button', 'stop-link', t('stop_link'));
      btn.type = 'button';
      btn.addEventListener('click', openStopDialog);
      zone.replaceChildren(btn);
    }
    zone.hidden = false;
  }

  function openStopDialog() {
    const { tag, phase, ref } = stopTarget;
    if (!tag || submitting) return;
    const remote = phase === 'PUSHED' || phase === 'GPU_QUEUED' || phase === 'RENDERING';
    const finished = phase === 'KERNEL_COMPLETE' || phase === 'DOWNLOADING' || phase === 'VERIFYING';
    const lede = finished ? t('stop_lede_finished')
      : (remote ? t('stop_lede_remote', { ref }) : t('stop_lede_local'));
    const dialog = $('#stop-dialog');
    $('#stop-title').textContent = t('stop_title');
    $('#stop-lede').textContent = lede;
    $('#stop-type-label').textContent = t('stop_type', { tag });
    const input = $('#stop-input');
    input.value = '';
    const box = $('#stop-error');
    box.hidden = true;
    box.textContent = '';
    const confirmBtn = $('#stop-confirm');
    confirmBtn.textContent = t('stop_button');
    confirmBtn.disabled = true;
    $('#stop-keep').textContent = t('stop_keep');
    if (!dialog) {
      if (window.confirm(`${t('stop_title')}\n\n${lede}`)) cancel(tag, phase);
      return;
    }
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', 'open');
    setTimeout(() => input.focus(), 30);
  }

  function hasFiles(e) {
    return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1);
  }
  function setDragging(drop, on) {
    if (drop.classList.contains('dragging') === on) return;
    drop.classList.toggle('dragging', on);
    fx((g) => g.to(drop, { scale: on ? 1.03 : 1, duration: .28, ease: 'back.out(2)', overwrite: 'auto' }));
  }

  cards.forEach((card) => {
    const n = Number(card.dataset.slot);
    const drop = $(`[data-drop="${n}"]`);
    const input = $(`[data-file="${n}"]`);
    const icon = $('.drop-icon', drop);
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    drop.addEventListener('mouseenter', () => {
      if (drop.classList.contains('has-image')) return;
      fx((g) => g.fromTo(icon, { y: 0 }, { y: -5, duration: .22, yoyo: true, repeat: 1, ease: 'power1.out', overwrite: 'auto', clearProps: 'transform' }));
    });

    // Drop an image anywhere on the card, not just on the picture area.
    let depth = 0;
    card.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth += 1; setDragging(drop, true);
    });
    card.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    });
    card.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(drop, false);
    });
    card.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; setDragging(drop, false);
      if (e.dataTransfer.files[0]) acceptFile(n, e.dataTransfer.files[0]);
    });

    input.addEventListener('change', () => acceptFile(n, input.files[0]));
    secondsEl(n).addEventListener('input', () => {
      updateSlotUI(n);
      renderEstimate();
      fx((g) => g.fromTo(`[data-label="${n}"]`, { y: -2, scale: 1.1, transformOrigin: '100% 50%' },
        { y: 0, scale: 1, duration: .25, ease: 'power2.out', overwrite: 'auto', clearProps: 'transform' }));
    });
    promptEl(n).addEventListener('input', () => {
      setSlotError(n, '');
      updateSlotUI(n);
      autoGrow(n);
      renderEstimate();
    });
    promptEl(n).addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        $('#submit-form').requestSubmit();
      }
    });
    $(`[data-clear="${n}"]`).addEventListener('click', () => clearSlot(n));
  });

  // Keep a stray image drop from navigating the browser away from the form.
  ['dragover', 'drop'].forEach((kind) => document.addEventListener(kind, (e) => {
    if (hasFiles(e)) e.preventDefault();
  }));

  // Paste a screenshot or copied image: it goes to the focused card, else the first card without one.
  document.addEventListener('paste', (e) => {
    if (locked() || !e.clipboardData) return;
    const image = Array.from(e.clipboardData.files || []).find((f) => /^image\//.test(f.type));
    if (!image) return;
    const host = document.activeElement && document.activeElement.closest
      ? document.activeElement.closest('.slot-card') : null;
    const target = host ? Number(host.dataset.slot) : (slots.find((s) => !s.file) || slots[0]).n;
    e.preventDefault();
    acceptFile(target, image);
  });

  $('#copy-prompt').addEventListener('click', () => {
    const source = slots.map((s) => promptEl(s.n).value.trim()).find((v) => v.length > 0);
    if (!source) { showFormError('Type a prompt in one slot first.'); return; }
    slots.forEach((s) => { promptEl(s.n).value = source; setSlotError(s.n, ''); });
    updateCounters();
    fx((g) => g.fromTo(cards, { scale: .975 },
      { scale: 1, duration: .55, ease: 'back.out(3)', stagger: .06, overwrite: 'auto', clearProps: 'transform' }));
  });
  $('#submit-form').addEventListener('submit', submit);

  // Stop dialog: the run tag has to be typed exactly before the button accepts a click.
  const stopInput = $('#stop-input');
  const stopConfirm = $('#stop-confirm');
  if (stopInput && stopConfirm) {
    const matches = () => stopTarget.tag
      && stopInput.value.trim().toLowerCase() === stopTarget.tag.toLowerCase();
    stopInput.addEventListener('input', () => {
      stopConfirm.disabled = !matches();
      $('#stop-error').hidden = true;
    });
    stopInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !stopConfirm.disabled) { e.preventDefault(); stopConfirm.click(); }
    });
    stopConfirm.addEventListener('click', () => {
      if (matches()) cancel(stopTarget.tag, stopTarget.phase);
    });
    const keep = $('#stop-keep');
    if (keep) keep.addEventListener('click', closeStopDialog);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { clearTimeout(timer); pollNow(); }
  });

  // Buttons squish on press and spring back.
  let pressed = null;
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('#submit-button, #copy-prompt, #stop-confirm, #stop-keep, .slot-clear');
    if (!b || b.disabled) return;
    pressed = b;
    fx((g) => g.to(b, { scale: .95, duration: .12, ease: 'power2.out', overwrite: 'auto' }));
  });
  ['pointerup', 'pointercancel'].forEach((kind) => document.addEventListener(kind, () => {
    if (!pressed) return;
    const b = pressed;
    pressed = null;
    fx((g) => g.to(b, { scale: 1, duration: .6, ease: 'elastic.out(1, .45)', overwrite: 'auto', clearProps: 'transform' }));
  }));

  // One orchestrated moment on load: header, headline, film frames flick on, cards settle in.
  function intro() {
    fx((g) => {
      const tl = g.timeline({ defaults: { ease: 'power3.out' } });
      tl.from('.brand, .topbar-sub', { y: -10, opacity: 0, duration: .5, stagger: .06, clearProps: 'transform,opacity' })
        .from('.hero h1, .hero-copy p', { y: 22, opacity: 0, duration: .7, stagger: .1, clearProps: 'transform,opacity' }, '-=.3')
        .from('.pip', { scale: .4, opacity: 0, duration: .45, stagger: .07, ease: 'back.out(2.4)', clearProps: 'transform,opacity' }, '-=.55')
        .from('.strip-text', { y: 8, opacity: 0, duration: .4, clearProps: 'transform,opacity' }, '-=.2')
        .from('.slot-card', { y: 28, opacity: 0, duration: .6, stagger: .07, clearProps: 'transform,opacity' }, '-=.45');
      // Safety net: never leave content hidden if the tab was in the background.
      setTimeout(() => tl.progress(1), 4000);
    });
  }

  $$('.prompt-foot').forEach((foot) => {
    const card = foot.closest('.slot-card');
    const n = Number(card && card.dataset.slot);
    if (!n) return;
    const btn = copyButton(`Copy prompt for slot ${n}`);
    btn.dataset.copy = String(n);
    btn.addEventListener('click', () => copyPrompt(promptEl(n).value, btn));
    foot.insertBefore(btn, foot.firstChild);
  });

  updateCounters();
  renderAll();
  schedulePoll();
  booted = true;
  intro();
}());
