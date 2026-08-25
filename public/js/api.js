/* Frontend API client. Every call goes to the gateway server — the
   browser never talks to a Koinos RPC directly; koilib here is only a
   Signer (keygen + signatures). */
'use strict';

const Api = (() => {
  let _config = null;

  async function call(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.body ? 'POST' : 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* fall through */ }
    if (!res.ok || (data && data.error)) {
      throw new Error((data && data.error) || `request failed (${res.status})`);
    }
    return data;
  }

  /* Cache the PROMISE, not just the result: several widgets ask for the
     config during boot, and caching only the resolved value lets them
     all fire their own request before the first one lands. */
  function config() {
    if (!_config) _config = call('/api/config').catch(e => { _config = null; throw e; });
    return _config;
  }

  return {
    config,
    stats: () => call('/api/stats'),
    account: (address) => call('/api/account?address=' + encodeURIComponent(address)),
    gallery: () => call('/api/gallery'),
    collections: (address) => call('/api/collections?address=' + encodeURIComponent(address)),
    mintNft: (body) => call('/api/mint-nft', { body }),
    uploadNft: (body) => call('/api/upload-nft', { body }),
    launchToken: (body) => call('/api/launch-token', { body }),
    listDex: (body) => call('/api/list-dex', { body }),
    auth: (body) => call('/api/auth', { body }),
    prepare: (body) => call('/api/prepare', { body }),
    submit: (body) => call('/api/submit', { body }),
  };
})();
