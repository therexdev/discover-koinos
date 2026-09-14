const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const saved = { sessionId: 'pair', secret: 'secret', address: 'vault-address' };
function setup() {
  const storage = new Map([['dk_koin_vault_v1', JSON.stringify(saved)]]);
  const calls = [];
  let connected = true;
  const context = vm.createContext({
    sessionStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    localStorage: { getItem: () => 'local-key', removeItem() {} },
    document: { hidden: false, dispatchEvent() {}, addEventListener() {} },
    window: { addEventListener() {} }, CustomEvent: class {},
    setInterval(fn) { calls.push(fn); }, setTimeout() {}, clearTimeout() {},
    AbortSignal, URLSearchParams, console,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, connected, address: saved.address }) }),
    Signer: { fromWif: () => ({ getAddress: () => 'local-address' }) },
  });
  vm.runInContext(fs.readFileSync('public/js/koin-vault.js','utf8') + '\n' + fs.readFileSync('public/js/wallet.js','utf8') + '\nthis.wallet=Wallet;this.vault=KoinVault;', context);
  return { context, storage, check: calls[0], revoke: () => { connected = false; } };
}
(async () => {
  const s=setup();
  assert.equal(s.context.wallet.address(), saved.address);
  assert.equal(s.context.wallet.exists(), true);
  assert.equal(s.context.wallet.exportWif(), null);
  await assert.rejects(s.context.wallet.proof('prepare'), /not yet supported/);
  await assert.rejects(s.context.wallet.signTx({}), /not yet supported/);
  await s.check(); assert.equal(s.context.vault.address(), saved.address);
  s.revoke(); await s.check(); assert.equal(s.context.vault.address(), null);
  assert.equal(s.storage.has('dk_koin_vault_v1'), false);
  const fresh=setup(); fresh.context.vault.disconnect();
  assert.equal(fresh.context.vault.address(), null);
  console.log('KOIN Vault session restore, revocation, disconnect, and signing isolation passed');
})().catch(e => { console.error(e); process.exitCode=1; });
