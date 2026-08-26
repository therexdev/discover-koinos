/* Shared UI: header wiring, toasts, tx status steppers, progress
   ribbon, formatting. Every page loads this after api.js/wallet.js. */
'use strict';

const UI = (() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  const short = (addr) => addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '';
  const fmt = (n) => Number(n).toLocaleString('en-US');

  /* ---- toasts ---- */
  function toast(msg, kind = '') {
    let host = $('#toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toasts';
      /* announce toasts to screen readers — they carry all the feedback */
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  }

  /* ---- progress ribbon (localStorage, guarded) ---- */
  const PROG_KEY = 'dk_progress';
  function progress() {
    try { return JSON.parse(localStorage.getItem(PROG_KEY)) || {}; } catch (_) { return {}; }
  }
  function markDone(step) {
    const p = progress(); p[step] = true;
    try { localStorage.setItem(PROG_KEY, JSON.stringify(p)); } catch (_) { /* storage blocked; ribbon is best-effort */ }
    paintRibbon();
  }
  function paintRibbon() {
    const p = progress();
    $$('.ribbon .step').forEach(el => {
      const s = el.dataset.step;
      el.classList.toggle('done', !!p[s]);
      const n = $('.n', el);
      if (n && p[s]) n.textContent = '✓';
    });
  }

  /* ---- tx status stepper ---- */
  function statusStepper(el, steps) {
    el.className = 'status show';
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div class="steps">' + steps.map((s, i) =>
      `<div class="s" data-i="${i}"><span class="ico"></span><span>${s}</span></div>`).join('') + '</div>';
    let cur = -1;
    const rows = $$('.s', el);
    return {
      next() {
        if (cur >= 0) { rows[cur].classList.remove('on'); rows[cur].classList.add('done'); rows[cur].querySelector('.ico').textContent = '✓'; }
        cur++;
        if (cur < rows.length) { rows[cur].classList.add('on'); rows[cur].querySelector('.ico').innerHTML = '<span class="spinner"></span>'; }
      },
      done(html) {
        rows.forEach(r => { r.classList.remove('on'); r.classList.add('done'); r.querySelector('.ico').textContent = '✓'; });
        el.classList.add('ok');
        if (html) el.insertAdjacentHTML('beforeend', html);
      },
      fail(msg) {
        el.classList.add('err');
        if (cur >= 0 && cur < rows.length) rows[cur].querySelector('.ico').textContent = '✕';
        el.insertAdjacentHTML('beforeend', `<div class="txline">${escapeHtml(msg)}</div>`);
      },
    };
  }

  function txLink(txid, explorer, demo) {
    if (demo) return `<div class="txline">demo transaction ${escapeHtml(txid || '')} — configure the chain to go live</div>`;
    const id = escapeHtml(txid || '');
    return explorer
      ? `<div class="txline">on-chain: <a href="${escapeHtml(explorer)}" target="_blank" rel="noopener">${id}</a></div>`
      : `<div class="txline">on-chain: ${id}</div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---- header ---- */
  let _cfg = null;
  async function initHeader() {
    const chip = $('#addr-chip');
    const paint = () => {
      const a = Wallet.address();
      if (chip) {
        chip.classList.toggle('empty', !a);
        $('.addr-txt', chip).textContent = a ? short(a) : 'Connect';
      }
    };
    paint();
    document.addEventListener('dk:account', paint);
    // The header chip: no account → open the sign-in modal; account → menu.
    if (chip) chip.addEventListener('click', (e) => {
      e.preventDefault();
      if (Wallet.address()) accountMenu(chip); else openLogin();
    });
    handleAuthReturn();   // pick up an X (Twitter) redirect if we came back from one
    try {
      const cfg = await Api.config();
      _cfg = cfg;
      const badge = $('#net-badge');
      if (badge) {
        if (cfg.demo) { badge.textContent = 'demo mode'; badge.classList.add('demo'); }
        else badge.textContent = cfg.testnet ? cfg.networkLabel.replace('Koinos ', '') : 'mainnet';
      }
      if (cfg.auth && cfg.auth.google) { _googleConfigured = true; loadGoogle(cfg.auth.googleClientId); }
      return cfg;
    } catch (e) {
      const badge = $('#net-badge');
      if (badge) { badge.textContent = 'offline'; badge.classList.add('demo'); }
      return null;
    }
  }

  /* ---------------- sign-in modal ---------------- */

  let _modal = null, _googleReady = false, _googleConfigured = false;
  function buildLoginModal() {
    if (_modal) return _modal;
    const d = document.createElement('dialog');
    d.className = 'modal login-modal';
    d.innerHTML = `
      <h3>Get your Koinos account</h3>
      <p class="sub">One account, four ways in. Everything on this site is free either way.</p>
      <div class="auth-opts">
        <div id="auth-google" class="auth-opt g-wrap" style="position:relative" hidden>
          <span class="ic" aria-hidden="true"><svg class="g-mark" width="18" height="18" viewBox="0 0 48 48">
            <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>
            <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
            <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>
            <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>
          </svg></span>
          <span>Continue with Google</span>
          <!-- Google's real (iframe) button, stretched invisibly over the face.
               The critical styles are INLINE so a stale cached stylesheet can
               never leave Google's raw button visible and inline in the row. -->
          <div class="g-overlay" id="auth-google-slot" aria-label="Continue with Google"
            style="position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden;opacity:.001;display:flex;align-items:center;justify-content:center"></div>
        </div>
        <button class="auth-opt" id="auth-x" hidden><span class="ic">𝕏</span> Continue with X</button>
        <button class="auth-opt primary" id="auth-local"><span class="ic">🔑</span> Create a Local Wallet <em>recommended</em></button>
        <button class="auth-opt" id="auth-import-toggle"><span class="ic">📥</span> Import a private key</button>
        <div id="auth-import" hidden>
          <label class="field">Private key (WIF)
            <input type="text" id="auth-wif" placeholder="5K… / L… / K…" autocomplete="off">
          </label>
          <button class="btn small" id="auth-import-go">Import</button>
        </div>
      </div>
      <p class="hint" id="auth-custodial-note"><strong>Google</strong> opens the <strong>same wallet</strong> you have in Aurvania and on OURO — one address across every Koinos site. Google and X hand the key to this browser when you sign in, and you can export it any time on the Wallet page. A Local Wallet never leaves your device.</p>
      <div style="text-align:right;margin-top:14px"><button class="btn ghost small" id="auth-close">Close</button></div>`;
    document.body.appendChild(d);
    _modal = d;

    $('#auth-close', d).addEventListener('click', () => d.close());
    $('#auth-local', d).addEventListener('click', () => {
      try { ensureAccount(); d.close(); } catch (_) {}
    });
    $('#auth-import-toggle', d).addEventListener('click', () => {
      const box = $('#auth-import', d); box.hidden = !box.hidden; if (!box.hidden) $('#auth-wif', d).focus();
    });
    $('#auth-import-go', d).addEventListener('click', () => {
      const wif = $('#auth-wif', d).value.trim();
      if (!wif) return toast('Paste a private key first', 'err');
      try { const a = Wallet.importAccount(wif); document.dispatchEvent(new CustomEvent('dk:account')); markDone('wallet'); d.close(); toast('Account imported — ' + short(a), 'ok'); }
      catch (_) { toast('That does not look like a valid WIF key', 'err'); }
    });
    $('#auth-x', d).addEventListener('click', () => { location.href = '/auth/x/login'; });
    return d;
  }

  function openLogin() {
    const d = buildLoginModal();
    // Reflect the current server config each time (it may load after boot).
    const x = _cfg && _cfg.auth && _cfg.auth.x;
    $('#auth-x', d).hidden = !x;
    const g = $('#auth-google', d);
    // Show our Google face as soon as Google is configured — the invisible
    // click target attaches when GSI lands (or we mark it dead if it never does).
    if (g) { g.hidden = !_googleConfigured; if (_googleConfigured) { renderGoogleButton(); armGoogleFallback(g); } }
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }

  /* ---------------- Google GSI ---------------- */

  function loadGoogle(clientId) {
    if (!clientId || _googleReady || document.getElementById('gsi-script')) return;
    const s = document.createElement('script');
    s.id = 'gsi-script'; s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
    s.onload = () => {
      try {
        window.google.accounts.id.initialize({
          client_id: clientId,
          ux_mode: 'popup',
          callback: async (resp) => {
            try {
              const r = await Wallet.loginGoogle(resp.credential);
              markDone('wallet');
              if (_modal) _modal.close();
              toast('Signed in with Google — ' + short(r.address), 'ok');
            } catch (e) { toast(e.message || 'Google sign-in failed', 'err'); }
          },
        });
        _googleReady = true;
        const g = _modal && $('#auth-google', _modal);
        if (g && _modal.open) { g.hidden = false; renderGoogleButton(); }
      } catch (_) { /* GSI unavailable — the other methods still work */ }
    };
    document.head.appendChild(s);
  }

  /* Only Google's own iframe may open the sign-in popup, and it cannot be
     restyled — so we render it invisibly (opacity ~0) and stretch it over a
     button that looks like the rest. The user sees our face; the click lands
     on Google's iframe. (The pattern Aurvania / OURO already ship.) */
  function renderGoogleButton() {
    const g = _modal && $('#auth-google', _modal);
    const slot = g && $('#auth-google-slot', g);
    if (!g || !slot || !_googleReady || slot.dataset.rendered) return;
    try {
      const w = Math.max(240, Math.min(420, Math.round(g.getBoundingClientRect().width) || 320));
      window.google.accounts.id.renderButton(slot, {
        theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'rectangular', width: w,
      });
      slot.dataset.rendered = '1';
      g.classList.remove('g-dead'); g.onclick = null;   // GSI arrived — the overlay is live
    } catch (_) {}
  }

  /* If Google's script is blocked or never lands, don't leave a button that
     looks clickable but isn't — mark it and explain on click. */
  function armGoogleFallback(g) {
    if (_googleReady || g.dataset.armed) return;
    g.dataset.armed = '1';
    let waited = 0;
    (function tick() {
      if (!g.isConnected) return;
      if (_googleReady) { g.classList.remove('g-dead'); g.onclick = null; return; }
      if ((waited += 200) > 8000) {
        g.classList.add('g-dead');
        g.onclick = () => toast('Google sign-in could not load — try another method, or check for script blockers', 'err');
        return;
      }
      setTimeout(tick, 200);
    })();
  }

  /* ---------------- X (Twitter) redirect return ---------------- */

  function handleAuthReturn() {
    const q = new URLSearchParams(location.search);
    if (q.get('auth') === 'x' && q.get('claim')) {
      Wallet.claimX(q.get('claim'))
        .then((r) => { markDone('wallet'); toast('Signed in with X — ' + (r.label || short(r.address)), 'ok'); })
        .catch((e) => toast(e.message || 'X sign-in failed', 'err'))
        .finally(() => cleanAuthQuery());
    } else if (q.get('auth') === 'x_error') {
      toast('X sign-in: ' + (q.get('msg') || 'failed'), 'err');
      cleanAuthQuery();
    }
  }
  function cleanAuthQuery() {
    const u = new URL(location.href); u.searchParams.delete('auth'); u.searchParams.delete('claim'); u.searchParams.delete('msg');
    history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
  }

  /* ---------------- account menu (logout) ---------------- */

  let _menu = null;
  function accountMenu(anchor) {
    if (_menu) { _menu.remove(); _menu = null; return; }
    const a = Wallet.address();
    const m = document.createElement('div');
    m.className = 'acct-menu';
    m.innerHTML = `
      <div class="acct-addr">${escapeHtml(a)}</div>
      <a href="/wallet">Wallet &amp; backup</a>
      <button id="acct-copy">Copy address</button>
      <button id="acct-logout" class="danger">Log out</button>`;
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = (r.bottom + 6) + 'px';
    m.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    _menu = m;
    const close = (ev) => { if (_menu && !_menu.contains(ev.target) && ev.target !== anchor) { _menu.remove(); _menu = null; document.removeEventListener('click', close, true); } };
    setTimeout(() => document.addEventListener('click', close, true), 0);
    $('#acct-copy', m).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(a); toast('Address copied', 'ok'); } catch (_) { window.prompt('Copy your address:', a); }
      m.remove(); _menu = null;
    });
    $('#acct-logout', m).addEventListener('click', () => {
      m.remove(); _menu = null;
      const backed = sessionStorage.getItem('dk_backed_up') === '1';
      if (!backed && !confirm('Log out?\n\nIf this is a Local Wallet you have not backed up, its key will be gone for good. Social accounts (Google/X) can be recovered by signing in again.')) return;
      Wallet.logout();
      toast('Logged out', 'ok');
    });
  }

  /** Make sure an account exists, announce it, mark step done. */
  function ensureAccount() {
    const fresh = !Wallet.exists();
    let addr;
    try {
      addr = Wallet.createAccount();
    } catch (e) {
      toast('Your browser is blocking site storage — enable it for this site to create an account.', 'err');
      throw e;
    }
    document.dispatchEvent(new CustomEvent('dk:account'));
    markDone('wallet');
    if (fresh) {
      toast('Your Koinos account is live — ' + short(addr), 'ok');
      if (Wallet.storageEphemeral && Wallet.storageEphemeral()) {
        toast('Heads up: this browser isn’t saving site data, so this account lives only until you close the tab. Back it up on the Wallet page.', '');
      }
    }
    return addr;
  }

  return { $, $$, short, fmt, toast, statusStepper, txLink, escapeHtml, initHeader, ensureAccount, openLogin, progress, markDone, paintRibbon, config: () => _cfg };
})();
