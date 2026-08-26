/* NFT Studio: Paint (shared collection) + Upload (your own collections),
   personal gallery, transfers, community. */
'use strict';

(async () => {
  const { $, toast, statusStepper, txLink, escapeHtml } = UI;
  UI.initHeader().then((cfg) => {
    // The shared Paint collection's live marketplace page.
    const a = $('#paint-ouro-link');
    if (a && cfg && cfg.paintOuroUrl) { a.href = cfg.paintOuroUrl; a.hidden = false; }
  }).catch(() => {});

  /* ---------------- tabs ---------------- */
  const tabs = [['tab-paint', 'pane-paint'], ['tab-upload', 'pane-upload']];
  function selectTab(id) {
    tabs.forEach(([t, p]) => {
      const on = t === id;
      $('#' + t).setAttribute('aria-selected', String(on));
      $('#' + p).hidden = !on;
    });
  }
  $('#tab-paint').addEventListener('click', () => selectTab('tab-paint'));
  $('#tab-upload').addEventListener('click', () => selectTab('tab-upload'));

  /* ---------------- paint (shared collection) ---------------- */
  const studio = PixelStudio($('#studio'));
  $('#btn-mint').addEventListener('click', async () => {
    const btn = $('#btn-mint');
    const name = $('#nft-name').value.trim();
    if (!name) { toast('Give your NFT a name first', 'err'); $('#nft-name').focus(); return; }
    if (studio.isEmpty()) { toast('Draw something first', 'err'); return; }
    try { UI.ensureAccount(); } catch (_) { return; }
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
        + (r.ouroUrl ? `<div class="txline">on the marketplace: <a href="${escapeHtml(r.ouroUrl)}" target="_blank" rel="noopener">view it on OURO ↗</a></div>` : ''));
      UI.markDone('nft');
      toast(`"${name}" minted — ${r.code}`, 'ok');
      Share.celebrate('nft', { url: r.shareUrl, name, image: r.image });
      loadMine(); loadCommunity();
    } catch (e) { st.fail(e.message); } finally { btn.disabled = false; }
  });

  /* ---------------- upload (your own collection) — shared widget ---- */
  const mount = $('#upload-mount');
  mount.innerHTML = nftUploadHtml(false);
  initNftUpload(mount, { onMinted: () => { loadMine(); loadCommunity(); } });

  /* ---------------- personal gallery + transfer ---------------- */
  async function loadMine() {
    const addr = Wallet.address();
    if (!addr) return;
    try {
      const a = await Api.account(addr);
      const host = $('#my-gallery');
      if (a.nfts.length) {
        host.innerHTML = a.nfts.slice().reverse().map(n => `
          <a class="nft" href="${escapeHtml(n.ouroUrl || ('/n/' + encodeURIComponent(n.code || '')))}" target="_blank" rel="noopener" title="${n.ouroUrl ? 'View on OURO' : 'View'}">
            <img src="${escapeHtml(n.image)}" alt="${escapeHtml(n.name)}" loading="lazy">
            <div class="nm">${escapeHtml(n.name)}${n.ouroUrl ? ' <span class="on-ouro">OURO ↗</span>' : ''}</div>
            <div class="by">${escapeHtml(n.collectionName || n.code || '')}</div>
          </a>`).join('');
      }
      const sel = $('#send-select');
      sel.innerHTML = '<option value="">— pick one you own —</option>' +
        a.nfts.map(n => `<option value="${escapeHtml(n.tokenId)}">${escapeHtml(n.name)}</option>`).join('');
    } catch (_) {}
  }

  async function loadCommunity() {
    try {
      const g = await Api.gallery();
      const host = $('#community-gallery');
      host.innerHTML = g.nfts.length ? g.nfts.map(n => `
        <a class="nft" href="${escapeHtml(n.ouroUrl || ('/n/' + encodeURIComponent(n.code || '')))}" target="_blank" rel="noopener" title="${n.ouroUrl ? 'View on OURO' : 'View'}">
          <img src="${escapeHtml(n.image)}" alt="${escapeHtml(n.name)}" loading="lazy">
          <div class="nm">${escapeHtml(n.name)}${n.ouroUrl ? ' <span class="on-ouro">OURO ↗</span>' : ''}</div>
          <div class="by">${escapeHtml(n.collectionName || n.code || '')} · ${UI.short(n.owner)}</div>
        </a>`).join('')
        : '<p class="sub">Nothing here yet — yours could be the first.</p>';
    } catch (_) {}
  }

  $('#btn-send').addEventListener('click', async () => {
    const btn = $('#btn-send');
    const tokenId = $('#send-select').value;
    const to = $('#send-to').value.trim();
    if (!tokenId) { toast('Pick an NFT to send', 'err'); return; }
    if (!to) { toast('Paste your friend’s Koinos address', 'err'); $('#send-to').focus(); return; }
    btn.disabled = true;
    const st = statusStepper($('#send-status'), [
      'Gateway prepares the exact transaction',
      'Your key signs it — locally',
      'Gateway co-signs the mana and broadcasts…',
    ]);
    try {
      st.next(); st.next(); st.next();
      const r = await Wallet.sponsoredAction('nft_transfer', { tokenId, to });
      st.done(txLink(r.txid, r.explorer, r.demo));
      toast('Sent — it’s theirs now', 'ok');
      loadMine();
    } catch (e) { st.fail(e.message); } finally { btn.disabled = false; }
  });

  document.addEventListener('dk:account', loadMine);   // the widget refreshes its own collection list
  loadMine();
  loadCommunity();
})();
