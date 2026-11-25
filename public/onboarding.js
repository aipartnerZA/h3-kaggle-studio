'use strict';

/* First-run setup. The server owns the state; this file only renders it and posts to it.
   Nothing here decides whether the studio may be used — every studio route is gated server-side.
   There is one legal pane: the terms, scroll-gated. It cannot be skipped by swiping. */

(function () {
  var boot = {};
  try {
    var t = document.getElementById('ob-bootstrap');
    // A <template>'s text lives in its content fragment, not in textContent.
    var raw = t ? (t.content ? t.content.textContent : t.textContent) : '';
    boot = JSON.parse(raw || '{}') || {};
  } catch (e) { boot = {}; }

  var PREFIX = (boot.prefix || '').replace(/\/$/, '');
  var api = function (p) { return PREFIX + p; };

  // How close to the bottom counts as "read to the end", in CSS pixels.
  var END_TOLERANCE = 2;

  var STRINGS = {
    rejected: 'That token did not work. Kaggle answered "authentication required" — the token may be incomplete or already revoked. Copy the whole token again from kaggle.com/settings/api.',
    forbidden: 'Kaggle rejected the token with 403. This usually means your account has not finished phone or identity verification. Complete it at kaggle.com/settings, then press Verify again.',
    unreachable: 'Could not reach Kaggle. Check this machine\'s internet connection, then press Verify again.',
    old_cli: 'This needs the Kaggle command-line tool version 2 or later. Upgrade it with: pip install --upgrade kaggle'
  };

  var $ = function (id) { return document.getElementById(id); };
  var PAGES = 3;
  var pane = 0;

  function steps(index) {
    var items = document.querySelectorAll('.ob-step');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('is-done', i < index);
      items[i].classList.toggle('is-current', i === index);
      items[i].setAttribute('aria-current', i === index ? 'step' : 'false');
    }
  }

  function go(index) {
    pane = Math.max(0, Math.min(PAGES - 1, index));
    var panes = document.querySelectorAll('.ob-pane');
    for (var i = 0; i < panes.length; i++) panes[i].hidden = (i !== pane);
    steps(pane);
    if (pane === 1) {
      var field = $('token');
      if (field) field.focus();
    }
  }

  function post(url, body) {
    return fetch(api(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { status: r.status, body: j };
      });
    });
  }

  function showReady(state) {
    var who = state && state.username ? state.username : 'your account';
    var q = state && state.quota;
    var line = 'Connected as ' + who + '.';
    if (q && typeof q.remaining_h === 'number') {
      line += ' ' + q.remaining_h + ' GPU hours left this week';
      if (q.reset_sast) line += ', resetting ' + q.reset_sast;
      line += '.';
    }
    $('ready-line').textContent = line;
    go(2);
  }

  // ---- pane 1: the terms, read to the end -----------------------------------
  // The button stays disabled until the box has been scrolled to its bottom. No checkbox, no swipe:
  // the only way forward is to read it.
  function termsRead() {
    var box = $('ob-terms');
    if (!box) return true;
    // Content shorter than the box (a very tall window) has nothing left to scroll.
    if (box.scrollHeight - box.clientHeight <= END_TOLERANCE) return true;
    return box.scrollTop + box.clientHeight >= box.scrollHeight - END_TOLERANCE;
  }

  function syncTerms() {
    var box = $('ob-terms');
    var next = $('ob-continue');
    var hint = $('ob-hint');
    if (!box || !next) return;
    var read = termsRead();
    if (!next.classList.contains('is-busy')) next.disabled = !read;
    box.classList.toggle('is-read', read);
    if (hint) hint.hidden = read;
  }

  function showBlocked() {
    var blocked = $('ob-blocked');
    var actions = $('ob-terms-actions');
    var box = $('ob-terms');
    if (blocked) blocked.hidden = false;
    if (actions) actions.hidden = true;
    if (box) box.hidden = true;
    var hint = $('ob-hint');
    if (hint) hint.hidden = true;
  }

  function bindTerms() {
    var box = $('ob-terms');
    var next = $('ob-continue');
    var excluded = $('ob-excluded');
    var err = $('ob-error');

    if (box) {
      box.addEventListener('scroll', syncTerms, { passive: true });
      // Wheel and keyboard scrolling both land here; resize changes the box height.
      box.addEventListener('keydown', function () { setTimeout(syncTerms, 0); });
    }
    window.addEventListener('resize', syncTerms);

    if (next) {
      next.addEventListener('click', function () {
        if (next.disabled) return;
        next.classList.add('is-busy');
        next.disabled = true;
        next.textContent = 'Saving…';
        if (err) err.hidden = true;
        post('/api/setup/licence', { accepted: true, tos_ack: true, territory: 'applicable' })
          .then(function (r) {
            next.classList.remove('is-busy');
            next.textContent = 'Continue';
            if (r.status === 200) { go(1); return; }
            if (r.status === 451) { showBlocked(); return; }
            if (err) {
              err.hidden = false;
              err.textContent = 'The acknowledgement could not be saved. Check that cookies and this address are not blocked, then try again.';
            }
            syncTerms();
          })
          .catch(function () {
            next.classList.remove('is-busy');
            next.textContent = 'Continue';
            if (err) { err.hidden = false; err.textContent = STRINGS.unreachable; }
            syncTerms();
          });
      });
    }

    // A single click declares the exclusion, so the territory answer is never given by silence.
    if (excluded) {
      excluded.addEventListener('click', function () {
        excluded.disabled = true;
        post('/api/setup/licence', { accepted: true, tos_ack: true, territory: 'excluded' })
          .then(function () { showBlocked(); })
          .catch(function () {
            excluded.disabled = false;
            if (err) { err.hidden = false; err.textContent = STRINGS.unreachable; }
          });
      });
    }
  }

  // ---- pane 2: credentials --------------------------------------------------
  function setBusy(on) {
    var b = $('verify');
    if (!b) return;
    b.classList.toggle('is-busy', !!on);
    b.disabled = !!on;
    b.textContent = on ? 'Checking…' : 'Verify';
  }

  function credResult(status, body) {
    var ok = $('cred-ok');
    var bad = $('cred-err');
    ok.hidden = true;
    bad.hidden = true;

    if (status === 200) {
      var who = body && body.username ? body.username : 'your account';
      ok.hidden = false;
      ok.textContent = 'Connected as ' + who + '.';
      showReady(body);
      return true;
    }
    bad.hidden = false;
    bad.textContent = STRINGS[(body && body.reason) || 'rejected'] || STRINGS.rejected;
    return false;
  }

  function submitToken(token) {
    if (!token || !token.trim()) {
      $('cred-err').hidden = false;
      $('cred-err').textContent = 'Paste the token first. It is one long string with no spaces.';
      return;
    }
    setBusy(true);
    post('/api/setup/credentials', { token: token.trim() })
      .then(function (r) { setBusy(false); credResult(r.status, r.body); })
      .catch(function () {
        setBusy(false);
        $('cred-err').hidden = false;
        $('cred-err').textContent = STRINGS.unreachable;
      });
  }

  function submitFile(file) {
    if (!file) return;
    var fd = new FormData();
    fd.append('file', file, file.name || 'kaggle.json');
    setBusy(true);
    fetch(api('/api/setup/credentials'), { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          setBusy(false);
          credResult(r.status, j);
        });
      })
      .catch(function () {
        setBusy(false);
        $('cred-err').hidden = false;
        $('cred-err').textContent = STRINGS.unreachable;
      });
  }

  function bindCredentials() {
    var form = $('cred-form');
    if (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        submitToken($('token').value);
      });
    }

    var drop = $('drop');
    var input = $('file');
    var text = drop ? drop.querySelector('.ob-drop-text') : null;

    if (drop && input) {
      drop.addEventListener('click', function () { input.click(); });
      drop.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); input.click(); }
      });
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        if (f && text) text.textContent = f.name;
        submitFile(f);
      });
      ['dragenter', 'dragover'].forEach(function (evt) {
        drop.addEventListener(evt, function (ev) { ev.preventDefault(); drop.classList.add('is-over'); });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        drop.addEventListener(evt, function (ev) { ev.preventDefault(); drop.classList.remove('is-over'); });
      });
      drop.addEventListener('drop', function (ev) {
        var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (f && text) text.textContent = f.name;
        submitFile(f);
      });
    }
  }

  // ---- polling --------------------------------------------------------------
  function poll() {
    fetch(api('/api/setup'), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (!s) return;
        if (s.state === 'ready' && pane !== 2) showReady(s);
      })
      .catch(function () { /* the panel is usable without the poll */ });
  }

  function boot_() {
    bindTerms();
    bindCredentials();

    var open = $('open-studio');
    if (open) {
      open.addEventListener('click', function () { window.location.replace(api('/') || '/'); });
    }

    var mock = $('mock-flag');
    if (mock && boot.mock) mock.hidden = false;

    // Resume where the server says they are.
    if (boot.excluded) {
      go(0);
      showBlocked();
    } else if (boot.state === 'ready') {
      showReady(boot);
    } else if (boot.state === 'licence_ok') {
      go(1);
    } else {
      go(0);
      syncTerms();
    }

    setInterval(poll, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot_);
  } else {
    boot_();
  }
})();
