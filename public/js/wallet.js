/* ============================================================
   The visitor's Koinos account.
   No extension, no popups, no gas: the gateway GENERATES a real
   Koinos account in the browser (koilib, vendored) and keeps the
   key in localStorage. The address IS the identity. Every
   transaction the key signs is co-signed by the gateway's sponsor
   wallet as mana payer, so trying Koinos costs nothing — ever.

   The key never leaves this device except when the visitor
   exports it (WIF backup) — back it up, it IS the account.
   ============================================================ */
'use strict';

const Wallet = (() => {
  const LS_KEY = 'dk_wif';
  let signer = null;
  let account = null;

  const hasLib = () => typeof Signer !== 'undefined';

  function loadKey() {
    if (signer) return true;
    const wif = localStorage.getItem(LS_KEY);
    if (!wif) return false;
    try {
      signer = Signer.fromWif(wif);
      account = signer.getAddress();
      return true;
    } catch (_) {
      console.error('Stored account key is unreadable — leaving it untouched');
      return false;
    }
  }

  /** Create a brand-new Koinos account (or return the existing one). */
  function createAccount() {
    if (loadKey()) return account;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    signer = new Signer({ privateKey: hex });
    localStorage.setItem(LS_KEY, signer.getPrivateKey('wif', true));
    account = signer.getAddress();
    return account;
  }

  /** Import an account from a WIF backup. Replaces the current key. */
  function importAccount(wif) {
    const s = Signer.fromWif(String(wif).trim());
    localStorage.setItem(LS_KEY, String(wif).trim());
    signer = s;
    account = s.getAddress();
    return account;
  }

  /** The WIF backup of this account — show it, never send it anywhere. */
  const exportWif = () => (loadKey() ? localStorage.getItem(LS_KEY) : null);

  const address = () => (loadKey() ? account : null);
  const exists = () => loadKey();

  /** Sign the standard request proof: the server only performs free
      actions for an address that demonstrably controls its key. Silent —
      no popups, the key is right here. */
  async function proof(action) {
    if (!loadKey()) createAccount();
    const ts = Date.now();
    const sig = await signer.signMessage(`discover-koinos:${action}:${ts}`);
    return { address: account, ts, sig: btoa(String.fromCharCode(...sig)) };
  }

  /** Sign a server-prepared transaction (adds our signature, returns it).
      The server then co-signs as mana payer and broadcasts. */
  async function signTx(tx) {
    if (!loadKey()) throw new Error('No account on this device yet');
    return signer.signTransaction(tx);
  }

  /**
   * A full sponsored user action: ask the server to prepare the exact
   * transaction, sign it locally, send it back for co-sign + broadcast.
   */
  async function sponsoredAction(action, params) {
    const p = await proof('prepare');
    const prep = await Api.prepare({ ...p, action, params });
    if (prep.demo) return Api.submit({ ref: prep.ref, transaction: { id: 'demo' } });
    const signed = await signTx(prep.tx);
    return Api.submit({ ref: prep.ref, transaction: signed });
  }

  return {
    hasLib, exists, address, createAccount, importAccount, exportWif,
    proof, signTx, sponsoredAction,
  };
})();
