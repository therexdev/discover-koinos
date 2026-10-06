'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TTL_MS, PATHS, canonical, validOrigin, message } = require('../public/js/request-proof');
const SKEW_MS = 30000;
const CROSS_ORIGIN_ACTIONS = new Set(['launch-token', 'launchpad-logo', 'launchpad-profile']);
const FIELDS = ['version', 'action', 'method', 'path', 'address', 'audience', 'origin', 'network',
  'issuedAt', 'expiresAt', 'nonce', 'payloadHash', 'signature'].sort();
const fail = (status, text) => { throw Object.assign(new Error(text), { status }); };

/* All workers must share this persistent directory on a filesystem supporting
   atomic exclusive create and fsync. Separate replica-local disks are unsupported.
   The timestamp is part of the nonce and cannot be changed to revive an expired
   record. This makes cleanup safe even when workers race with new requests. */
function createNonceStore(directory, now = Date.now) {
  let cursor;
  function sweep(time) {
    if (!cursor) cursor = fs.opendirSync(directory);
    for (let i = 0; i < 64; i++) {
      const entry = cursor.readSync();
      if (!entry) { cursor.closeSync(); cursor = null; break; }
      const m = /^(\d{1,16})-[a-f0-9]{64}$/.exec(entry.name);
      if (entry.isFile() && m && Number(m[1]) + TTL_MS <= time) {
        try { fs.unlinkSync(path.join(directory, entry.name)); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
  }
  return {
    consume(address, nonce, issuedAt) {
      let fd, creatingNonce = false;
      try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        sweep(now());
        const key = crypto.createHash('sha256').update(address + ':' + nonce).digest('hex');
        creatingNonce = true;
        fd = fs.openSync(path.join(directory, issuedAt + '-' + key), 'wx', 0o600);
        creatingNonce = false;
        fs.writeFileSync(fd, 'used\n');
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        // Persist the directory entry before allowing any sponsored operation.
        fd = fs.openSync(directory, 'r');
        fs.fsyncSync(fd);
      } catch (e) {
        if (creatingNonce && e.code === 'EEXIST') fail(409, 'this signed request has already been used');
        fail(503, 'secure request storage is unavailable — try again later');
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); }
          catch (_) { fail(503, 'secure request storage is unavailable — try again later'); }
        }
      }
    },
    close() { if (cursor) { cursor.closeSync(); cursor = null; } },
  };
}

function createRequestProofVerifier({ audience, network, origins = [], directory, isAddress, verifySignature, now = Date.now }) {
  const configured = validOrigin(audience) && ['mainnet', 'harbinger'].includes(network);
  const store = createNonceStore(directory, now);
  return {
    config: () => configured ? { version: 2, audience, network, ttlMs: TTL_MS } : null,
    close: () => store.close(),
    verify(body, action, req) {
      if (!configured) fail(503, 'secure request signing is not configured');
      if (!body || Array.isArray(body) || typeof body !== 'object' || !isAddress(body.address)) fail(401, 'a valid signed account is required');
      if (['sessionToken', 'ts', 'sig'].some(k => Object.hasOwn(body, k))) fail(401, 'legacy or mixed request credentials are not accepted — refresh this page');
      const p = body.proof;
      if (!p || Array.isArray(p) || typeof p !== 'object' || Object.keys(p).sort().join(',') !== FIELDS.join(',') || p.version !== 2) {
        fail(401, 'a version 2 signed request is required — refresh this page');
      }
      if (!Object.hasOwn(PATHS, action) || p.action !== action || p.path !== PATHS[action] ||
          req.method !== 'POST' || p.method !== req.method || req.url !== p.path ||
          p.address !== body.address || p.audience !== audience || p.network !== network) fail(401, 'signed request context does not match');
      const origin = req.headers.origin;
      if (p.origin !== origin || !validOrigin(origin) ||
          !(origin === audience || (CROSS_ORIGIN_ACTIONS.has(action) && origins.includes(origin)))) fail(403, 'signed request origin is not allowed');
      const time = now();
      if (!Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) || p.issuedAt <= 0 ||
          p.issuedAt > time + SKEW_MS || p.expiresAt <= time || p.expiresAt <= p.issuedAt || p.expiresAt > p.issuedAt + TTL_MS ||
          typeof p.nonce !== 'string' || !new RegExp('^' + p.issuedAt + '\\.[a-f0-9]{64}$').test(p.nonce)) {
        fail(401, 'stale or invalid signed request — check your clock and try again');
      }
      const payload = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'proof'));
      let hash;
      try { hash = crypto.createHash('sha256').update(canonical(payload)).digest('hex'); }
      catch (_) { fail(400, 'invalid signed request data'); }
      if (p.payloadHash !== hash || typeof p.signature !== 'string' || !/^[A-Za-z0-9+/]{87}=$/.test(p.signature)) fail(401, 'signed request data does not match');
      const fields = Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'signature'));
      if (!verifySignature(message(fields), p.signature, body.address)) fail(401, 'this request was not signed by your account key');
      store.consume(body.address, p.nonce, p.issuedAt);
    },
  };
}

module.exports = { createRequestProofVerifier, createNonceStore };
