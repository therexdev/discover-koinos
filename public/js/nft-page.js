/* NFT Studio: Paint (shared collection) + Upload (your own collections),
   personal gallery, transfers, community. */
'use strict';

(async () => {
  const { $, toast, statusStepper, txLink, escapeHtml } = UI;
  UI.initHeader();

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
  $('#tab-upload').addEventListener('click', () => { selectTab('tab-upload'); loadCollections(); });

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
      st.done(txLink(r.txid, r.explorer, r.demo));
      UI.markDone('nft');
      toast(`"${name}" minted — ${r.code}`, 'ok');
      loadMine(); loadCommunity();
    } catch (e) { st.fail(e.message); } finally { btn.disabled = false; }
  });

  /* ---------------- upload (your own collection) ---------------- */
  let currentImage = null;
  const dz = $('#dropzone'), fileInput = $('#file-input');
  const preview = $('#dz-preview'), dzEmpty = $('#dz-empty');

  function acceptFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) { toast('Use a PNG, JPEG, GIF or WebP image', 'err'); return; }
    if (file.size > 3 * 1024 * 1024) { toast('That image is over 3MB — pick a smaller one', 'err'); return; }
    const reader = new FileReader();
    reader.onload = () => { currentImage = reader.result; preview.src = reader.result; preview.hidden = false; dzEmpty.hidden = true; };
    reader.onerror = () => toast('Could not read that file', 'err');
    reader.readAsDataURL(file);
  }
  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', () => acceptFile(fileInput.files[0]));
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) acceptFile(e.dataTransfer.files[0]); });

  const collSelect = $('#coll-select');
  collSelect.addEventListener('change', () => {
    $('#coll-name-field').style.display = collSelect.value === '__new' ? '' : 'none';
  });

  async function loadCollections() {
    const addr = Wallet.address();
    if (!addr) return;
    try {
      const { collections } = await Api.collections(addr);
      const own = collections.filter(c => c.kind !== 'paint');
      const cur = collSelect.value;
      collSelect.innerHTML = '<option value="__new">+ New collection…</option>' +
        own.map(c => `<option value="${escapeHtml(c.address)}">${escapeHtml(c.name)} (${escapeHtml(c.symbol)})${c.ouro ? ' · on OURO' : ''}</option>`).join('');
      if ([...collSelect.options].some(o => o.value === cur)) collSelect.value = cur;
      collSelect.dispatchEvent(new Event('change'));
    } catch (_) {}
  }

  $('#btn-upload-mint').addEventListener('click', async () => {
    const btn = $('#btn-upload-mint');
    const name = $('#up-name').value.trim();
    const isNew = collSelect.value === '__new';
    const collectionName = $('#coll-name').value.trim();
    if (!currentImage) { toast('Choose an image first', 'err'); return; }
    if (!name) { toast('Name your NFT', 'err'); $('#up-name').focus(); return; }
    if (isNew && !collectionName) { toast('Name your new collection', 'err'); $('#coll-name').focus(); return; }
    try { UI.ensureAccount(); } catch (_) { return; }
    btn.disabled = true;
    const st = statusStepper($('#up-status'), [
      'Signing with your key — locally, silently',
      isNew ? 'Deploying your collection contract…' : 'Minting into your collection…',
      'Storing the image + on-chain metadata…',
    ]);
    try {
      st.next();
      const proof = await Wallet.proof('upload-nft');
      st.next(); st.next();
      const body = { ...proof, name, image: currentImage };
      if (isNew) body.collectionName = collectionName; else body.collection = collSelect.value;
      const r = await Api.uploadNft(body);
      let extra = '';
      if (r.createdCollection) extra += `<div class="txline">new collection: ${escapeHtml(r.createdCollection.name)} (${escapeHtml(r.createdCollection.symbol)})${r.collectionOuroUrl ? ` — <a href="${escapeHtml(r.collectionOuroUrl)}" target="_blank" rel="noopener">on OURO ↗</a>` : ''}</div>`;
      st.done(extra + txLink(r.txid, r.explorer, r.demo));
      UI.markDone('nft');
      toast(`"${name}" minted`, 'ok');
      currentImage = null; preview.hidden = true; dzEmpty.hidden = false; fileInput.value = '';
      loadCollections(); loadMine(); loadCommunity();
    } catch (e) { st.fail(e.message); } finally { btn.disabled = false; }
  });

  /* ---------------- personal gallery + transfer ---------------- */
  async function loadMine() {
    const addr = Wallet.address();
    if (!addr) return;
    try {
      const a = await Api.account(addr);
      const host = $('#my-gallery');
      if (a.nfts.length) {
        host.innerHTML = a.nfts.slice().reverse().map(n => `
          <div class="nft">
            <img src="${escapeHtml(n.image)}" alt="${escapeHtml(n.name)}" loading="lazy">
            <div class="nm">${escapeHtml(n.name)}</div>
            <div class="by">${escapeHtml(n.collectionName || n.code || '')}</div>
          </div>`).join('');
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
        <div class="nft">
          <img src="${escapeHtml(n.image)}" alt="${escapeHtml(n.name)}" loading="lazy">
          <div class="nm">${escapeHtml(n.name)}</div>
          <div class="by">${escapeHtml(n.collectionName || n.code || '')} · ${UI.short(n.owner)}</div>
        </div>`).join('')
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

  document.addEventListener('dk:account', () => { loadMine(); loadCollections(); });
  loadMine();
  loadCommunity();
})();
