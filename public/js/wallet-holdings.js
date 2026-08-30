/* ============================================================
   What's in your wallet, and sending it on.

   The wallet page used to show two counts — NFTs minted, tokens launched —
   which answer "what did I make here", not "what do I have". This lists the
   holdings themselves and puts a Send next to each one.

   The destination box takes a Koinos address OR an email address. The server
   decides what an email means (see tools/gifts.js): someone who has signed in
   here gets it straight into their own wallet, and someone who has not gets a
   held gift plus an email telling them how to collect it. Nothing about that
   decision happens here — the client only reports what came back.
   ============================================================ */
'use strict';

const Holdings = (() => {
  const { $, toast, escapeHtml, statusStepper, txLink, short } = UI;

  let account = null;      // last /api/account payload
  let openRow = null;      // the row currently showing the send form

  const fmt = (v, dp = 4) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: dp });

  function render(a) {
    account = a;
    const held = a.held || [];
    const nfts = a.nfts || [];
    const sent = a.giftsSent || [];
    const any = held.length || nfts.length || sent.length;
    $('#holdings').hidden = !any;
    $('#holdings-head').hidden = !any;
    if (!any) return;

    $('#h-tok-sub').textContent = held.length
      ? `${held.length} token${held.length === 1 ? '' : 's'} you can send`
      : 'nothing yet';
    $('#h-tokens').innerHTML = held.length
      ? held.map(tokenRow).join('')
      : `<p class="hint">No gateway tokens in this wallet yet. Launch one in the
         <a href="/token">Token Lab</a>, or ask someone to send you some.</p>`;

    $('#h-nft-sub').textContent = nfts.length
      ? `${nfts.length} NFT${nfts.length === 1 ? '' : 's'} you own`
      : 'nothing yet';
    $('#h-nfts').innerHTML = nfts.length
      ? nfts.map(nftCard).join('')
      : `<p class="hint">No NFTs in this wallet yet. Make one in the
         <a href="/nft">NFT Studio</a>.</p>`;

    $('#h-sent-card').hidden = !sent.length;
    if (sent.length) $('#h-sent').innerHTML = sent.map(sentRow).join('');
  }

  function tokenRow(t) {
    return `<div class="holding" data-kind="token" data-token="${escapeHtml(t.address)}"
                 data-symbol="${escapeHtml(t.symbol || '')}" data-balance="${escapeHtml(String(t.balance))}">
      <div class="holding-main">
        <div class="holding-name">${escapeHtml(t.name || t.symbol || 'Token')}
          <span class="holding-sym">${escapeHtml(t.symbol || '')}</span>
          ${t.mine ? '<span class="pill">yours</span>' : ''}</div>
        <div class="holding-sub">${fmt(t.balance)} ${escapeHtml(t.symbol || '')}${
          t.explorerUrl ? ` · <a href="${escapeHtml(t.explorerUrl)}" target="_blank" rel="noopener">explorer ↗</a>` : ''}</div>
      </div>
      <button class="btn small ghost holding-send">Send</button>
      <div class="holding-form"></div>
    </div>`;
  }

  function nftCard(n) {
    const img = n.image || '';
    return `<div class="holding nft-holding" data-kind="nft" data-token-id="${escapeHtml(n.tokenId)}"
                 data-name="${escapeHtml(n.name || n.code || 'NFT')}">
      <div class="holding-main">
        ${img ? `<img class="nft-thumb" src="${escapeHtml(img)}" alt="${escapeHtml(n.name || 'NFT')}" loading="lazy">` : ''}
        <div>
          <div class="holding-name">${escapeHtml(n.name || n.code || 'NFT')}</div>
          <div class="holding-sub">${escapeHtml(n.collectionName || 'Collection')} · ${escapeHtml(n.code || '')}${
            n.ouroUrl ? ` · <a href="${escapeHtml(n.ouroUrl)}" target="_blank" rel="noopener">OURO ↗</a>` : ''}</div>
        </div>
      </div>
      <button class="btn small ghost holding-send">Send</button>
      <div class="holding-form"></div>
    </div>`;
  }

  function sentRow(g) {
    const what = g.kind === 'nft'
      ? escapeHtml(g.nftName || g.nftCode || 'an NFT')
      : `${escapeHtml(String(g.amount))} ${escapeHtml(g.symbol || 'tokens')}`;
    const state = g.status === 'claimed' ? '<span class="pill ok">collected</span>'
      : g.status === 'expired' ? '<span class="pill">expired — returnable</span>'
      : '<span class="pill">waiting</span>';
    return `<div class="holding">
      <div class="holding-main">
        <div class="holding-name">${what} → ${escapeHtml(g.email)} ${state}</div>
        <div class="holding-sub">${g.status === 'pending'
          ? 'Held until they sign in with that Google account.'
          : g.status === 'claimed' ? 'Collected into their wallet.' : 'Nobody collected it.'}${
          g.mailWhy ? ` <span class="warn">We could not email them: ${escapeHtml(g.mailWhy)}</span>` : ''}</div>
      </div>
    </div>`;
  }

  /* ---------------- sending ---------------- */

  function closeForm() {
    if (openRow) { openRow.querySelector('.holding-form').innerHTML = ''; openRow.classList.remove('sending'); }
    openRow = null;
  }

  function openForm(row) {
    if (openRow === row) return closeForm();
    closeForm();
    openRow = row;
    row.classList.add('sending');
    const form = document.getElementById('send-form-tpl').content.cloneNode(true);
    const el = form.querySelector('.send-form');
    const isNft = row.dataset.kind === 'nft';
    if (isNft) {
      el.querySelector('.send-amount-field').hidden = true;
      el.querySelector('.send-max').hidden = true;
    }
    row.querySelector('.holding-form').appendChild(form);
    const to = el.querySelector('.send-to');
    to.focus();
    el.querySelector('.send-cancel').addEventListener('click', closeForm);
    el.querySelector('.send-max').addEventListener('click', () => {
      el.querySelector('.send-amount').value = row.dataset.balance;
    });
    el.addEventListener('submit', (ev) => { ev.preventDefault(); send(row, el); });
  }

  async function send(row, el) {
    const to = el.querySelector('.send-to').value.trim();
    const isNft = row.dataset.kind === 'nft';
    const amount = isNft ? null : el.querySelector('.send-amount').value.trim();
    if (!to) return toast('Enter an address or an email', 'err');
    if (!isNft) {
      if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) return toast('Amount must be a positive number', 'err');
      if (Number(amount) > Number(row.dataset.balance)) return toast(`You only hold ${fmt(row.dataset.balance)}`, 'err');
    }
    const go = el.querySelector('.send-go');
    go.disabled = true;
    const emailish = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to);
    const st = statusStepper(el.querySelector('.send-status'), [
      'Gateway prepares the exact transaction',
      'Your key signs it — locally',
      emailish ? 'Sending, and letting them know…' : 'Gateway co-signs the mana and broadcasts…',
    ]);
    try {
      st.next(); st.next(); st.next();
      const r = isNft
        ? await Wallet.sponsoredAction('nft_transfer', { tokenId: row.dataset.tokenId, to })
        : await Wallet.sponsoredAction('token_transfer', { token: row.dataset.token, to, amount });
      st.done(txLink(r.txid, r.explorer, r.demo) + giftLine(r.gift));
      toast(r.gift && r.gift.held ? 'Sent — waiting for them to collect it' : 'Sent — it’s on-chain', 'ok');
      closeForm();
      document.dispatchEvent(new CustomEvent('dk:account'));
    } catch (e) {
      st.fail(e.message);
    } finally {
      go.disabled = false;
    }
  }

  function giftLine(gift) {
    if (!gift) return '';
    const who = escapeHtml(gift.email);
    if (!gift.held) return `<div class="txline">Straight into ${who}'s wallet — they already have one.</div>`;
    return `<div class="txline">Held for ${who} until they sign in with that Google account.${
      gift.emailed ? ' We have emailed them a link.'
        : ` <span class="warn">We could not email them (${escapeHtml(gift.emailWhy || 'email is not set up')}) — send them the link yourself.</span>`}</div>`;
  }

  /* ---------------- arriving from a gift email ----------------
     The link in the email carries the address it was sent to, so the page
     can say what to do rather than leaving someone on a wallet screen with
     no idea why they are there. */
  function claimBanner() {
    const email = new URLSearchParams(location.search).get('claim');
    if (!email) return;
    const head = $('#holdings-head') || document.querySelector('main .section-head');
    const box = document.createElement('div');
    box.className = 'claim-banner';
    box.innerHTML = `<strong>Someone sent you something on Koinos.</strong>
      <p>Sign in with <em>${escapeHtml(email)}</em> to collect it. That makes your free wallet
         if you do not have one yet, and moves the gift straight into it.</p>
      <button class="btn small" id="claim-signin">Sign in with Google</button>`;
    head.parentNode.insertBefore(box, head);
    box.querySelector('#claim-signin').addEventListener('click', () => UI.openLogin());
  }
  claimBanner();

  /* One listener for every row, now and after any re-render. */
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.holding-send');
    if (btn) return openForm(btn.closest('.holding'));
    /* a click outside an open form closes it */
    if (openRow && !ev.target.closest('.holding.sending')) closeForm();
  });

  return { render };
})();
