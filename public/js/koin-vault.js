/* KOIN Vault remote pairing. Private keys stay in the wallet. */
'use strict';
const KoinVault = (() => {
  const ORIGIN = 'https://koinvault.app', KEY = 'dk_koin_vault_v1';
  let session = null, checking = false;
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (saved && saved.sessionId && saved.secret && saved.address) session = saved;
  } catch (_) {}
  function save(value) {
    session = value;
    try { value ? sessionStorage.setItem(KEY, JSON.stringify(value)) : sessionStorage.removeItem(KEY); } catch (_) {}
    document.dispatchEvent(new CustomEvent('dk:account'));
  }
  async function json(path, body) {
    const response = await fetch(ORIGIN + path, {
      method: body ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(20000),
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || 'KOIN Vault did not respond. Try again.'), { status: response.status });
    return result;
  }
  const status = pair => json('/api/dapp/status?' + new URLSearchParams({ sessionId: pair.sessionId, secret: pair.secret }));
  function disconnect() {
    const old = session;
    if (old) {
      save(null);
      void json('/api/dapp/disconnect', old).catch(() => {});
    }
  }
  async function check() {
    if (!session || checking || document.hidden) return;
    const current = session;
    checking = true;
    try {
      const live = await status(current);
      if (session === current && (!live.connected || live.address !== current.address)) save(null);
    } catch (e) {
      if (session === current && [404, 410].includes(e.status)) save(null);
    } finally { checking = false; }
  }
  setInterval(check, 2500);
  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', check);
  setTimeout(check, 0);

  function wire(dialog) {
    const button = dialog.querySelector('#auth-vault');
    const panel = dialog.querySelector('#auth-vault-pair');
    let generation = 0, timer;
    const stop = () => {
      generation++; clearTimeout(timer); button.disabled = false;
      panel.hidden = true; panel.replaceChildren();
    };
    dialog.addEventListener('close', stop);
    dialog.addEventListener('cancel', stop);
    document.addEventListener('dk:account', () => { if (dialog.open) stop(); });
    button.addEventListener('click', async () => {
      stop(); const attempt = generation;
      button.disabled = true; panel.hidden = false; panel.textContent = 'Creating your secure connection…';
      const active = () => generation === attempt && dialog.open;
      try {
        const pair = await json('/api/dapp/create', { name: 'Use Koinos', walletUrl: ORIGIN });
        if (!active()) return;
        const uri = new URL(pair.uri);
        if (!pair.sessionId || !pair.secret || uri.origin !== ORIGIN || uri.pathname !== '/' || uri.username || uri.password || uri.searchParams.get('connect') !== pair.sessionId || uri.searchParams.get('secret') !== pair.secret) throw new Error('KOIN Vault returned an unexpected connection link.');
        // Encode locally: pairing secrets are never sent to a QR image service.
        const qr = qrcode(0, 'M'); qr.addData(uri.href); qr.make();
        panel.innerHTML = '<div style="background:white;padding:16px;text-align:center;border-radius:12px;color:#111">' + qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true }) + '<p>Scan with your phone camera and approve with your fingerprint in KOIN Vault.</p></div>';
        const svg = panel.querySelector('svg'); svg.style.cssText = 'width:240px;max-width:100%;height:auto';
        const link = document.createElement('a'); link.href = uri.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'btn'; link.textContent = 'Open KOIN Vault on this device'; panel.appendChild(link);
        const message = document.createElement('p'); message.setAttribute('role', 'status'); message.textContent = 'Waiting for approval…'; panel.appendChild(message);
        const cancel = document.createElement('button'); cancel.className = 'btn ghost small'; cancel.textContent = 'Cancel'; cancel.onclick = stop; panel.appendChild(cancel);
        const deadline = Math.min(Number(pair.expiresAt) || Date.now() + 300000, Date.now() + 300000);
        async function poll() {
          if (!active()) return;
          if (Date.now() >= deadline) { panel.textContent = 'Connection expired. Click Unlock with KOIN Vault to try again.'; button.disabled = false; return; }
          try {
            const live = await status(pair);
            if (!active()) return;
            if (live.connected && typeof live.address === 'string' && live.address) {
              save({ sessionId: pair.sessionId, secret: pair.secret, address: live.address });
              dialog.close(); return;
            }
            message.textContent = 'Waiting for approval…';
          } catch (e) {
            if (!active()) return;
            if ([404, 410].includes(e.status)) { panel.textContent = 'Connection expired. Please try again.'; button.disabled = false; return; }
            message.textContent = 'Connection interrupted. Retrying…';
          }
          if (active()) timer = setTimeout(poll, 1500);
        }
        void poll();
      } catch (e) {
        if (active()) { panel.textContent = e.message; button.disabled = false; }
      }
    });
  }
  return { address: () => session && session.address, disconnect, wire };
})();
