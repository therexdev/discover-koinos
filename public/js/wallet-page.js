/* Wallet page: account details, balances, backup, import, faucets. */
'use strict';

(() => {
  const { $, toast, escapeHtml } = UI;

  /* Header + config must NOT gate button wiring — a slow /api/config would
     leave every control dead. Fire it, fill the config-dependent bits when
     it lands, and wire everything else synchronously below. */
  UI.initHeader().then((cfg) => {
    if (!cfg) return;
    const sym = cfg.nativeSymbol || 'tKOIN';
    $('#w-symbol').textContent = sym;
    $('#w-koin-label').textContent = sym + ' balance';
    const faucets = (cfg.faucets || []);
    $('#w-faucets').innerHTML = faucets.length
      ? faucets.map(f => `<li><a href="${escapeHtml(f.url)}" target="_blank" rel="noopener"><span>${escapeHtml(f.name)}</span><span class="where">↗</span></a><p class="hint" style="padding:0 18px 12px">${escapeHtml(f.note)}</p></li>`).join('')
      /* Mainnet: the KOIN/USDT pair on Uniswap (Ethereum; KOIN bridged via
         Chainge), plus koinos.io's own where-to-get roundup as backup. */
      : `<li><a href="https://app.uniswap.org/swap?inputCurrency=0xdAC17F958D2ee523a2206206994597C13D831ec7&amp;outputCurrency=0xed11c9BCF69fdD2EEFd9Fe751BfcA32f171D53Ae" target="_blank" rel="noopener"><span>Buy KOIN on Uniswap</span><span class="where">USDT pair ↗</span></a>
           <p class="hint" style="padding:0 18px 12px">Swaps USDT → KOIN on Ethereum (bridge to Koinos with Chainge). Check the pool's liquidity before a big swap.</p></li>
         <li><a href="https://koinos.io/get-koin" target="_blank" rel="noopener"><span>All ways to get KOIN</span><span class="where">↗</span></a></li>`;
  }).catch(() => {});

  async function paint() {
    const addr = Wallet.address();
    if (!addr) return;
    $('#w-addr').textContent = addr;
    $('#w-create').textContent = 'Account active';
    $('#w-create').disabled = true;
    try {
      const a = await Api.account(addr);
      $('#w-koin').textContent = Number(a.koin).toLocaleString('en-US', { maximumFractionDigits: 8 });
      $('#w-nfts').textContent = a.nfts.length;
      $('#w-tokens').textContent = a.tokens.length;
      const mana = Number(a.mana) || 0;
      $('#w-mana').textContent = mana.toFixed(2) + (a.demo ? ' (demo)' : '');
      $('#w-mana-fill').style.width = Math.min(100, mana * 20) + '%';
    } catch (e) {
      $('#w-mana').textContent = 'unavailable';
    }
  }

  /* navigator.clipboard is undefined on insecure (http) origins and can
     reject; degrade to a select-and-copy prompt instead of failing silently. */
  async function copy(text, okMsg) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return toast(okMsg, 'ok');
      }
      throw new Error('no clipboard');
    } catch (_) {
      window.prompt('Copy with Ctrl/Cmd+C, then Enter:', text);
    }
  }

  $('#w-create').addEventListener('click', () => { if (Wallet.address()) return; UI.openLogin(); });
  document.addEventListener('dk:account', paint);
  // Revealing / copying / downloading the key counts as a backup, so logout
  // won't over-warn about losing a Local Wallet.
  const markBackedUp = () => { try { sessionStorage.setItem('dk_backed_up', '1'); } catch (_) {} };
  $('#w-copy').addEventListener('click', () => {
    const a = Wallet.address();
    if (!a) return toast('Create an account first', 'err');
    copy(a, 'Address copied');
  });

  /* backup */
  $('#w-reveal').addEventListener('click', () => {
    const wif = Wallet.exportWif();
    if (!wif) return toast('Create an account first', 'err');
    const box = $('#w-wif');
    const showing = box.classList.toggle('revealed'); if (showing) markBackedUp();
    box.textContent = showing ? wif : '····································';
    $('#w-reveal').textContent = showing ? 'Hide key' : 'Reveal key';
  });
  $('#w-copy-wif').addEventListener('click', () => {
    const wif = Wallet.exportWif();
    if (!wif) return toast('Create an account first', 'err');
    markBackedUp(); copy(wif, 'Private key copied — paste it somewhere SAFE');
  });
  $('#w-download').addEventListener('click', () => {
    const wif = Wallet.exportWif();
    if (!wif) return toast('Create an account first', 'err');
    const blob = new Blob([
      `Discover Koinos — account backup\n` +
      `address: ${Wallet.address()}\n` +
      `private key (WIF): ${wif}\n\n` +
      `Anyone with this key controls the account. Store it offline.\n`,
    ], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `koinos-account-${Wallet.address().slice(0, 8)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    /* revoke AFTER the browser has had a tick to start the download —
       Safari/older Firefox abort a synchronous revoke. */
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    markBackedUp(); toast('Backup downloaded', 'ok');
  });

  /* import */
  $('#w-import-btn').addEventListener('click', () => {
    const wif = $('#w-import').value.trim();
    if (!wif) return toast('Paste a private key first', 'err');
    try {
      const addr = Wallet.importAccount(wif);
      document.dispatchEvent(new CustomEvent('dk:account'));
      $('#w-import').value = '';
      toast('Account imported — ' + UI.short(addr), 'ok');
      $('#w-wif').classList.remove('revealed');
      $('#w-wif').textContent = '····································';
      $('#w-reveal').textContent = 'Reveal key';
      paint();
    } catch (_) {
      toast('That does not look like a valid WIF key', 'err');
    }
  });

  paint();
})();
