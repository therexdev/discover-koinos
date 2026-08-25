/* Token Lab page: launch, personal holdings, transfer/mint/burn, community. */
'use strict';

(async () => {
  const { $, toast, statusStepper, txLink, escapeHtml } = UI;
  const cfg = await UI.initHeader().catch(() => null);
  const explorer = cfg && cfg.explorer;

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
    if (!name) { toast('Name your token first', 'err'); $('#tok-name').focus(); return; }
    if (!/^[A-Z0-9]{2,16}$/.test(symbol)) { toast('Symbol: 2–16 letters or digits', 'err'); $('#tok-symbol').focus(); return; }
    if (!/^\d+(\.\d+)?$/.test(supply) || Number(supply) <= 0) { toast('Supply must be a positive number', 'err'); $('#tok-supply').focus(); return; }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) { toast('Decimals must be 0–12', 'err'); return; }
    UI.ensureAccount();
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
      const r = await Api.launchToken({ ...proof, name, symbol, supply, decimals, mintable: $('#tok-mintable').checked });
      st.next();
      st.done(
        `<div class="txline">contract: ${r.explorer ? `<a href="${escapeHtml(r.explorer)}" target="_blank" rel="noopener">${escapeHtml(r.address)}</a>` : escapeHtml(r.address)}</div>`
        + txLink(r.txid, r.explorerTx, r.demo)
      );
      UI.markDone('token');
      toast(`${symbol} is live — ${r.supply} in your wallet`, 'ok');
      loadMine(); loadCommunity();
    } catch (e) {
      st.fail(e.message);
    } finally {
      btn.disabled = false;
    }
  });

  /* hide the destination field for mint/burn */
  $('#act-kind').addEventListener('change', () => {
    $('#act-to-field').style.display = $('#act-kind').value === 'token_transfer' ? '' : 'none';
  });

  $('#btn-act').addEventListener('click', async () => {
    const btn = $('#btn-act');
    const token = $('#act-select').value;
    const kind = $('#act-kind').value;
    const amount = $('#act-amount').value.trim();
    const to = $('#act-to').value.trim();
    if (!token) { toast('Pick a token first', 'err'); return; }
    if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) { toast('Amount must be a positive number', 'err'); return; }
    if (kind === 'token_transfer' && !to) { toast('Paste a destination address', 'err'); return; }
    btn.disabled = true;
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
