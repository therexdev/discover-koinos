/* Wallet page: account details, balances, backup, import, faucets. */
'use strict';

(async () => {
  const { $, toast, escapeHtml } = UI;
  const cfg = await UI.initHeader().catch(() => null);

  if (cfg) {
    const sym = cfg.nativeSymbol || 'tKOIN';
    $('#w-symbol').textContent = sym;
    $('#w-koin-label').textContent = sym + ' balance';
    const faucets = (cfg.faucets || []);
    $('#w-faucets').innerHTML = faucets.length
      ? faucets.map(f => `<li><a href="${escapeHtml(f.url)}" target="_blank" rel="noopener"><span>${escapeHtml(f.name)}</span><span class="where">↗</span></a><p class="hint" style="padding:0 18px 12px">${escapeHtml(f.note)}</p></li>`).join('')
      : '<li><a href="https://koinos.io/get-koin" target="_blank" rel="noopener"><span>Where to get KOIN</span><span class="where">↗</span></a></li>';
  }

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

  $('#w-create').addEventListener('click', () => { UI.ensureAccount(); paint(); });
  $('#w-copy').addEventListener('click', async () => {
    const a = Wallet.address();
    if (!a) return toast('Create an account first', 'err');
    await navigator.clipboard.writeText(a);
    toast('Address copied', 'ok');
  });

  /* backup */
  $('#w-reveal').addEventListener('click', () => {
    const wif = Wallet.exportWif();
    if (!wif) return toast('Create an account first', 'err');
    const box = $('#w-wif');
    const showing = box.classList.toggle('revealed');
    box.textContent = showing ? wif : '····································';
    $('#w-reveal').textContent = showing ? 'Hide key' : 'Reveal key';
  });
  $('#w-copy-wif').addEventListener('click', async () => {
    const wif = Wallet.exportWif();
    if (!wif) return toast('Create an account first', 'err');
    await navigator.clipboard.writeText(wif);
    toast('Private key copied — paste it somewhere SAFE', 'ok');
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
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Backup downloaded', 'ok');
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
