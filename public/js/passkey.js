/* ============================================================
   Passkey wallets — the wallet IS the passkey.

   WebAuthn's PRF extension makes the device's authenticator produce a
   deterministic 32-byte secret, gated by the device's own unlock (face,
   fingerprint, or PIN — the OS decides). We turn that secret into the
   account's secp256k1 key, so ONE SCAN both creates and re-opens the
   wallet. Nothing is stored anywhere: the same passkey + the same salt
   always re-derive the same key, on every device the passkey syncs to
   (iCloud Keychain / Google Password Manager). Non-custodial end to end.
   ============================================================ */
'use strict';

const Passkey = (() => {
  const CRED_KEY = 'dk_passkey_id';
  /* Fixed derivation salt. CHANGING IT CHANGES EVERY PASSKEY WALLET'S
     ADDRESS — it is part of the protocol, not a config knob. */
  const SALT = new TextEncoder().encode('discover-koinos:wallet:v1');

  const supported = () =>
    !!(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);

  /** Is a biometric/PIN platform authenticator actually available here? */
  async function platformReady() {
    if (!supported()) return false;
    try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); }
    catch (_) { return false; }
  }

  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

  function storeId(rawId) { try { localStorage.setItem(CRED_KEY, b64u(rawId)); } catch (_) {} }
  function storedId() { try { return localStorage.getItem(CRED_KEY); } catch (_) { return null; } }
  const remembered = () => !!storedId();

  /* PRF secret → secp256k1 private key. The bytes are hashed (whitening)
     and range-checked against the curve order — deterministically iterated
     on the astronomically unlikely miss — so every PRF value maps to a
     valid key and the SAME PRF value always maps to the SAME key. */
  const CURVE_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  async function deriveWif(prfBytes) {
    let bytes = new Uint8Array(prfBytes);
    for (let i = 0; i < 16; i++) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hex = Array.from(digest).map(b => b.toString(16).padStart(2, '0')).join('');
      const k = BigInt('0x' + hex);
      if (k > 0n && k < CURVE_N) return new Signer({ privateKey: hex }).getPrivateKey('wif', true);
      bytes = digest;
    }
    throw new Error('key derivation failed');   // unreachable in practice
  }

  const challenge = () => crypto.getRandomValues(new Uint8Array(32));
  function prfFrom(cred) {
    const ext = cred.getClientExtensionResults();
    return (ext && ext.prf && ext.prf.results && ext.prf.results.first) || null;
  }

  /** One assertion (one scan) → the PRF secret. An empty allow-list opens
      the platform's own passkey picker, synced passkeys included. */
  async function assertPrf(allowIds) {
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: challenge(),
        rpId: location.hostname,
        userVerification: 'required',
        allowCredentials: (allowIds || []).map(id => ({ type: 'public-key', id: fromB64u(id) })),
        extensions: { prf: { eval: { first: SALT } } },
      },
    });
    const prf = prfFrom(cred);
    if (!prf) throw new Error('This passkey can’t derive a wallet key (no PRF support on this device) — use another sign-in method');
    storeId(cred.rawId);
    return prf;
  }

  /** Create the passkey AND the wallet inside it. One scan on most
      devices; some platforms return the PRF only from an assertion, which
      shows a second quick prompt right after. */
  async function create() {
    const existing = storedId();
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Discover Koinos', id: location.hostname },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: 'Koinos Wallet',
          displayName: 'Koinos Wallet',
        },
        challenge: challenge(),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',   // this device's own biometrics/PIN
          residentKey: 'required',               // discoverable → syncs across devices
          userVerification: 'required',          // a scan, every time — never silent
        },
        // Never mint a SECOND wallet-passkey on a device that has one.
        excludeCredentials: existing ? [{ type: 'public-key', id: fromB64u(existing) }] : [],
        extensions: { prf: { eval: { first: SALT } } },
      },
    });
    storeId(cred.rawId);
    let prf = prfFrom(cred);
    if (!prf) prf = await assertPrf([b64u(cred.rawId)]);
    const wif = await deriveWif(prf);
    return { address: Wallet.adoptWif(wif), created: true };
  }

  /** Unlock: the same scan re-derives the same key. Works on a fresh
      device too — the picker offers the user's synced passkeys. */
  async function unlock() {
    const id = storedId();
    const prf = await assertPrf(id ? [id] : []);
    const wif = await deriveWif(prf);
    return { address: Wallet.adoptWif(wif), created: false };
  }

  return { supported, platformReady, remembered, create, unlock };
})();
