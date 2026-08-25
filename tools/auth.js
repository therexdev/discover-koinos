/* ============================================================
   Social / hosted login — custodial AT REST, non-custodial IN USE.

   Local Wallet and Import stay fully non-custodial (the key is made and
   kept in the browser). Google and X are a convenience path: the server
   generates a Koinos keypair, custodies it ENCRYPTED (AES-256-GCM under a
   key derived from LOGIN_SECRET), and RELEASES the plaintext WIF to the
   browser only on a verified login. From that moment the browser holds the
   key and signs locally, exactly like a Local Wallet — the server's copy is
   an encrypted backup, and the on-chain account never depends on us.

   Honest trade-off, stated in the UI: convenience accounts trust the
   gateway with an encrypted key; the Wallet page can export it any time.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Signer } = require('koilib');

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
  } = cfg;

  const FILE = path.join(dataDir, 'logins.json');
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

  const googleEnabled = () => !!googleClientId;
  const xEnabled = () => !!(xClientId && xClientSecret && xRedirectUri);

  /* ---- Google (GSI ID token) ---- */
  async function google(idToken) {
    if (!googleEnabled()) { const e = new Error('Google sign-in is not configured on this server'); e.status = 503; throw e; }
    if (!idToken) { const e = new Error('idToken required'); e.status = 400; throw e; }
    let info;
    try {
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { signal: AbortSignal.timeout(10000) });
      if (!r.ok) { const e = new Error('Google rejected that sign-in — try again'); e.status = 401; throw e; }
      info = await r.json();
    } catch (e) { if (e.status) throw e; const x = new Error('Could not reach Google — try again shortly'); x.status = 502; throw x; }
    if (info.aud !== googleClientId) { const e = new Error('That sign-in belongs to a different app'); e.status = 401; throw e; }
    if (String(info.email_verified) !== 'true' || !info.sub) { const e = new Error('Google did not verify that account'); e.status = 401; throw e; }
    let rec = store.byGoogle[info.sub];
    const created = !rec;
    if (!rec) {
      const acct = newHosted();
      rec = store.byGoogle[info.sub] = { email: String(info.email || '').toLowerCase(), wifEnc: encryptWif(acct.wif), addr: acct.address, createdAt: Date.now() };
      save();
    }
    return { wif: release(rec, 'google'), address: rec.addr, created, label: rec.email || 'Google account' };
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

  return { googleEnabled, xEnabled, google, xLoginUrl, xCallback, xClaimWif };
}

module.exports = { createAuth };
