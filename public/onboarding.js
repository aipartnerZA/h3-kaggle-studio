'use strict';

/* First-run setup. The server owns the state; this file only renders it and posts to it.
   Nothing here decides whether the studio may be used — every studio route is gated server-side. */

(function () {
  var boot = {};
  try {
    var t = document.getElementById('ob-bootstrap');
    boot = JSON.parse(t ? t.textContent : '{}') || {};
  } catch (e) { boot = {}; }

  var PREFIX = (boot.prefix || '').replace(/\/$/, '');
  var api = function (p) { return PREFIX + p; };

  var STRINGS = {
    rejected: 'That token did not work. Kaggle answered "authentication required" — the token may be incomplete or already revoked. Copy the whole token again from kaggle.com/settings/api.',
    forbidden: 'Kaggle rejected the token with 403. This usually means your account has not finished phone or identity verification. Complete it at kaggle.com/settings, then press Verify again.',
    unreachable: 'Could not reach Kaggle. Check this machine\'s internet connection, then press Verify again.',
    old_cli: 'This needs the Kaggle command-line tool version 2 or later. Upgrade it with: pip install --upgrade kaggle'
  };

  var $ = function (id) { return document.getElementById(id); };
  var swiper = null;
  var licence = { accepted: false, tos_ack: false, territory: null };
  var blocked = false;

  function steps(index) {
    var items = document.querySelectorAll('.ob-step');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('is-done', i < index);
      items[i].classList.toggle('is-current', i === index);
      items[i].setAttribute('aria-current', i === index ? 'step' : 'false');
    }
  }

  function go(index) {
    if (!swiper) return;
    swiper.slideTo(index);
  }

  function applyPolicies(index) {
    // Panes 2 and 3 (index 1 and 2) may only be advanced by their own button: a swipe would be a bypass.
    var locked = (index === 1 || index === 2);
    if (swiper) {
      swiper.allowTouchMove = !locked;
      swiper.keyboard.enabled = true;
    }
    steps(index);
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
    go(5);
  }

  // ---- pane 2: licence ------------------------------------------------------
  function licenceValid() {
    return $('lic-a').checked && $('lic-b').checked && licence.territory === 'applicable';
  }

  function syncLicence() {
    var radio = document.querySelector('input[name="territory"]:checked');
    licence.territory = radio ? radio.value : null;

    var warn = $('territory-blocked');
    if (licence.territory === 'excluded') {
      blocked = true;
      warn.hidden = false;
      $('lic-next').disabled = true;
    } else {
      if (!blocked) warn.hidden = true;
      $('lic-next').disabled = !licenceValid();
    }
  }

  function bindPane2() {
    ['lic-a', 'lic-b'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('change', syncLicence);
    });
    var radios = document.querySelectorAll('input[name="territory"]');
    for (var i = 0; i < radios.length; i++) radios[i].addEventListener('change', syncLicence);
    var next = $('lic-next');
    if (next) {
      next.addEventListener('click', function () {
        next.disabled = true;
        next.textContent = 'Saving…';
        post('/api/setup/licence', {
          accepted: $('lic-a').checked,
          tos_ack: $('lic-b').checked,
          territory: licence.territory
        }).then(function (r) {
          next.textContent = 'I understand';
          if (r.status === 451) {
            blocked = true;
            $('territory-blocked').hidden = false;
            next.disabled = true;
            return;
          }
          if (r.status !== 200) {
            var e = $('lic-error');
            e.hidden = false;
            e.textContent = 'The acknowledgement could not be saved. Check that cookies and this address are not blocked, then try again.';
            next.disabled = !licenceValid();
            return;
          }
          licence.accepted = true;
          go(2);
        }).catch(function () {
          next.textContent = 'I understand';
          var e = $('lic-error');
          e.hidden = false;
          e.textContent = STRINGS.unreachable;
          next.disabled = !licenceValid();
        });
      });
    }
  }

  // ---- pane 3: Kaggle terms -------------------------------------------------
  function bindPane3() {
    var ack = $('tos-ack');
    var next = $('tos-next');
    if (ack && next) {
      ack.addEventListener('change', function () { next.disabled = !ack.checked; });
      next.addEventListener('click', function () {
        next.disabled = true;
        next.textContent = 'Saving…';
        post('/api/setup/licence', {
          accepted: $('lic-a').checked,
          tos_ack: ack.checked,
          territory: licence.territory
        }).then(function (r) {
          next.textContent = 'I understand';
          if (r.status === 200) {
            licence.tos_ack = true;
            go(3);
            return;
          }
          next.disabled = !ack.checked;
          var e = $('tos-error');
          e.hidden = false;
          e.textContent = r.status === 451
            ? 'This studio will not render for you in an excluded territory.'
            : STRINGS.unreachable;
        }).catch(function () {
          next.textContent = 'I understand';
          next.disabled = !ack.checked;
          var e = $('tos-error');
          e.hidden = false;
          e.textContent = STRINGS.unreachable;
        });
      });
    }
  }

  // ---- pane 5: credentials --------------------------------------------------
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

  function bindPane5() {
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
        if (s.state === 'ready' && swiper && swiper.activeIndex !== 5) showReady(s);
      })
      .catch(function () { /* the panel is usable without the poll */ });
  }

  function boot_() {
    bindPane2();
    bindPane3();
    bindPane5();

    var open = $('open-studio');
    if (open) {
      open.addEventListener('click', function () { window.location.replace(api('/') || '/'); });
    }

    var mock = $('mock-flag');
    if (mock && boot.mock) mock.hidden = false;

    if (window.Swiper) {
      swiper = new window.Swiper('.ob-swiper', {
        init: true,
        speed: 420,
        resistanceRatio: 0.85,
        allowTouchMove: true,
        simulateTouch: true,
        touchStartPreventDefault: false,
        a11y: { enabled: true },
        keyboard: { enabled: true, onlyInViewport: true },
        on: {
          init: function () { applyPolicies(this.activeIndex); },
          slideChange: function () { applyPolicies(this.activeIndex); }
        }
      });
    } else {
      // Without Swiper the panel still works: every pane is stacked and the buttons scroll it.
      document.querySelector('.ob-swiper').classList.add('is-fallback');
      steps(0);
    }

    var nexts = document.querySelectorAll('[data-next]');
    for (var i = 0; i < nexts.length; i++) {
      nexts[i].addEventListener('click', function () {
        var idx = swiper ? swiper.activeIndex : 0;
        go(idx + 1);
      });
    }
    var prevs = document.querySelectorAll('[data-prev]');
    for (var j = 0; j < prevs.length; j++) {
      prevs[j].addEventListener('click', function () {
        var idx = swiper ? swiper.activeIndex : 0;
        go(Math.max(0, idx - 1));
      });
    }

    // Resume where the server says they are.
    if (boot.excluded) {
      blocked = true;
      var warn = $('territory-blocked');
      if (warn) warn.hidden = false;
      go(1);
    } else if (boot.state === 'licence_ok') {
      go(3);
    } else if (boot.state === 'ready') {
      showReady(boot);
    }

    setInterval(poll, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot_);
  } else {
    boot_();
  }

  // Escape does nothing on purpose: there is no way out of this panel but forward.
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') ev.preventDefault();
  }, true);
})();
