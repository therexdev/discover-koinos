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
    if (Wallet.address()) return;
    UI.openLogin();
  });
  document.addEventListener('dk:account', paintWallet);
  if (Wallet.exists()) paintWallet();

  $('#cta-start').addEventListener('click', () => {
    if (Wallet.address()) {
      document.getElementById('actions').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      UI.openLogin();
    }
  });

  /* ---- NFT card: Paint | New tabs ---- */
  const hpTabs = [['hp-tab-paint', 'hp-pane-paint'], ['hp-tab-new', 'hp-pane-new']];
  let hpUploadReady = false;
  function hpSelect(id) {
    hpTabs.forEach(([t, p]) => {
      const on = t === id;
      $('#' + t).setAttribute('aria-selected', String(on));
      $('#' + p).hidden = !on;
    });
    if (id === 'hp-tab-new' && !hpUploadReady) {
      hpUploadReady = true;
      const mount = $('#hp-upload-mount');
      mount.innerHTML = nftUploadHtml(true);
      initNftUpload(mount, { onMinted: () => { paintWallet(); loadGallery(); } });
    }
  }
  $('#hp-tab-paint').addEventListener('click', () => hpSelect('hp-tab-paint'));
  $('#hp-tab-new').addEventListener('click', () => hpSelect('hp-tab-new'));

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
      st.done(txLink(r.txid, r.explorer, r.demo)
        + (r.shareUrl ? `<div class="txline">share it: <a href="${escapeHtml(r.shareUrl)}" target="_blank" rel="noopener">${escapeHtml(r.shareUrl)}</a></div>` : ''));
      UI.markDone('nft');
      toast(`"${name}" is yours — ${r.code}`, 'ok');
      Share.celebrate('nft', { url: r.shareUrl, name, image: r.image });
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
    const mintable = $('#tok-mintable').checked;
    if (!name) { toast('Name your token first', 'err'); $('#tok-name').focus(); return; }
    if (!/^[A-Z0-9]{2,16}$/.test(symbol)) { toast('Symbol: 2–16 letters or digits', 'err'); $('#tok-symbol').focus(); return; }
    if (!/^\d+(\.\d+)?$/.test(supply) || (Number(supply) <= 0 && !mintable)) {
      toast(mintable ? 'Supply must be a number (0 is fine for a mintable token)' : 'Supply must be a positive number', 'err');
      $('#tok-supply').focus(); return;
    }
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
      const r = await Api.launchToken({ ...proof, name, symbol, supply, decimals: 8, mintable });
      st.next();
      st.done(
        `<div class="txline">contract: ${r.explorer ? `<a href="${escapeHtml(r.explorer)}" target="_blank" rel="noopener">${escapeHtml(r.address)}</a>` : escapeHtml(r.address)}</div>`
        + txLink(r.txid, r.explorerTx, r.demo)
      );
      UI.markDone('token');
      toast(`${symbol} is live — ${r.supply} in your wallet`, 'ok');
      Share.celebrate('token', { url: r.shareUrl, symbol });
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
