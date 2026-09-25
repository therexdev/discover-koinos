/* Request proof v2. Keep the wire format in sync with the Trade client and
   tests/fixtures/request-proof-v2.json. No wallet keys or signatures are logged. */
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RequestProof = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TTL_MS = 5 * 60 * 1000;
  const PATHS = Object.freeze({
    'mint-nft': '/api/mint-nft', 'upload-nft': '/api/upload-nft',
    'launch-token': '/api/launch-token', 'list-dex': '/api/list-dex',
    'launchpad-logo': '/api/launchpad-logo', 'launchpad-profile': '/api/launchpad-profile',
    prepare: '/api/prepare',
  });

  function canonical(value, depth = 0) {
    if (depth > 32) throw new Error('request is too deeply nested');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(v => canonical(v, depth + 1)).join(',') + ']';
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], depth + 1)).join(',') + '}';
    }
    throw new Error('request must contain JSON values');
  }

  function validOrigin(value) {
    try {
      const u = new URL(value);
      return u.origin === value && (u.protocol === 'https:' ||
        (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
    } catch (_) { return false; }
  }

  function message(fields) { return 'discover-koinos:request-proof:v2\n' + canonical(fields); }

  async function create({ action, payload, address, context, audience, network, origin, signMessage }) {
    if (!Object.hasOwn(PATHS, action)) throw new Error('unsupported signed action');
    if (!context || context.version !== 2 || context.audience !== audience || context.network !== network ||
        context.ttlMs !== TTL_MS || !validOrigin(audience) || !validOrigin(origin)) {
      throw new Error('Secure request signing is unavailable. Refresh and try again shortly.');
    }
    if (!payload || Array.isArray(payload) || typeof payload !== 'object' ||
        ['address', 'proof', 'sessionToken', 'ts', 'sig'].some(k => Object.hasOwn(payload, k))) {
      throw new Error('unexpected authentication fields');
    }
    // Snapshot before the first await. UI edits during a wallet prompt cannot
    // change the request whose hash the user signs; undefined follows JSON wire semantics.
    const body = JSON.parse(JSON.stringify({ ...payload, address }));
    const issuedAt = Date.now();
    const random = crypto.getRandomValues(new Uint8Array(32));
    const nonce = issuedAt + '.' + Array.from(random, b => b.toString(16).padStart(2, '0')).join('');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(body)));
    const fields = {
      version: 2, action, method: 'POST', path: PATHS[action], address,
      audience, origin, network, issuedAt, expiresAt: issuedAt + TTL_MS, nonce,
      payloadHash: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''),
    };
    const signature = await signMessage(message(fields));
    return { ...body, proof: { ...fields, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) } };
  }

  return { TTL_MS, PATHS, canonical, validOrigin, message, create };
});
