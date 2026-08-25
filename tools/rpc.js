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
    ],
    faucets: [],
  },
};

/** Candidate URLs for a network, honouring the KOINOS_RPC override. */
function rpcCandidates(netName) {
  const net = NETWORKS[netName];
  if (!net) return [];
  return process.env.KOINOS_RPC ? [process.env.KOINOS_RPC] : net.rpcs;
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
  if (body.error) throw new Error(body.error.message || 'rpc error');
  return body.result;
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
  const net = NETWORKS[netName];
  if (!net) throw new Error(`Unknown network '${netName}' — use harbinger or mainnet`);
  const errors = [];
  for (const url of rpcCandidates(netName)) {
    try {
      await probe(url);
      if (!quiet) console.log(`rpc:      ${url}`);
      return url;
    } catch (e) {
      errors.push(`  ${url} — ${e.message || e}`);
    }
  }
  throw new Error('No usable Koinos RPC endpoint. Tried:\n' + errors.join('\n')
    + '\nSet KOINOS_RPC=<url> to use your own (koinos.pro offers free API keys).');
}

module.exports = { NETWORKS, rpcCandidates, probe, pickRpc, rpc };
