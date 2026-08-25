/* Token Lab page: launch, personal holdings, transfer/mint/burn, community. */
'use strict';

(() => {
  const { $, toast, statusStepper, txLink, escapeHtml } = UI;
  /* Don't gate button wiring on the config fetch; set the explorer base
     once it lands and repaint the tables. */
  let explorer = null;
  UI.initHeader().then((cfg) => {
    explorer = cfg && cfg.explorer;
    if (explorer) { loadMine(); loadCommunity(); }
  }).catch(() => {});

  const addrLink = (a) => explorer
    ? `<a class="mono" href="${escapeHtml(explorer)}/address/${escapeHtml(a)}" target="_blank" rel="noopener">${UI.short(a)}</a>`
    : `<span class="mono">${UI.short(a)}</span>`;

  async function loadMine() {
    const addr = Wallet.address();
    if (!addr) return;
    try {
      const a = await Api.account(addr);
      if (a.tokens.length) {
        $('#my-tokens tbody').innerHTML = a.tokens.map(t => `
          <tr>
            <td><span class="sym">${escapeHtml(t.symbol)}</span> ${escapeHtml(t.name)}</td>
            <td>${escapeHtml(fmtUnits(t.balance ?? t.supplyUnits, t.decimals))}</td>
            <td>${addrLink(t.address)}</td>
          </tr>`).join('');
      }
      const sel = $('#act-select');
      sel.innerHTML = '<option value="">— pick one of yours —</option>' +
        a.tokens.map(t => `<option value="${escapeHtml(t.address)}" data-mintable="${t.mintable ? 1 : 0}">${escapeHtml(t.symbol)} — ${escapeHtml(t.name)}</option>`).join('');
    } catch (_) {}
  }

  async function loadCommunity() {
    try {
      const g = await Api.gallery();
      $('#community-tokens tbody').innerHTML = g.tokens.length ? g.tokens.map(t => `
        <tr>
          <td><span class="sym">${escapeHtml(t.symbol)}</span> ${escapeHtml(t.name)}</td>
          <td>${escapeHtml(t.supply)}${t.mintable ? ' <span class="hint">+ mintable</span>' : ''}</td>
          <td>${addrLink(t.owner)}</td>
          <td>${addrLink(t.address)}</td>
        </tr>`).join('')
        : '<tr><td colspan="4" class="sub">No launches yet — yours could be the first.</td></tr>';
    } catch (_) {}
  }

  function fmtUnits(units, decimals) {
    const u = BigInt(String(units || '0'));
    const base = 10n ** BigInt(decimals || 0);
    const whole = u / base, frac = u % base;
    let s = whole.toLocaleString('en-US');
    if (frac) s += '.' + frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return s;
  }

  $('#btn-launch').addEventListener('click', async () => {
    const btn = $('#btn-launch');
    const name = $('#tok-name').value.trim();
    const symbol = $('#tok-symbol').value.trim().toUpperCase();
    const supply = $('#tok-supply').value.trim();
    const decimals = parseInt($('#tok-decimals').value, 10);
    const mintable = $('#tok-mintable').checked;
    if (!name) { toast('Name your token first', 'err'); $('#tok-name').focus(); return; }
    if (!/^[A-Z0-9]{2,16}$/.test(symbol)) { toast('Symbol: 2–16 letters or digits', 'err'); $('#tok-symbol').focus(); return; }
    if (!/^\d+(\.\d+)?$/.test(supply) || (Number(supply) <= 0 && !mintable)) {
      toast(mintable ? 'Supply must be a number (0 is fine for a mintable token)' : 'Supply must be a positive number', 'err');
      $('#tok-supply').focus(); return;
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) { toast('Decimals must be 0–12', 'err'); return; }
    try { UI.ensureAccount(); } catch (_) { return; }
    btn.disabled = true;
    const st = statusStepper($('#tok-status'), [
      'Signing with your key — locally, silently',
      'Deploying the audited token contract…',
      'Setting name, symbol and supply…',
    ]);
    try {
      st.next();
      const proof = await Wallet.proof('launch-token');
      st.next();
      const r = await Api.launchToken({ ...proof, name, symbol, supply, decimals, mintable });
      st.next();
      st.done(
        `<div class="txline">contract: ${r.explorer ? `<a href="${escapeHtml(r.explorer)}" target="_blank" rel="noopener">${escapeHtml(r.address)}</a>` : escapeHtml(r.address)}</div>`
        + txLink(r.txid, r.explorerTx, r.demo)
      );
      UI.markDone('token');
      toast(`${symbol} is live — ${r.supply} in your wallet`, 'ok');
      Share.celebrate('token', { url: r.shareUrl, symbol });
      loadMine(); loadCommunity();
    } catch (e) {
      st.fail(e.message);
    } finally {
      btn.disabled = false;
    }
  });

  /* show the right fields per action: destination for transfer, price for
     DEX listing. */
  function syncActionFields() {
    const k = $('#act-kind').value;
    $('#act-to-field').style.display = k === 'token_transfer' ? '' : 'none';
    $('#act-price-field').style.display = k === 'list_dex' ? '' : 'none';
    $('#dex-note').style.display = k === 'list_dex' ? '' : 'none';
  }
  $('#act-kind').addEventListener('change', syncActionFields);

  /* Gate the DEX option to where Trade Koinos actually exists (mainnet). */
  (async () => {
    const cfg = await Api.config().catch(() => null);
    const opt = [...$('#act-kind').options].find(o => o.value === 'list_dex');
    if (opt && cfg && cfg.dex && !cfg.dex.available) {
      opt.textContent = '📈 List on DEX (mainnet only)';
      opt.disabled = true;
    }
  })();

  $('#btn-act').addEventListener('click', async () => {
    const btn = $('#btn-act');
    const token = $('#act-select').value;
    const kind = $('#act-kind').value;
    const amount = $('#act-amount').value.trim();
    const to = $('#act-to').value.trim();
    const price = $('#act-price').value.trim();
    if (!token) { toast('Pick a token first', 'err'); return; }
    if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) { toast('Amount must be a positive number', 'err'); return; }
    if (kind === 'token_transfer' && !to) { toast('Paste a destination address', 'err'); return; }
    if (kind === 'list_dex' && (!/^\d+(\.\d+)?$/.test(price) || Number(price) <= 0)) { toast('Set a price per token in KOIN', 'err'); $('#act-price').focus(); return; }
    btn.disabled = true;

    if (kind === 'list_dex') {
      const st = statusStepper($('#act-status'), [
        'Signing with your key — locally',
        'Ensuring the TOKEN/KOIN market on Trade Koinos…',
        'Placing your sell order (escrows only your tokens)…',
      ]);
      try {
        st.next();
        const proof = await Wallet.proof('list-dex');
        const prep = await Api.listDex({ ...proof, token, amount, price });
        st.next();
        let signed;
        if (prep.demo) { signed = { id: 'demo' }; } else { signed = await Wallet.signTx(prep.tx); }
        st.next();
        const r = await Api.submit({ ref: prep.ref, transaction: signed });
        st.done(txLink(r.txid, r.explorer, r.demo) + `<div class="txline">listed on Trade Koinos${prep.explorerAddr ? ` — <a href="${escapeHtml(prep.explorerAddr)}" target="_blank" rel="noopener">orderbook ↗</a>` : ''}</div>`);
        toast('Listed on Trade Koinos — a buyer brings the KOIN', 'ok');
        const sym = ($('#act-select option:checked').textContent.split(' ')[0] || 'TOKEN').replace('—','').trim();
        Share.celebrate('dex', { url: prep.shareUrl, symbol: sym });
        loadMine();
      } catch (e) { st.fail(e.message); } finally { btn.disabled = false; }
      return;
    }

    const st = statusStepper($('#act-status'), [
      'Gateway prepares the exact transaction',
      'Your key signs it — locally',
      'Gateway co-signs the mana and broadcasts…',
    ]);
    try {
      st.next(); st.next(); st.next();
      const params = kind === 'token_transfer' ? { token, to, amount } : { token, amount };
      const r = await Wallet.sponsoredAction(kind, params);
      st.done(txLink(r.txid, r.explorer, r.demo));
      toast('Done — it’s on-chain', 'ok');
      loadMine();
    } catch (e) {
      st.fail(e.message);
    } finally {
      btn.disabled = false;
    }
  });

  loadMine();
  loadCommunity();
})();
