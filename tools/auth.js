/* ============================================================
   Social / hosted login — non-custodial IN USE, two custody homes.

   Local Wallet and Import stay fully non-custodial (the key is made and
   kept in the browser).

   GOOGLE opens the SAME wallet the account owns in Aurvania and on OURO —
   one identity, one address, every site. How that happens depends on whether
   this gateway can keep an encrypted key:

     - Without LOGIN_SECRET it stays BRIDGED, custodying nothing: the ID
       token goes to aurvania.com/api/account and Aurvania answers with
       the wallet.
     - With LOGIN_SECRET this gateway is the account home. It verifies the
       ID token with Google itself and holds the key, and the first time it
       meets an account it ADOPTS the wallet Aurvania already has rather
       than generating one — which is what keeps every existing address
       intact through the move.

   Either way the ID token must be minted for the Google client id Aurvania
   checks `aud` against, so the button uses that id — set GOOGLE_CLIENT_ID
   to it, or leave it unset and we inherit it from Aurvania at boot.

   X (Twitter) is the one convenience path we custody ourselves: the server
   generates a keypair, stores it ENCRYPTED (AES-256-GCM under a key derived
   from LOGIN_SECRET), and releases the WIF only on a verified login. From
   that moment the browser signs locally, exactly like a Local Wallet.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Signer } = require('koilib');

const { normalizeEmail } = require('./gifts');

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createAuth(cfg) {
  const {
    dataDir,
    loginSecret,
    googleClientId = '',
    xClientId = '',
    xClientSecret = '',
    xRedirectUri = '',
    // Google bridge → Aurvania / OURO shared account system.
    aurvaniaApi = 'https://aurvania.com',
    bridgeUa = 'curl/8.5.0 (Discover-Koinos gateway)',
    /* Set once LOGIN_SECRET is present: this gateway then verifies Google ID
       tokens itself and custodies the keys, adopting the existing wallet from
       Aurvania the first time it sees an account. See google(). */
    googleLocalCustody = false,
    // overridable so the verification path is testable without Google
    googleTokenInfo = 'https://oauth2.googleapis.com/tokeninfo',
    /* Aurvania's LOGIN_SECRET, when a bulk import is wanted (see below). */
    aurvaniaImportSecret = '',
    /* Server-side signer session lifetime, minutes (see the signer section). */
    sessionTtlMins = 180,
  } = cfg;

  /* The Google client id we actually use. If the operator set one we keep
     it; otherwise warmup() inherits Aurvania's, so the browser mints an ID
     token Aurvania will accept (it checks `aud` against its own id). */
  let resolvedGoogleCid = String(googleClientId || '').trim();

  /* aurvania.com's host 403s unfamiliar User-Agents, so the bridge speaks
     with a curl-like identity (the pattern OURO already ships). */
  async function bridgeFetch(url, opts = {}) {
    const { timeoutMs = 12000, headers = {}, ...rest } = opts;
    const r = await fetch(url, {
      ...rest,
      headers: { 'User-Agent': bridgeUa, Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = null;
    try { body = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, body };
  }

  /* Best-effort at boot: if we have no Google client id of our own, inherit
     Aurvania's so Google sign-in still yields the shared wallet. */
  async function warmup() {
    if (resolvedGoogleCid) return;
    try {
      const r = await bridgeFetch(aurvaniaApi + '/api/chain-info', { timeoutMs: 12000 });
      if (r.ok && r.body && r.body.googleClientId) resolvedGoogleCid = String(r.body.googleClientId);
    } catch (_) { /* Aurvania unreachable at boot — Google stays off until set */ }
  }

  // The email is only for the account-menu label; the security is Aurvania's
  // verification, so decoding the (unverified) token payload here is fine.
  function jwtEmail(idToken) {
    try {
      const seg = String(idToken).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const p = JSON.parse(Buffer.from(seg, 'base64').toString('utf8'));
      return p && p.email ? String(p.email) : '';
    } catch (_) { return ''; }
  }

  const FILE = path.join(dataDir, 'logins.json');

  /* ---- boot-time bulk import from Aurvania ----
     The no-terminal path for completing the store: drop Aurvania's
     logins.json into DATA_DIR as `aurvania-logins.json`, set
     AURVANIA_LOGIN_SECRET, restart. Running here — before the store is
     loaded, inside the only process that ever writes it — removes the
     stop-the-server-first hazard the standalone CLI carries.

     Gated on local custody: without the real LOGIN_SECRET the wrapping key
     is random per boot, and wallets imported under it would be unopenable
     after the next restart. All-or-nothing: a failed import logs loudly,
     writes nothing, and the gateway boots normally on its existing store. */
  if (googleLocalCustody && aurvaniaImportSecret) {
    const src = path.join(dataDir, 'aurvania-logins.json');
    if (fs.existsSync(src)) {
      try {
        const { importAurvania } = require('./import-aurvania');
        const r = importAurvania({
          sourceFile: src, sourceSecret: aurvaniaImportSecret,
          destFile: FILE, destSecret: loginSecret, write: true,
        });
        for (const line of r.failLines) console.error('[auth:import] ' + line);
        for (const line of r.lines) console.log('[auth:import] ' + line);
        if (r.ok) {
          const done = src.replace(/\.json$/, `.imported-${Date.now()}.json`);
          try { fs.renameSync(src, done); console.log(`[auth:import] source renamed to ${path.basename(done)} — it will not be processed again (safe to delete)`); }
          catch (_) { console.log('[auth:import] could not rename the source file — re-running is harmless (a clean no-op), but delete it once done'); }
        } else {
          console.error(`[auth:import] IMPORT ABORTED — ${r.failures} record(s) failed, the store is untouched. Usually AURVANIA_LOGIN_SECRET is wrong; fix and restart.`);
        }
      } catch (e) {
        console.error('[auth:import] import could not run: ' + e.message + ' — the store is untouched');
      }
    } else {
      console.log('[auth:import] AURVANIA_LOGIN_SECRET is set but data/aurvania-logins.json was not found — nothing to import (remove the env var once migration is done)');
    }
  }

  let store;
  try { store = JSON.parse(fs.readFileSync(FILE)); } catch (_) { store = {}; }
  store.byGoogle = store.byGoogle || {};
  store.byX = store.byX || {};
  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  }

  /* ---- WIF custody ---- */
  let _key = null;
  const wifKey = () => (_key || (_key = crypto.scryptSync(loginSecret, 'dk-wif-enc-v1', 32)));
  function encryptWif(wif) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', wifKey(), iv);
    const data = Buffer.concat([c.update(wif, 'utf8'), c.final()]);
    return [iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
  }
  function decryptWif(blob) {
    const [iv, tag, data] = String(blob).split('.').map(x => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', wifKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  }
  function newHosted() {
    const s = new Signer({ privateKey: crypto.randomBytes(32).toString('hex') });
    return { wif: s.getPrivateKey('wif', true), address: s.getAddress() };
  }
  /* Release a stored key; a decrypt failure means LOGIN_SECRET changed — say
     so loudly rather than as a generic 500 (retrying cannot help). */
  const alarmed = new Set();
  function release(rec, who) {
    try { return decryptWif(rec.wifEnc); }
    catch (_) {
      const tag = who + ':' + (rec.addr || '?');
      if (!alarmed.has(tag)) {
        alarmed.add(tag);
        console.error(`[SECURITY] cannot decrypt the stored wallet key for ${tag} — LOGIN_SECRET changed. Restore the previous secret; this account cannot log in until then.`);
      }
      const e = new Error('This account’s stored key cannot be opened on this server. Contact the operator.');
      e.status = 500;
      throw e;
    }
  }

  const googleEnabled = () => !!resolvedGoogleCid;
  const xEnabled = () => !!(xClientId && xClientSecret && xRedirectUri);

  /* ---- Google ----
     Two modes, and the wallet is the same address in both.

     Without LOGIN_SECRET we cannot keep an encrypted key across a restart, so
     Google stays purely BRIDGED: Aurvania verifies and answers with the
     wallet, exactly as before.

     With LOGIN_SECRET (googleLocalCustody) this gateway becomes the account
     home: it verifies the ID token itself and holds the key. The first time
     it meets an account it ADOPTS the wallet Aurvania already has for it
     rather than generating one — see google() for why that is not optional. */

  /* Verify the ID token with Google. Mandatory the moment we custody keys:
     a local record is released on the strength of `sub` alone, so without
     this an attacker could hand us any JSON and open someone's wallet. */
  async function verifyGoogleIdToken(idToken) {
    let info;
    try {
      const r = await fetch(googleTokenInfo + '?id_token=' + encodeURIComponent(idToken), {
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) { const e = new Error('Google rejected that sign-in — try again'); e.status = 401; throw e; }
      info = await r.json();
    } catch (e) {
      if (e.status) throw e;
      const x = new Error('Could not reach Google — try again shortly'); x.status = 502; throw x;
    }
    if (info.aud !== resolvedGoogleCid) {
      const e = new Error('That sign-in belongs to a different app'); e.status = 401; throw e;
    }
    if (String(info.email_verified) !== 'true' || !info.sub || !info.email) {
      const e = new Error('Google did not verify that email'); e.status = 401; throw e;
    }
    /* tokeninfo rejects an expired token itself, so this is belt and braces
       against a cached or replayed 200. */
    if (info.exp && Number(info.exp) * 1000 <= Date.now()) {
      const e = new Error('That sign-in expired — try again'); e.status = 401; throw e;
    }
    return { sub: String(info.sub), email: String(info.email).toLowerCase() };
  }

  /* The wallet Aurvania holds for this identity. Note there is no "no wallet"
     answer: Aurvania creates one when it has none, so a success here is
     always the canonical address for the account. */
  async function aurvaniaWallet(idToken) {
    let r;
    try {
      r = await bridgeFetch(aurvaniaApi + '/api/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'google', idToken }),
        timeoutMs: 15000,
      });
    } catch (_) {
      const e = new Error('Could not reach the Koinos account service — try again shortly');
      e.status = 502; throw e;
    }
    if (!r.ok || !r.body || !r.body.wif) {
      // Pass Aurvania's own reason through — a mismatched client id shows up
      // here as "belongs to a different app", which points at the real fix.
      const e = new Error((r.body && r.body.error) || 'Google sign-in failed');
      e.status = r.status || 502; throw e;
    }
    return { wif: String(r.body.wif), address: String(r.body.address), created: !!r.body.created };
  }

  async function google(idToken) {
    if (!googleEnabled()) { const e = new Error('Google sign-in is not configured on this server'); e.status = 503; throw e; }
    if (!idToken) { const e = new Error('idToken required'); e.status = 400; throw e; }

    if (!googleLocalCustody) {
      const remote = await aurvaniaWallet(idToken);
      return { ...remote, label: jwtEmail(idToken) || 'Google account' };
    }

    const id = await verifyGoogleIdToken(idToken);

    const rec = store.byGoogle[id.sub];
    if (rec && rec.wifEnc) {
      if (rec.email !== id.email) { rec.email = id.email; save(); }
      await afterSignIn(id.email, rec.addr);
      return { wif: release(rec, 'google'), address: rec.addr, created: false, label: id.email };
    }

    /* First time this gateway has seen the account.

       Do NOT generate a wallet here. The same Google account almost certainly
       already owns one in Aurvania, and minting a fresh key would hand the
       user a different address and strand whatever the old one holds. Adopt
       Aurvania's answer instead — that is what keeps the address identical
       across every site through this change.

       And if Aurvania cannot be reached, FAIL. "No local record" is not
       evidence that no wallet exists, and a new key issued on a bad guess is
       not recoverable. */
    const remote = await aurvaniaWallet(idToken);

    // the released key must actually control the address it came with
    let derived;
    try { derived = Signer.fromWif(remote.wif).getAddress(); }
    catch (_) { derived = ''; }
    if (derived !== remote.address) {
      const e = new Error('The account service returned a mismatched wallet — sign-in refused');
      e.status = 502; throw e;
    }

    store.byGoogle[id.sub] = {
      email: id.email,
      wifEnc: encryptWif(remote.wif),
      addr: remote.address,
      adoptedFrom: aurvaniaApi,
      adoptedAt: Date.now(),
    };
    save();
    console.log(`[auth] adopted the Google wallet ${remote.address} from ${aurvaniaApi}`);

    await afterSignIn(id.email, remote.address);
    return { wif: remote.wif, address: remote.address, created: !!remote.created, label: id.email };
  }

  /* ---- X (Twitter) OAuth 2.0 with PKCE ----
     A full redirect flow: the WIF never rides in a URL. The callback stores
     a one-time claim code that the returning page exchanges for the key. */
  const xStates = new Map();   // state -> { verifier, expires }
  const xClaims = new Map();   // claim -> { wif, address, label, expires }
  function sweep(map) { const now = Date.now(); for (const [k, v] of map) if (v.expires < now) map.delete(k); }

  function xLoginUrl() {
    if (!xEnabled()) { const e = new Error('X sign-in is not configured on this server'); e.status = 503; throw e; }
    sweep(xStates);
    const state = base64url(crypto.randomBytes(24));
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    xStates.set(state, { verifier, expires: Date.now() + 10 * 60000 });
    const u = new URL('https://twitter.com/i/oauth2/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', xClientId);
    u.searchParams.set('redirect_uri', xRedirectUri);
    u.searchParams.set('scope', 'users.read tweet.read');
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  async function xCallback(code, state) {
    if (!xEnabled()) { const e = new Error('X sign-in is not configured'); e.status = 503; throw e; }
    const st = xStates.get(String(state || ''));
    if (!st || st.expires < Date.now()) { const e = new Error('This sign-in link expired — start again'); e.status = 400; throw e; }
    xStates.delete(String(state));
    if (!code) { const e = new Error('X did not return an authorization code'); e.status = 400; throw e; }

    // Exchange the code (confidential client → HTTP Basic with the secret).
    let tok;
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code', code: String(code),
        redirect_uri: xRedirectUri, code_verifier: st.verifier, client_id: xClientId,
      });
      const r = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(`${xClientId}:${xClientSecret}`).toString('base64'),
        },
        body, signal: AbortSignal.timeout(10000),
      });
      tok = await r.json();
      if (!r.ok || !tok.access_token) { const e = new Error('X rejected that sign-in — try again'); e.status = 401; throw e; }
    } catch (e) { if (e.status) throw e; const x = new Error('Could not reach X — try again shortly'); x.status = 502; throw x; }

    let me;
    try {
      const r = await fetch('https://api.twitter.com/2/users/me', {
        headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10000),
      });
      me = await r.json();
      if (!r.ok || !me.data || !me.data.id) { const e = new Error('X did not identify that account'); e.status = 401; throw e; }
    } catch (e) { if (e.status) throw e; const x = new Error('Could not reach X — try again shortly'); x.status = 502; throw x; }

    const id = String(me.data.id);
    const username = me.data.username ? String(me.data.username).slice(0, 40) : '';
    let rec = store.byX[id];
    if (!rec) {
      const acct = newHosted();
      rec = store.byX[id] = { username, wifEnc: encryptWif(acct.wif), addr: acct.address, createdAt: Date.now() };
      save();
    } else if (username && rec.username !== username) { rec.username = username; save(); }

    sweep(xClaims);
    const claim = base64url(crypto.randomBytes(24));
    xClaims.set(claim, { wif: release(rec, 'x'), address: rec.addr, label: username ? '@' + username : 'X account', expires: Date.now() + 2 * 60000 });
    return { claim };
  }

  function xClaimWif(claim) {
    sweep(xClaims);
    const c = xClaims.get(String(claim || ''));
    if (!c) { const e = new Error('This sign-in expired — try again'); e.status = 400; throw e; }
    xClaims.delete(String(claim));
    return { wif: c.wif, address: c.address, label: c.label };
  }

  /* ==========================================================================
     Server-side signer — the wallet key never leaves this process.

     Instead of releasing the WIF to the browser (google() above), a Google
     login here mints a short-lived SESSION TOKEN, and the app asks this
     server to SIGN transactions with the held key. An XSS on the app can, at
     worst, ask for a signature during the token's lifetime through a
     rate-limited endpoint — it can never walk off with the key, which is the
     difference between "an incident" and "every wallet drained forever".

     The token is a stateless HMAC over {sub, addr, exp} under a secret
     derived from LOGIN_SECRET, so it survives a restart (the app stays signed
     in across a redeploy) with no server-side session table. Short TTL bounds
     a stolen token; rotating LOGIN_SECRET invalidates every token at once as
     the emergency stop. Requires local custody — without a held key there is
     nothing to sign with.
     ========================================================================== */

  const sessionTtlMs = Math.max(5, Number(sessionTtlMins) || 180) * 60000;
  let _sessKey = null;
  const sessionKey = () => (_sessKey || (_sessKey = crypto.scryptSync(loginSecret, 'dk-session-v1', 32)));

  function signerEnabled() { return googleEnabled() && googleLocalCustody; }

  function makeSessionToken(sub, addr) {
    const payload = base64url(JSON.stringify({ sub, addr, exp: Date.now() + sessionTtlMs }));
    const mac = base64url(crypto.createHmac('sha256', sessionKey()).update(payload).digest());
    return payload + '.' + mac;
  }

  function verifySessionToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const expected = base64url(crypto.createHmac('sha256', sessionKey()).update(parts[0]).digest());
    const a = Buffer.from(parts[1]), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let p;
    try { p = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
    catch (_) { return null; }
    if (!p || !p.sub || !p.addr || !p.exp || Date.now() > Number(p.exp)) return null;
    return { sub: String(p.sub), addr: String(p.addr) };
  }

  /* Google login for signer apps: verify, ensure the account exists (adopting
     the Aurvania wallet on first sight, exactly like google()), and hand back
     a session token — never the WIF. */
  async function googleSession(idToken) {
    if (!signerEnabled()) {
      const e = new Error('Server-side signing is not enabled here (needs LOGIN_SECRET + Google)');
      e.status = 503; throw e;
    }
    if (!idToken) { const e = new Error('idToken required'); e.status = 400; throw e; }

    const id = await verifyGoogleIdToken(idToken);
    let rec = store.byGoogle[id.sub];
    if (rec && rec.wifEnc) {
      if (rec.email !== id.email) { rec.email = id.email; save(); }
    } else {
      // first sight — adopt Aurvania's existing wallet (never mint), same rule
      // as google(): if Aurvania can't be reached, fail rather than guess.
      const remote = await aurvaniaWallet(idToken);
      let derived;
      try { derived = Signer.fromWif(remote.wif).getAddress(); } catch (_) { derived = ''; }
      if (derived !== remote.address) {
        const e = new Error('The account service returned a mismatched wallet — sign-in refused');
        e.status = 502; throw e;
      }
      rec = store.byGoogle[id.sub] = {
        email: id.email, wifEnc: encryptWif(remote.wif), addr: remote.address,
        adoptedFrom: aurvaniaApi, adoptedAt: Date.now(),
      };
      save();
    }
    await afterSignIn(id.email, rec.addr);
    return { token: makeSessionToken(id.sub, rec.addr), address: rec.addr, label: id.email, expiresInMs: sessionTtlMs };
  }

  /* Sign a prepared koilib transaction with the session's key. The key is
     decrypted, used, and dropped inside this call — it is never returned. The
     app broadcasts the signed transaction itself; this server only signs. */
  async function signWithToken(token, transaction) {
    if (!signerEnabled()) { const e = new Error('Server-side signing is not enabled here'); e.status = 503; throw e; }
    const sess = verifySessionToken(token);
    if (!sess) { const e = new Error('Your session expired — sign in again'); e.status = 401; throw e; }
    const rec = store.byGoogle[sess.sub];
    if (!rec || !rec.wifEnc) { const e = new Error('That account is no longer available here'); e.status = 401; throw e; }
    if (rec.addr !== sess.addr) { const e = new Error('Session/account mismatch — sign in again'); e.status = 401; throw e; }
    if (!transaction || typeof transaction !== 'object' || !transaction.header) {
      const e = new Error('a prepared transaction is required'); e.status = 400; throw e;
    }

    const signer = Signer.fromWif(release(rec, 'google'));
    // koilib signs in place, appending to transaction.signatures
    const signed = await signer.signTransaction(transaction);
    const signatures = (signed && signed.signatures) || transaction.signatures || [];
    return { address: rec.addr, id: transaction.id, signatures };
  }

  /** The wallet this gateway already knows for an email address, or null.

      Gmail's dots and +tags mean one inbox has many spellings, so both sides
      are normalized before comparing — otherwise a gift addressed to one
      spelling would never find the account that reads it. */
  function addressForEmail(email) {
    const want = normalizeEmail(email);
    if (!want) return null;
    for (const rec of Object.values(store.byGoogle)) {
      if (rec && rec.addr && normalizeEmail(rec.email) === want) return rec.addr;
    }
    return null;
  }

  /** Called after any successful Google sign-in with the VERIFIED email off
      Google's own token. Whatever it does must never break the sign-in. */
  async function afterSignIn(email, address) {
    if (typeof cfg.onGoogleSignIn !== 'function') return;
    try { await cfg.onGoogleSignIn(email, address); }
    catch (e) { console.error('[auth] post-sign-in hook failed: ' + (e.message || e)); }
  }

  return {
    warmup, googleEnabled, xEnabled, google, xLoginUrl, xCallback, xClaimWif,
    googleSession, signWithToken, verifySessionToken,
    signerEnabled, addressForEmail,
    googleClientId: () => resolvedGoogleCid,
    googleCustody: () => !!googleLocalCustody,
    aurvania: () => aurvaniaApi,
  };
}

module.exports = { createAuth };
