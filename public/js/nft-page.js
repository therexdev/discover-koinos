/* NFT Studio page: full editor, personal gallery, transfers, community. */
'use strict';

(async () => {
  const { $, toast, statusStepper, txLink, escapeHtml } = UI;
  UI.initHeader();

  const studio = PixelStudio($('#studio'));

  async function loadMine() {
    const addr = Wallet.address();
    if (!addr) return;
    try {
      const a = await Api.account(addr);
      const host = $('#my-gallery');
      if (a.nfts.length) {
        host.innerHTML = a.nfts.map(n => `
          <div class="nft">
            <img src="${escapeHtml(n.image)}" alt="${escapeHtml(n.name)}">
            <div class="nm">${escapeHtml(n.name)}</div>
            <div class="by">${escapeHtml(n.code)}</div>
          </div>`).join('');
      }
      const sel = $('#send-select');
      sel.innerHTML = '<option value="">— pick one you own —</option>' +
        a.nfts.map(n => `<option value="${escapeHtml(n.tokenId)}">${escapeHtml(n.name)} (${escapeHtml(n.code)})</option>`).join('');
    } catch (_) { /* gallery is decoration */ }
  }

  async function loadCommunity() {
    try {
      const g = await Api.gallery();
      const host = $('#community-gallery');
      host.innerHTML = g.nfts.length ? g.nfts.map(n => `
        <div class="nft">
          <img src="${escapeHtml(n.image)}" alt="${escapeHtml(n.name)}">
          <div class="nm">${escapeHtml(n.name)}</div>
          <div class="by">${escapeHtml(n.code)} · ${UI.short(n.owner)}</div>
        </div>`).join('')
        : '<p class="sub">Nothing here yet — yours could be the first.</p>';
    } catch (_) {}
  }

  $('#btn-mint').addEventListener('click', async () => {
    const btn = $('#btn-mint');
    const name = $('#nft-name').value.trim();
    if (!name) { toast('Give your NFT a name first', 'err'); $('#nft-name').focus(); return; }
    if (studio.isEmpty()) { toast('Draw something first', 'err'); return; }
    UI.ensureAccount();
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
      toast(`"${name}" minted — ${r.code}`, 'ok');
      loadMine(); loadCommunity();
    } catch (e) {
      st.fail(e.message);
    } finally {
      btn.disabled = false;
    }
  });

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
    } catch (e) {
      st.fail(e.message);
    } finally {
      btn.disabled = false;
    }
  });

  loadMine();
  loadCommunity();
})();
