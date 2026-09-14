/* Shared RPC picker for Koinos. Public API nodes come and go, so never
   trust a single URL: probe the candidate list and use the first one that
   actually answers chain.get_head_info. KOINOS_RPC overrides the list. */
'use strict';

const NETWORKS = {
  harbinger: {
    label: 'Koinos Harbinger testnet',
    testnet: true,
    explorer: 'https://harbinger.koinosblocks.com',
    nativeSymbol: 'tKOIN',
    /* The KOIN token is itself a contract on Koinos; this is the official
       tKOIN contract on Harbinger (docs.koinos.io/developers/testnet). */
    koinContract: '1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju',
    vhpContract: '17n12ktwN79sR6ia9DDgCfmw77EgpbTyBi',
    rpcs: [
      'https://harbinger-api.koinos.io',
      'https://testnet.koinosfoundation.org/jsonrpc',
    ],
    faucets: [
      { url: 'https://discord.koinos.io',
        name: 'Koinos Discord #faucet',
        note: 'Join the official Koinos Discord and type "!faucet <address>" in the #faucet channel — 100 tKOIN per request.' },
      { url: 'https://t.me/KoinosTestnetFaucetBot',
        name: 'Telegram testnet faucet',
        note: 'Message the bot "/faucet <address>" — 100 tKOIN per request, 24h cooldown.' },
    ],
  },
  mainnet: {
    label: 'Koinos',
    testnet: false,
    explorer: 'https://koinosblocks.com',
    nativeSymbol: 'KOIN',
    /* The REAL mainnet KOIN contract (name "Koin", symbol "KOIN",
       8 decimals). The widely-cited 15DJN4a8SgrbGhhGksSBASiSYjGnMU8dGL is
       the RETIRED pre-migration contract — it fails every call. Getting
       this wrong makes every KOIN balance read 0. */
    koinContract: '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK',
    vhpContract: '12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq',
    rpcs: [
      'https://api.koinos.io',
      /* Fallback: koinosblocks' public node. api.koinos.io intermittently
         answers polls with an HTML error page; with two candidates the
         provider rotates instead of failing a user's mint. */
      'https://api.koinosblocks.com',
    ],
    faucets: [],
  },
};

/** Candidate URLs for a network, honouring the KOINOS_RPC override.
    KOINOS_RPC takes one URL or a comma-separated priority list — e.g. your
    own node first, a public API as the safety net:
      KOINOS_RPC=https://rpc.yourdomain.com,https://api.koinos.io */
function rpcCandidates(netName) {
  const net = NETWORKS[netName];
  if (!net) return [];
  const own = String(process.env.KOINOS_RPC || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return own.length ? own : net.rpcs;
}

/** One Koinos JSON-RPC call, with a timeout. */
async function rpc(url, method, params = {}, timeoutMs = 10000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) {
    const { message, data } = body.error;
    let detail;
    try { detail = typeof data === 'string' ? JSON.parse(data) : data; }
    catch (_) { detail = { data }; }
    const error = new Error(detail ? JSON.stringify({ error: message, ...detail }) : message || 'rpc error');
    error.rpcError = true;
    throw error;
  }
  if (body.result === undefined) throw new Error('RPC response has no result');
  return body.result;
}

/* koilib defaults to aborting on the first error. Use bounded, cancellable
   requests and try the remaining nodes for reads. A transaction broadcast
   is never replayed here: a lost response does not mean it was rejected. */
function configureRpcProvider(provider, { timeoutMs = 10000, broadcastTimeoutMs = 25000 } = {}) {
  provider.call = async (method, params) => {
    const start = provider.currentNodeId;
    const read = /^(?:chain|block_store|transaction_store)\.get_/.test(method)
      || method === 'chain.read_contract';
    const attempts = read ? provider.rpcNodes.length : 1;
    let lastError;
    for (let i = 0; i < attempts; i++) {
      const index = (start + i) % provider.rpcNodes.length;
      try {
        const result = await rpc(provider.rpcNodes[index], method, params, read ? timeoutMs : broadcastTimeoutMs);
        provider.currentNodeId = index;
        return result;
      } catch (error) {
        lastError = error;
        // A node may serve the head while its read service is unavailable.
        // Reads can safely try another endpoint, including RPC errors.
        provider.currentNodeId = (index + 1) % provider.rpcNodes.length;
      }
    }
    throw lastError || new Error('No Koinos RPC endpoints configured');
  };
  return provider;
}

/** A node is usable if it serves the chain head. Returns the head height. */
async function probe(url, { timeoutMs = 8000 } = {}) {
  const info = await rpc(url, 'chain.get_head_info', {}, timeoutMs);
  const height = parseInt(info?.head_topology?.height || '0', 10);
  if (!height) throw new Error('no head info');
  return height;
}

/** First endpoint that answers, or throw with every failure listed. */
async function pickRpc(netName, { quiet = false } = {}) {
  return (await pickRpcs(netName, { quiet }))[0];
}

/** ALL candidates ordered for failover: probed-healthy first (original
    priority preserved), then the ones that failed the probe as a last
    resort — a node that was down at boot may be back an hour later, and
    koilib's Provider rotates through whatever list it holds. Throws only
    when nothing answers at all. */
async function pickRpcs(netName, { quiet = false } = {}) {
  const net = NETWORKS[netName];
  if (!net) throw new Error(`Unknown network '${netName}' — use harbinger or mainnet`);
  const candidates = rpcCandidates(netName);
  const results = await Promise.all(candidates.map(async (url) => {
    try { await probe(url); return { url, ok: true }; }
    catch (e) { return { url, ok: false, err: String(e.message || e) }; }
  }));
  const healthy = results.filter(r => r.ok).map(r => r.url);
  const down = results.filter(r => !r.ok);
  if (!healthy.length) {
    throw new Error('No usable Koinos RPC endpoint. Tried:\n'
      + down.map(r => `  ${r.url} — ${r.err}`).join('\n')
      + '\nSet KOINOS_RPC=<url> to use your own (koinos.pro offers free API keys).');
  }
  if (!quiet) {
    console.log(`rpc:      ${healthy.join(', ')}`
      + (down.length ? `  (down: ${down.map(r => r.url).join(', ')})` : ''));
  }
  return healthy.concat(down.map(r => r.url));
}

module.exports = { NETWORKS, rpcCandidates, configureRpcProvider, probe, pickRpc, pickRpcs, rpc };
