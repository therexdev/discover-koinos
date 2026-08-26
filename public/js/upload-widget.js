/* The Upload minting widget — used on the home page card and the NFT
   Studio. Pick up to 10 images, pick/create a collection, give a base
   name (batches become "NAME #1", "NAME #2", …), mint in one go. */
'use strict';

function initNftUpload(root, { onMinted } = {}) {
  const { toast, statusStepper, txLink, escapeHtml } = UI;
  const $ = (sel) => root.querySelector(sel);
  const el = (role) => root.querySelector(`[data-u="${role}"]`);

  const dz = el('dz'), fileInput = el('file'), thumbs = el('thumbs'), dzEmpty = el('dz-empty');
  const collSelect = el('coll'), collNameField = el('coll-name-field'), collName = el('coll-name');
  const nameInput = el('name'), nameLabel = el('name-label'), batchHint = el('batch-hint');
  const statusEl = el('status'), mintBtn = el('mint');

  /* Each slot is reserved SYNCHRONOUSLY (so the 10-cap and total-size cap
     hold even for a single big drop) and its dataUrl fills in when its
     FileReader resolves — order is preserved, and the mint button waits
     for every slot to finish. */
  let files = [];   // [{ dataUrl: string|null, name }]
  const MAX_FILES = 10;
  const MAX_BATCH = 15 * 1024 * 1024;   // headroom under the server's body cap
  const pending = () => files.filter(f => f.dataUrl === null).length;
  const batchBytes = () => files.reduce((n, f) => n + (f.dataUrl ? f.dataUrl.length : 0), 0);

  function paintThumbs() {
    if (!files.length) {
      thumbs.hidden = true; dzEmpty.hidden = false;
      nameLabel.textContent = 'NFT name'; batchHint.hidden = true;
      return;
    }
    dzEmpty.hidden = true; thumbs.hidden = false;
    thumbs.innerHTML = files.map((f, i) =>
      `<span class="thumb">${f.dataUrl ? `<img src="${f.dataUrl}" alt="">` : '<span class="thumb-loading" aria-label="loading">⏳</span>'}<button type="button" data-rm="${i}" aria-label="Remove image ${i + 1}">✕</button></span>`
    ).join('') + (files.length < MAX_FILES ? '<span class="thumb add" title="Add more">＋</span>' : '');
    nameLabel.textContent = files.length > 1 ? `Base name (× ${files.length})` : 'NFT name';
    batchHint.hidden = files.length <= 1;
  }

  function acceptFiles(list) {
    for (const file of [...list]) {
      if (files.length >= MAX_FILES) { toast('Up to 10 images per mint', 'err'); break; }
      if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) { toast(`"${file.name}": use PNG, JPEG, GIF or WebP`, 'err'); continue; }
      if (file.size > 3 * 1024 * 1024) { toast(`"${file.name}" is over 3MB — pick a smaller one`, 'err'); continue; }
      const slot = { dataUrl: null, name: file.name };   // reserve the slot now
      files.push(slot); paintThumbs();
      const reader = new FileReader();
      reader.onload = () => {
        // Enforce the aggregate cap once the encoded size is known.
        if (batchBytes() + reader.result.length > MAX_BATCH) {
          files.splice(files.indexOf(slot), 1); paintThumbs();
          toast(`Batch too big with "${file.name}" — remove one or use smaller images`, 'err');
          return;
        }
        slot.dataUrl = reader.result; paintThumbs();
      };
      reader.onerror = () => { files.splice(files.indexOf(slot), 1); paintThumbs(); toast(`Could not read "${file.name}"`, 'err'); };
      reader.readAsDataURL(file);
    }
  }

  dz.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { files.splice(Number(rm.dataset.rm), 1); paintThumbs(); return; }
    fileInput.click();
  });
  dz.addEventListener('keydown', (e) => {
    // Only the dropzone itself opens the picker — not the ✕ / ＋ buttons inside it.
    if ((e.key === 'Enter' || e.key === ' ') && e.target === dz) { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => { acceptFiles(fileInput.files); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => acceptFiles(e.dataTransfer.files));

  collSelect.addEventListener('change', () => {
    collNameField.style.display = collSelect.value === '__new' ? '' : 'none';
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

  mintBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const isNew = collSelect.value === '__new';
    const cName = collName.value.trim();
    if (!files.length) { toast('Choose at least one image', 'err'); return; }
    if (pending() > 0) { toast('Still loading images — one moment…', ''); return; }
    if (!name) { toast(files.length > 1 ? 'Give the batch a base name' : 'Name your NFT', 'err'); nameInput.focus(); return; }
    if (isNew && !cName) { toast('Name your new collection', 'err'); collName.focus(); return; }
    try { UI.ensureAccount(); } catch (_) { return; }
    mintBtn.disabled = true;
    const st = statusStepper(statusEl, [
      'Signing with your key — locally, silently',
      isNew ? 'Deploying your collection contract…' : 'Minting into your collection…',
      files.length > 1 ? `Minting ${files.length} NFTs in one transaction…` : 'Storing the image + on-chain metadata…',
    ]);
    try {
      st.next();
      const proof = await Wallet.proof('upload-nft');
      st.next(); st.next();
      const body = { ...proof, name, images: files.map(f => f.dataUrl) };
      if (isNew) body.collectionName = cName; else body.collection = collSelect.value;
      const r = await Api.uploadNft(body);
      let extra = '';
      if (r.createdCollection) extra += `<div class="txline">new collection: ${escapeHtml(r.createdCollection.name)} (${escapeHtml(r.createdCollection.symbol)})${r.collectionOuroUrl ? ` — <a href="${escapeHtml(r.collectionOuroUrl)}" target="_blank" rel="noopener">on OURO ↗</a>` : ''}</div>`;
      if (r.count > 1) extra += `<div class="txline">${r.count} NFTs minted: ${r.minted.map(m => escapeHtml(m.name)).join(', ')}</div>`;
      if (r.count > 1 && r.collectionOuroUrl && !r.createdCollection) {
        extra += `<div class="txline">on the marketplace: <a href="${escapeHtml(r.collectionOuroUrl)}" target="_blank" rel="noopener">view the collection on OURO ↗</a></div>`;
      } else if (r.count === 1 && r.ouroUrl) {
        extra += `<div class="txline">on the marketplace: <a href="${escapeHtml(r.ouroUrl)}" target="_blank" rel="noopener">view it on OURO ↗</a></div>`;
      }
      st.done(extra + txLink(r.txid, r.explorer, r.demo));
      UI.markDone('nft');
      toast(r.count > 1 ? `${r.count} NFTs minted` : `"${r.name}" minted`, 'ok');
      Share.celebrate('nft', { url: r.shareUrl, name: r.name, image: r.image });
      files = []; paintThumbs();
      loadCollections();
      if (onMinted) onMinted(r);
    } catch (e) { st.fail(e.message); } finally { mintBtn.disabled = false; }
  });

  document.addEventListener('dk:account', loadCollections);
  loadCollections();
  return { loadCollections };
}

/** The widget's markup, injected wherever a page mounts it. `compact`
    trims paddings for the home-page card. */
function nftUploadHtml(compact) {
  return `
  <div class="nft-upload${compact ? ' compact' : ''}">
    <div class="dropzone" data-u="dz" tabindex="0" role="button" aria-label="Choose or drop up to 10 images">
      <div data-u="dz-empty"><div style="font-size:1.7rem">⬆️</div><p style="margin:.3em 0 0">Click or drop images<br><span class="hint">up to 10 · PNG/JPEG/GIF/WebP · 3MB each</span></p></div>
      <div class="thumbs" data-u="thumbs" hidden></div>
      <input type="file" data-u="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
    </div>
    <label class="field">Collection
      <select class="input" data-u="coll"><option value="__new">+ New collection…</option></select>
    </label>
    <label class="field" data-u="coll-name-field">New collection name
      <input type="text" data-u="coll-name" maxlength="64" placeholder="My Art Collection" autocomplete="off">
    </label>
    <label class="field"><span data-u="name-label">NFT name</span>
      <input type="text" data-u="name" maxlength="43" placeholder="Untitled" autocomplete="off">
    </label>
    <p class="hint" data-u="batch-hint" hidden>They'll be named “NAME #1”, “NAME #2”, … automatically.</p>
    <div class="status" data-u="status"></div>
    <button class="btn" data-u="mint">Mint — free</button>
  </div>`;
}
