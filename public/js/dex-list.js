/* The "List on Trade Koinos" form — mounted straight into the launch
   success box (homepage + Token Lab) so listing is the obvious next step
   after a mint, not a hunt through menus. Amount + price, one signature;
   creating the market is free and the sell order escrows only the seller's
   own tokens. */
'use strict';

const DexList = (() => {
  const { toast, statusStepper, txLink, escapeHtml } = UI;

  /** Render the inline listing form into `host`. opts: {token, symbol, onListed} */
  function mount(host, { token, symbol, onListed } = {}) {
    if (!host || host.dataset.dexMounted) return;
    host.dataset.dexMounted = '1';
    host.innerHTML = `
      <div class="dex-inline">
        <div class="dex-head">📈 <strong>List $${escapeHtml(symbol)} on Trade Koinos</strong><span class="hint"> — free. It creates the $${escapeHtml(symbol)}/KOIN market and places your sell order; a buyer brings the KOIN.</span></div>
        <div class="dex-row">
          <label class="field">Amount to sell
            <input class="input" type="text" inputmode="decimal" data-d="amount" placeholder="e.g. 500000" autocomplete="off"></label>
          <label class="field">Price per token (KOIN)
            <input class="input" type="text" inputmode="decimal" data-d="price" placeholder="e.g. 0.001" autocomplete="off"></label>
        </div>
        <div class="status" data-d="status"></div>
        <button class="btn" data-d="go">📈 List on Trade Koinos — free</button>
      </div>`;
    const el = (r) => host.querySelector(`[data-d="${r}"]`);
    el('go').addEventListener('click', async () => {
      const amount = el('amount').value.trim();
      const price = el('price').value.trim();
      if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) { toast('Amount must be a positive number', 'err'); el('amount').focus(); return; }
      if (!/^\d+(\.\d+)?$/.test(price) || Number(price) <= 0) { toast('Set a price per token in KOIN', 'err'); el('price').focus(); return; }
      const btn = el('go');
      btn.disabled = true;
      const st = statusStepper(el('status'), [
        'Signing with your key — locally',
        'Ensuring the market on Trade Koinos…',
        'Placing your sell order (escrows only your tokens)…',
      ]);
      try {
        st.next();
        const proof = await Wallet.proof('list-dex');
        const prep = await Api.listDex({ ...proof, token, amount, price });
        st.next();
        const signed = prep.demo ? { id: 'demo' } : await Wallet.signTx(prep.tx);
        st.next();
        const r = await Api.submit({ ref: prep.ref, transaction: signed });
        st.done(txLink(r.txid, r.explorer, r.demo)
          + `<div class="txline">listed on Trade Koinos${prep.dexUrl ? ` — <a href="${escapeHtml(prep.dexUrl)}" target="_blank" rel="noopener">trade the pair ↗</a>` : ''}</div>`);
        toast('Listed on Trade Koinos — a buyer brings the KOIN', 'ok');
        Share.celebrate('dex', { url: prep.shareUrl, symbol });
        btn.textContent = 'Listed ✓';
        if (onListed) onListed(r);
      } catch (e) {
        st.fail(e.message);
        btn.disabled = false;
      }
    });
  }

  return { mount };
})();
