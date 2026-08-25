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
  async function initHeader() {
    const chip = $('#addr-chip');
    const paint = () => {
      const a = Wallet.address();
      if (chip) {
        chip.classList.toggle('empty', !a);
        $('.addr-txt', chip).textContent = a ? short(a) : 'no account yet';
      }
    };
    paint();
    document.addEventListener('dk:account', paint);
    try {
      const cfg = await Api.config();
      const badge = $('#net-badge');
      if (badge) {
        if (cfg.demo) { badge.textContent = 'demo mode'; badge.classList.add('demo'); }
        else badge.textContent = cfg.testnet ? cfg.networkLabel.replace('Koinos ', '') : 'mainnet';
      }
      return cfg;
    } catch (e) {
      const badge = $('#net-badge');
      if (badge) { badge.textContent = 'offline'; badge.classList.add('demo'); }
      return null;
    }
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

  return { $, $$, short, fmt, toast, statusStepper, txLink, escapeHtml, initHeader, ensureAccount, progress, markDone, paintRibbon };
})();
