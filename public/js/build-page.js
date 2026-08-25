/* Build page: reaching here completes the journey — and the page shows
   what YOU actually made next to the machinery that made it free. */
'use strict';

(() => {
  const { $, escapeHtml } = UI;
  UI.initHeader();
  UI.markDone('build');

  const shareBtn = $('#btn-share-site');
  if (shareBtn) shareBtn.addEventListener('click', () => Share.open('site', { url: location.origin + '/' }));

  async function paintJourney() {
    const addr = Wallet.address();
    const wallet = $('#yours-wallet'), mana = $('#yours-mana'), nft = $('#yours-nft'), token = $('#yours-token');
    if (!wallet) return;

    // Reset every data section first, so a logout or a failed load never
    // leaves the previous account's things showing as "Yours".
    for (const el of [mana, nft, token]) if (el) { el.hidden = true; el.innerHTML = ''; }

    if (!addr) {
      wallet.hidden = false;
      wallet.innerHTML = `<div class="yours-k">Yours</div><p class="not-yet">You haven't made an account yet — <a href="/">one click on the home page</a> and this page fills in with your own things.</p>`;
      return;
    }

    wallet.hidden = false;
    wallet.innerHTML = `<div class="yours-k">Yours</div><div class="mono">${escapeHtml(addr)}</div>
      <p class="hint" style="margin:6px 0 0">That address is yours on every Koinos app, not just this one. <a href="/wallet">Back up the key →</a></p>`;

    let a = null;
    try { a = await Api.account(addr); } catch (_) { return; }

    const sponsored = (a.nfts?.length || 0) + (a.tokens?.length || 0) + (a.tokens || []).filter(t => t.dex).length;
    mana.hidden = false;
    mana.innerHTML = `<div class="yours-k">Yours</div>
      <p style="margin:0">The sponsor has co-signed <strong>${sponsored || 'no'}</strong> transaction${sponsored === 1 ? '' : 's'} for this address so far — and your own mana sits at <strong>${Number(a.mana || 0).toFixed(2)}</strong>, recharging on its own.</p>`;

    if (a.nfts && a.nfts.length) {
      nft.hidden = false;
      nft.innerHTML = `<div class="yours-k">Yours</div>
        <div class="mini-gallery">${a.nfts.slice(-6).reverse().map(n =>
          `<a href="/n/${encodeURIComponent(n.code)}" title="${escapeHtml(n.name)}"><img src="${escapeHtml(n.image)}" alt="${escapeHtml(n.name)}" loading="lazy"></a>`).join('')}</div>
        <p class="hint" style="margin:8px 0 0">${a.nfts.length} minted — every square links to its public page, made for sharing.</p>`;
    } else {
      nft.hidden = false;
      nft.innerHTML = `<div class="yours-k">Yours</div><p class="not-yet">Nothing minted yet — <a href="/nft">draw or upload one →</a></p>`;
    }

    if (a.tokens && a.tokens.length) {
      token.hidden = false;
      token.innerHTML = `<div class="yours-k">Yours</div>
        <div>${a.tokens.slice(-6).reverse().map(t =>
          `<a class="tok-pill" href="/t/${encodeURIComponent(t.address)}">$${escapeHtml(t.symbol)}${t.dex ? ' <span class="dexed">· on DEX</span>' : ''}</a>`).join('')}</div>
        <p class="hint" style="margin:8px 0 0">Each pill is your token's public page — the link that unfurls when you share it.</p>`;
    } else {
      token.hidden = false;
      token.innerHTML = `<div class="yours-k">Yours</div><p class="not-yet">No token yet — <a href="/token">launch one in one click →</a></p>`;
    }
  }

  document.addEventListener('dk:account', paintJourney);
  paintJourney();
})();
