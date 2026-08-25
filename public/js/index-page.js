/* The gateway landing page: every action live, inline. */
'use strict';

(async () => {
  const { $, toast, statusStepper, txLink, escapeHtml, fmt } = UI;
  UI.paintRibbon();
  const cfgPromise = UI.initHeader();

  /* ---- stats strip ---- */
  async function refreshStats() {
    try {
      const s = await Api.stats();
      $('#st-head').textContent = fmt(s.head);
      $('#st-burn').innerHTML = fmt(s.vhpBurned) + ' <small>KOIN</small>';
      $('#st-launched').textContent = fmt(s.launched);
      $('#st-minted').textContent = fmt(s.minted);
    } catch (_) { /* stats are decoration — never block the page on them */ }
  }
  refreshStats();
  setInterval(refreshStats, 30000);

  /* ---- wallet card ---- */
  async function paintWallet() {
    const addr = Wallet.address();
    if (!addr) return;
    $('#wallet-body').hidden = true;
    $('#wallet-done').hidden = false;
    $('#wallet-addr').textContent = addr;
    $('#btn-create-wallet').textContent = 'That’s your address ↑ — it’s real';
    $('#btn-create-wallet').disabled = true;
    try {
      const acct = await Api.account(addr);
      const mana = Number(acct.mana) || 0;
      $('#mana-val').textContent = mana.toFixed(2) + ' free';
      $('#mana-fill').style.width = Math.min(100, mana * 20) + '%';
    } catch (_) {
      $('#mana-val').textContent = 'sponsored by the gateway';
      $('#mana-fill').style.width = '100%';
    }
  }
  $('#btn-create-wallet').addEventListener('click', () => {
    UI.ensureAccount();
    paintWallet();
  });
  if (Wallet.exists()) paintWallet();

  $('#cta-start').addEventListener('click', () => {
    UI.ensureAccount();
    paintWallet();
    document.getElementById('actions').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* ---- NFT card ---- */
  const studio = PixelStudio($('#mini-studio'));
  $('#btn-mint').addEventListener('click', async () => {
    const btn = $('#btn-mint');
    const name = $('#nft-name').value.trim();
    if (!name) { toast('Give your NFT a name first', 'err'); $('#nft-name').focus(); return; }
    if (studio.isEmpty()) { toast('Draw something first — that drawing becomes the NFT', 'err'); return; }
    UI.ensureAccount(); paintWallet();
    btn.disabled = true;
    const st = statusStepper($('#nft-status'), [
      'Signing with your key — locally, silently',
      'Gateway sponsors the mana',
      'Minting on-chain…',
    ]);
    try {
      st.next();
      const proof = await Wallet.proof('mint-nft');
      st.next(); st.next();
      const r = await Api.mintNft({ ...proof, name, palette: studio.palette(), cells: studio.grid() });
      st.done(txLink(r.txid, r.explorer, r.demo));
      UI.markDone('nft');
      toast(`"${name}" is yours — ${r.code}`, 'ok');
      loadGallery();
    } catch (e) {
      st.fail(e.message);
    } finally {
      btn.disabled = false;
    }
  });

  /* ---- token card ---- */
  $('#btn-launch').addEventListener('click', async () => {
    const btn = $('#btn-launch');
    const name = $('#tok-name').value.trim();
    const symbol = $('#tok-symbol').value.trim().toUpperCase();
    const supply = $('#tok-supply').value.trim();
    if (!name) { toast('Name your token first', 'err'); $('#tok-name').focus(); return; }
    if (!/^[A-Z0-9]{2,16}$/.test(symbol)) { toast('Symbol: 2–16 letters or digits', 'err'); $('#tok-symbol').focus(); return; }
    if (!/^\d+(\.\d+)?$/.test(supply) || Number(supply) <= 0) { toast('Supply must be a positive number', 'err'); $('#tok-supply').focus(); return; }
    UI.ensureAccount(); paintWallet();
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
      const r = await Api.launchToken({ ...proof, name, symbol, supply, decimals: 8, mintable: $('#tok-mintable').checked });
      st.next();
      st.done(
        `<div class="txline">contract: ${r.explorer ? `<a href="${escapeHtml(r.explorer)}" target="_blank" rel="noopener">${escapeHtml(r.address)}</a>` : escapeHtml(r.address)}</div>`
        + txLink(r.txid, r.explorerTx, r.demo)
      );
      UI.markDone('token');
      toast(`${symbol} is live — ${r.supply} in your wallet`, 'ok');
    } catch (e) {
      st.fail(e.message);
    } finally {
      btn.disabled = false;
    }
  });

  /* ---- funnel marks the build step ---- */
  $('#funnel-btn').addEventListener('click', () => UI.markDone('build'));

  /* ---- community gallery ---- */
  async function loadGallery() {
    try {
      const g = await Api.gallery();
      const host = $('#home-gallery');
      const items = g.nfts.slice(0, 12);
      if (!items.length) {
        host.innerHTML = '<p class="sub">Nothing here yet — yours could be the first.</p>';
        return;
      }
      host.innerHTML = items.map(n => `
        <div class="nft">
          <img src="${escapeHtml(n.image)}" alt="${escapeHtml(n.name)}">
          <div class="nm">${escapeHtml(n.name)}</div>
          <div class="by">${escapeHtml(n.code)} · ${UI.short(n.owner)}</div>
        </div>`).join('');
    } catch (_) { /* decoration */ }
  }
  loadGallery();

  await cfgPromise;
})();
