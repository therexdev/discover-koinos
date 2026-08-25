#!/usr/bin/env node
/* ============================================================
   Discover Koinos — the gateway server.

   One zero-dependency Node process (node:http + koilib) that:
     · serves the static gateway from public/
     · pays for every visitor action through Koinos mana sharing
       (the dev wallet co-signs as payer — visitors never pay)
     · mints playground NFTs with no wallet interaction (the server
       signs as the collection contract; the NFT lands in the
       visitor's address)
     · launches real tokens with no wallet interaction (fresh
       contract account per token; the audited launchpad bytecode
       is uploaded and initialized server-side)
     · prepares user transactions (transfers) the browser signs and
       the server co-signs — the co-sign path proves every byte

   With no GATEWAY_DEV_WIF (or no reachable RPC) it boots in DEMO
   mode: every action simulates instantly and is labeled as such,
   so the site can be developed, styled and deployed before the
   chain side is funded.
   ============================================================ */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const chain = require('./tools/koinos');
const { pickRpc, NETWORKS } = require('./tools/rpc');

/* ---------------- configuration ---------------- */

const CFG = {
  port: parseInt(process.env.PORT || '3000', 10),
  network: process.env.KOINOS_NETWORK || 'harbinger',
  devWif: process.env.GATEWAY_DEV_WIF || '',
  collectionAddr: process.env.GATEWAY_COLLECTION_ADDR || '',
  collectionWif: process.env.GATEWAY_COLLECTION_WIF || '',
  /* How many proxy hops stand in front of this server (Hostinger/CDN).
     0 = trust the socket address. Unconditionally trusting
     x-forwarded-for lets anyone spoof past every per-IP limit. */
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS || '0', 10),
  /* Mana guards: refuse expensive actions when the sponsor wallet is
     low rather than letting them fail half-way. */
  minManaLaunch: Number(process.env.MIN_MANA_LAUNCH || 85),
  minManaMint: Number(process.env.MIN_MANA_MINT || 10),
  minManaAction: Number(process.env.MIN_MANA_ACTION || 6),
  /* Per-day ceilings — the sponsor wallet's mana is the real budget,
     these keep one hot day from draining it entirely. */
  maxLaunchesPerDay: parseInt(process.env.MAX_LAUNCHES_PER_DAY || '10', 10),
  maxMintsPerDay: parseInt(process.env.MAX_MINTS_PER_DAY || '200', 10),
  demo: process.env.DEMO_MODE === '1',
};

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const TOKEN_WASM = path.join(__dirname, 'contracts', 'prebuilt', 'token', 'contract.wasm');

let DEMO = CFG.demo;          // may flip on at boot if the chain is unreachable
let BOOT_NOTE = '';

/* ---------------- tiny persistence ----------------
   JSON files in data/, written atomically. The chain is the source of
   truth; these are the gateway's own index of what it launched/minted. */

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file))); }
  catch (_) { return fallback; }
}
function saveJson(file, value, { secret = false } = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const p = path.join(DATA_DIR, file);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: secret ? 0o600 : 0o644 });
  fs.renameSync(tmp, p);
}

const registry = {
  tokens: loadJson('tokens.json', []),      // public: launched tokens
  nfts: loadJson('nfts.json', []),          // public: minted playground NFTs
  counters: loadJson('counters.json', {}),  // per-day action counts
};
/* Token account keys — the upgrade authority for every launched token.
   Owner-only file permissions, never logged, never sent to a browser. */
const tokenKeys = loadJson('token-keys.json', {});
const saveTokens = () => saveJson('tokens.json', registry.tokens);
const saveNfts = () => saveJson('nfts.json', registry.nfts);
const saveCounters = () => saveJson('counters.json', registry.counters);
const saveTokenKeys = () => saveJson('token-keys.json', tokenKeys, { secret: true });

function dayKey() { return new Date().toISOString().slice(0, 10); }
function rollDay() {
  const day = dayKey();
  if (registry.counters.day !== day) {
    registry.counters = { day, launches: 0, mints: 0, seq: registry.counters.seq || 0 };
  }
}
function dailyCount(kind) {
  rollDay();
  return registry.counters[kind] || 0;
}

/* Reserve a daily-budget slot SYNCHRONOUSLY — before any await — so
   concurrent requests can't all read a stale count and sail past the
   ceiling together (a TOCTOU that would drain the sponsor's whole day).
   Returns a release() that refunds the slot if the work then fails. */
function reserveDaily(kind, max) {
  rollDay();
  if ((registry.counters[kind] || 0) >= max) return null;
  registry.counters[kind] = (registry.counters[kind] || 0) + 1;
  saveCounters();
  let released = false;
  return () => {
    if (released) return; released = true;
    rollDay();
    registry.counters[kind] = Math.max(0, (registry.counters[kind] || 0) - 1);
    saveCounters();
  };
}

/* A monotonic, persisted, synchronously-allocated id — two concurrent
   mints can never derive the same DK code (which would collide on-chain
   and desync the registry). */
function nextSeq() {
  rollDay();
  registry.counters.seq = (registry.counters.seq || 0) + 1;
  saveCounters();
  return registry.counters.seq;
}

/* Reserve `cost` KOIN of the sponsor's mana SYNCHRONOUSLY (before the
   balance read), so N expensive actions firing at once can't each read the
   same healthy balance and all proceed, overdrawing the wallet to zero.
   Proceeds only if what remains after OTHER in-flight reservations still
   clears `floor`. Returns release() — call it in a finally. */
let manaReserved = 0;
async function reserveMana(cost, floor, onLow) {
  manaReserved += cost;
  let released = false;
  const release = () => { if (!released) { released = true; manaReserved -= cost; } };
  let live = 0;
  try { live = await chain.mana(chain.devAddress()); } catch (_) { live = 0; }
  if (live - manaReserved + cost < floor) { release(); throw onLow(live); }
  return release;
}
/* Rough mana costs (KOIN) for reservation math; the real charge is metered
   on-chain — these only bound how many actions run at once. */
const COST_MINT = 2, COST_LAUNCH = 50, COST_ACTION = 2;

/* ---------------- rate limiting ---------------- */

const RATE = new Map();  // key -> [timestamps]
const RATE_MAX_KEYS = 50000;
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let arr = RATE.get(key);
  if (!arr) {
    if (RATE.size >= RATE_MAX_KEYS) return true;  // cap the map, fail closed
    arr = []; RATE.set(key, arr);
  }
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  if (arr.length >= max) return true;
  arr.push(now);
  return false;
}
setInterval(() => {  // shed idle keys so the map cannot grow forever
  const cutoff = Date.now() - 24 * 3600000;
  for (const [k, arr] of RATE) if (!arr.length || arr[arr.length - 1] < cutoff) RATE.delete(k);
}, 3600000).unref();

function clientIp(req) {
  if (CFG.trustProxyHops > 0) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const pick = fwd[fwd.length - CFG.trustProxyHops];
    if (pick) return pick;
  }
  return req.socket.remoteAddress || 'unknown';
}

/* ---------------- request proof ----------------
   Free actions land assets in an address; the request must prove it
   CONTROLS that address, or anyone could spend the sponsor's mana
   minting things to strangers. The browser key signs a short message —
   invisible to the visitor, no popups. */

function verifyProof(body, action) {
  const { address, ts, sig } = body || {};
  if (!chain.isAddr(address)) return 'a valid Koinos address is required';
  const t = Number(ts);
  if (!t || Math.abs(Date.now() - t) > 5 * 60000) return 'stale request — check your clock and try again';
  const msg = `discover-koinos:${action}:${t}`;
  if (!chain.verifyAuthSignature(msg, sig, address)) return 'this request was not signed by your account key';
  return null;
}

/* ---------------- prepared-transaction refs ---------------- */

const PREPARED = new Map();  // ref -> { id, address, meta, expires }
function rememberPrepared(id, address, meta) {
  const ref = crypto.randomBytes(16).toString('hex');
  PREPARED.set(ref, { id, address, meta: meta || null, expires: Date.now() + 10 * 60000 });
  if (PREPARED.size > 5000) {
    for (const [k, v] of PREPARED) if (v.expires < Date.now()) PREPARED.delete(k);
  }
  return ref;
}

/* Apply the registry side-effect of a confirmed user transaction — the
   chain moved, so the gateway's own index must follow, or 'Your collection'
   goes stale and a second send of the same NFT sails through prepare only
   to fail cryptically on-chain. */
function applyConfirmed(meta) {
  if (!meta) return;
  if (meta.action === 'nft_transfer') {
    const rec = registry.nfts.find(n => n.tokenId === meta.tokenId && n.owner === meta.from);
    if (rec) { rec.owner = meta.to; saveNfts(); }
  }
}

/* ---------------- pixel art -> SVG ----------------
   The NFT studio sends a 16x16 grid as palette indices. The server
   rebuilds the image itself — nothing client-supplied goes on-chain
   unchecked — and run-length-merges each row so typical drawings fit
   in a few KB of metadata. Index 0 is transparent. */

const GRID = 16;
function pixelsToSvg(palette, cells) {
  if (!Array.isArray(palette) || palette.length < 2 || palette.length > 16) throw new Error('palette must have 2-16 colors');
  for (const c of palette) if (!/^#[0-9a-fA-F]{6}$/.test(String(c))) throw new Error('palette colors must be #rrggbb');
  if (!Array.isArray(cells) || cells.length !== GRID * GRID) throw new Error(`expected ${GRID * GRID} cells`);
  let rects = '';
  for (let y = 0; y < GRID; y++) {
    let x = 0;
    while (x < GRID) {
      const v = cells[y * GRID + x];
      if (!Number.isInteger(v) || v < 0 || v >= palette.length) throw new Error('bad palette index');
      if (v === 0) { x++; continue; }
      let w = 1;
      while (x + w < GRID && cells[y * GRID + x + w] === v) w++;
      rects += `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${palette[v].toLowerCase()}"/>`;
      x += w;
    }
  }
  if (!rects) throw new Error('the canvas is empty — draw something first');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" shape-rendering="crispEdges">${rects}</svg>`;
}

const cleanText = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/* ---------------- demo helpers ---------------- */

const demoTxid = () => '0x1220' + crypto.randomBytes(30).toString('hex');
const demoAddr = () => '1DEMO' + crypto.randomBytes(16).toString('hex').slice(0, 24);

/* ---------------- API ---------------- */

const api = {};

api.config = async () => {
  const net = NETWORKS[CFG.network];
  return {
    ok: true,
    network: CFG.network,
    networkLabel: net.label,
    testnet: !!net.testnet,
    nativeSymbol: net.nativeSymbol,
    explorer: net.explorer,
    demo: DEMO,
    note: BOOT_NOTE || undefined,
    sponsor: DEMO ? null : chain.devAddress(),
    collection: CFG.collectionAddr || null,
    faucets: net.faucets,
    limits: {
      launchesPerDay: CFG.maxLaunchesPerDay,
      mintsPerDay: CFG.maxMintsPerDay,
    },
  };
};

let _statsCache = { at: 0, value: null };
api.stats = async () => {
  if (DEMO) {
    return {
      ok: true, demo: true,
      head: 1234567 + Math.floor(Date.now() / 3000) % 100000,
      koinSupply: 68432109, vhpBurned: 24913877,
      sponsorMana: 92.4,
      launched: registry.tokens.length, minted: registry.nfts.length,
    };
  }
  if (_statsCache.value && Date.now() - _statsCache.at < 30000) return _statsCache.value;
  const [head, sup, sponsorMana] = await Promise.all([
    chain.headInfo(), chain.supplies(), chain.mana(chain.devAddress()),
  ]);
  const value = {
    ok: true,
    head: parseInt(head?.head_topology?.height || '0', 10),
    koinSupply: Math.round(sup.koin), vhpBurned: Math.round(sup.vhp),
    sponsorMana: Math.round(sponsorMana * 10) / 10,
    launched: registry.tokens.length, minted: registry.nfts.length,
  };
  _statsCache = { at: Date.now(), value };
  return value;
};

api.account = async (params) => {
  const address = params.get('address');
  if (!chain.isAddr(address)) throw httpError(400, 'a valid Koinos address is required');
  const mine = {
    nfts: registry.nfts.filter(n => n.owner === address),
    tokens: registry.tokens.filter(t => t.owner === address),
  };
  if (DEMO) {
    return { ok: true, demo: true, koin: 0, mana: 5, ...mine };
  }
  const [koin, mana] = await Promise.all([
    chain.koinBalance(address).catch(() => 0),
    chain.mana(address).catch(() => 0),
  ]);
  /* Balances of the visitor's launched tokens, best-effort. */
  const tokens = [];
  for (const t of mine.tokens.slice(0, 20)) {
    let balance = t.supplyUnits;
    try { balance = await chain.tokenBalanceAt(t.address, address); } catch (_) {}
    tokens.push({ ...t, balance });
  }
  return { ok: true, koin, mana, nfts: mine.nfts, tokens };
};

api.gallery = async () => ({
  ok: true,
  nfts: registry.nfts.slice(-24).reverse(),
  tokens: registry.tokens.slice(-24).reverse(),
});

api.mintNft = async (body, ip) => {
  const err = verifyProof(body, 'mint-nft');
  if (err) throw httpError(400, err);
  const address = body.address;
  const name = cleanText(body.name, 48);
  if (!name) throw httpError(400, 'give your NFT a name');
  if (rateLimited('mint:addr:' + address, 5, 24 * 3600000)) throw httpError(429, 'that account has minted a lot today — come back tomorrow');
  if (rateLimited('mint:ip:' + ip, 10, 24 * 3600000)) throw httpError(429, 'too many mints from this connection today');

  const svg = pixelsToSvg(body.palette, body.cells);
  const image = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const metadata = JSON.stringify({
    name, image,
    description: `Minted first-hand at Discover Koinos by ${address}`,
  });
  if (metadata.length > 8192) throw httpError(400, 'that drawing is too detailed to store on-chain — simplify it a little');

  // Reserve the daily slot + a unique id SYNCHRONOUSLY, before any await.
  const releaseDaily = reserveDaily('mints', CFG.maxMintsPerDay);
  if (!releaseDaily) throw httpError(503, 'the playground hit today’s mint budget — come back tomorrow');
  const code = 'DK' + String(nextSeq()).padStart(5, '0');
  const tokenId = chain.codeToTokenId(code);

  let txid;
  try {
    if (DEMO) {
      txid = demoTxid();
    } else {
      if (!chain.nftEnabled()) throw httpError(503, 'the playground collection is not configured yet');
      const releaseMana = await reserveMana(COST_MINT, CFG.minManaMint,
        () => httpError(503, 'the sponsor wallet is recharging its mana — try again in a few minutes'));
      try { txid = await chain.mintNft(address, tokenId, metadata); }
      finally { releaseMana(); }
    }
  } catch (e) { releaseDaily(); throw e; }
  const rec = { code, tokenId, name, image, owner: address, txid, ts: Date.now(), demo: DEMO || undefined };
  registry.nfts.push(rec); saveNfts();
  return { ok: true, ...rec, explorer: DEMO ? null : explorerTx(txid) };
};

api.launchToken = async (body, ip) => {
  const err = verifyProof(body, 'launch-token');
  if (err) throw httpError(400, err);
  const address = body.address;
  const name = cleanText(body.name, 64);
  const symbol = cleanText(body.symbol, 16).toUpperCase();
  const decimals = Number(body.decimals);
  const mintable = !!body.mintable;
  if (!name) throw httpError(400, 'your token needs a name');
  if (!/^[A-Z0-9]{2,16}$/.test(symbol)) throw httpError(400, 'symbol must be 2-16 letters or digits');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) throw httpError(400, 'decimals must be 0-12');
  const rawSupply = String(body.supply || '0').trim();
  let supplyUnits;
  if ((rawSupply === '' || rawSupply === '0') && mintable) {
    supplyUnits = '0';   // a mintable token may start empty and be minted into
  } else {
    try { supplyUnits = chain.toUnits(rawSupply, decimals); }
    catch (e) { throw httpError(400, `bad supply: ${e.message}`); }
  }

  if (rateLimited('launch:addr:' + address, 2, 24 * 3600000)) throw httpError(429, 'that account already launched tokens today — come back tomorrow');
  if (rateLimited('launch:ip:' + ip, 3, 24 * 3600000)) throw httpError(429, 'too many launches from this connection today');

  // Reserve the daily slot SYNCHRONOUSLY, before any await.
  const releaseDaily = reserveDaily('launches', CFG.maxLaunchesPerDay);
  if (!releaseDaily) throw httpError(503, 'the gateway hit today’s launch budget — come back tomorrow');

  let address2, uploadTx, initTx;
  try {
    if (DEMO) {
      address2 = demoAddr(); uploadTx = demoTxid(); initTx = demoTxid();
    } else {
      if (!chain.enabled()) throw httpError(503, 'the sponsor wallet is not configured yet');
      const releaseMana = await reserveMana(COST_LAUNCH, CFG.minManaLaunch,
        (live) => httpError(503, `the sponsor wallet is recharging its mana (${Math.floor(live)} of ${CFG.minManaLaunch} needed) — a token launch stores real bytecode on-chain. Try again later`));
      try {
        const wasm = fs.readFileSync(TOKEN_WASM);
        const spec = { name, symbol, decimals, initialSupply: supplyUnits, mintable, owner: address };
        /* Mint the token's account key HERE and persist it BEFORE any
           on-chain work: it is the deployed token's sole upgrade authority,
           and if a launch half-completes (upload lands, initialize times
           out) this is the only surviving copy. Never let it ride on a
           thrown Error into the logs. */
        const acct = chain.newAccount();
        tokenKeys[acct.address] = acct.wif; saveTokenKeys();
        const launched = await chain.launchToken(spec, wasm, acct.key);
        address2 = launched.address; uploadTx = launched.uploadTx; initTx = launched.initTx;
      } finally { releaseMana(); }
    }
  } catch (e) { releaseDaily(); throw e; }
  const rec = {
    address: address2, name, symbol, decimals, mintable,
    supplyUnits, supply: chain.fromUnits(supplyUnits, decimals),
    owner: address, txid: initTx || uploadTx, uploadTx, ts: Date.now(), demo: DEMO || undefined,
  };
  registry.tokens.push(rec); saveTokens();
  return {
    ok: true, ...rec,
    explorer: DEMO ? null : explorerAddr(address2),
    explorerTx: DEMO ? null : explorerTx(rec.txid),
  };
};

/* Prepared user transactions: the visitor's OWN assets moving, so the
   visitor signs. The server builds every byte (payer = sponsor). */
api.prepare = async (body, ip) => {
  const err = verifyProof(body, 'prepare');
  if (err) throw httpError(400, err);
  const address = body.address;
  if (rateLimited('prep:addr:' + address, 20, 3600000) || rateLimited('prep:ip:' + ip, 40, 3600000)) {
    throw httpError(429, 'too many transactions — slow down a moment');
  }
  const { action, params = {} } = body;
  const ops = [];
  if (DEMO) {
    const ref = rememberPrepared('demo', address);
    return { ok: true, demo: true, ref, tx: { id: 'demo' } };
  }
  const sponsorMana = await chain.mana(chain.devAddress());
  if (sponsorMana < CFG.minManaAction) throw httpError(503, 'the sponsor wallet is recharging its mana — try again in a few minutes');

  let meta = null;
  if (action === 'nft_transfer') {
    const { tokenId, to } = params;
    if (!chain.isAddr(to)) throw httpError(400, 'a valid destination address is required');
    if (to === address) throw httpError(400, 'that NFT is already yours');
    const rec = registry.nfts.find(n => n.tokenId === tokenId);
    if (!rec) throw httpError(404, 'unknown playground NFT');
    if (rec.owner !== address) throw httpError(403, 'that NFT is not in your wallet');
    ops.push(await chain.opNftTransfer(address, to, tokenId));
    meta = { action, tokenId, from: address, to };
  } else if (action === 'token_transfer') {
    const { token, to, amount } = params;
    const rec = registry.tokens.find(t => t.address === token);
    if (!rec) throw httpError(404, 'unknown gateway token');
    if (!chain.isAddr(to)) throw httpError(400, 'a valid destination address is required');
    if (to === address) throw httpError(400, 'that would send the tokens to yourself');
    const units = chain.toUnits(String(amount || '0'), rec.decimals);
    ops.push(await chain.opTokenTransfer(token, address, to, units));
  } else if (action === 'token_mint') {
    const { token, amount } = params;
    const rec = registry.tokens.find(t => t.address === token);
    if (!rec) throw httpError(404, 'unknown gateway token');
    if (rec.owner !== address) throw httpError(403, 'only the token owner can mint');
    if (!rec.mintable) throw httpError(400, 'this token was launched with a fixed supply');
    const units = chain.toUnits(String(amount || '0'), rec.decimals);
    ops.push(await chain.opTokenMint(token, address, units));
  } else if (action === 'token_burn') {
    const { token, amount } = params;
    const rec = registry.tokens.find(t => t.address === token);
    if (!rec) throw httpError(404, 'unknown gateway token');
    const units = chain.toUnits(String(amount || '0'), rec.decimals);
    ops.push(await chain.opTokenBurn(token, address, units));
  } else {
    throw httpError(400, 'unknown action');
  }

  const tx = await chain.prepareUserTx(address, ops);
  const ref = rememberPrepared(tx.id, address, meta);
  return { ok: true, ref, tx };
};

api.submit = async (body, ip) => {
  const { ref, transaction } = body || {};
  const known = PREPARED.get(String(ref || ''));
  if (!known || known.expires < Date.now()) throw httpError(400, 'this prepared transaction expired — start again');
  PREPARED.delete(String(ref));
  if (rateLimited('submit:ip:' + ip, 40, 3600000)) throw httpError(429, 'too many transactions — slow down a moment');
  if (DEMO) { applyConfirmed(known.meta); return { ok: true, demo: true, txid: demoTxid() }; }
  const txid = await chain.submitCosigned(transaction, known.id, known.address);
  applyConfirmed(known.meta);
  return { ok: true, txid, explorer: explorerTx(txid) };
};

api.health = async () => ({ ok: true, demo: DEMO, network: CFG.network });

function explorerTx(txid) {
  const net = NETWORKS[CFG.network];
  return net.explorer ? `${net.explorer}/tx/${txid}` : null;
}
function explorerAddr(addr) {
  const net = NETWORKS[CFG.network];
  return net.explorer ? `${net.explorer}/address/${addr}` : null;
}

/* ---------------- HTTP plumbing ---------------- */

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* Pretty routes -> files. Everything else is served verbatim from
   public/ (after the traversal check). */
const PAGES = {
  '/': 'index.html',
  '/wallet': 'wallet.html',
  '/nft': 'nft.html',
  '/token': 'token.html',
  '/build': 'build.html',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    const ext = path.extname(file).toLowerCase();
    const isHtml = ext === '.html';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=86400',
      ...(isHtml ? {
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      } : {}),
    });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req, maxBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(httpError(413, 'request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
      catch (_) { reject(httpError(400, 'bad JSON')); }
    });
    req.on('error', reject);
  });
}

const GET_ROUTES = {
  '/api/config': api.config,
  '/api/stats': api.stats,
  '/api/account': api.account,
  '/api/gallery': api.gallery,
  '/api/health': api.health,
};
const POST_ROUTES = {
  '/api/mint-nft': api.mintNft,
  '/api/launch-token': api.launchToken,
  '/api/prepare': api.prepare,
  '/api/submit': api.submit,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      let out;
      if (req.method === 'GET' && GET_ROUTES[pathname]) {
        out = await GET_ROUTES[pathname](url.searchParams);
      } else if (req.method === 'POST' && POST_ROUTES[pathname]) {
        if (rateLimited('api:ip:' + clientIp(req), 240, 60000)) throw httpError(429, 'slow down');
        const body = await readBody(req);
        out = await POST_ROUTES[pathname](body, clientIp(req));
      } else {
        throw httpError(404, 'no such endpoint');
      }
      res.writeHead(200);
      return res.end(JSON.stringify(out));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); return res.end();
    }
    return serveStatic(req, res, pathname);
  } catch (e) {
    const status = e.status || 500;
    /* 503 (budget/mana "come back later") and 429 are expected, not
       faults — log only genuine 500s, and log the message, never the whole
       Error object (which could carry attached context). */
    if (status >= 500 && status !== 503) {
      console.error(`[${new Date().toISOString()}]`, req.method, pathname, '-', String(e && e.message || e).slice(0, 300));
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: String(e.message || e).slice(0, 300) }));
  }
});

/* ---------------- boot ---------------- */

(async () => {
  console.log('Discover Koinos gateway');
  console.log(`network:  ${CFG.network}`);
  if (!CFG.devWif) {
    DEMO = true;
    BOOT_NOTE = 'no sponsor wallet configured';
    console.log('mode:     DEMO (set GATEWAY_DEV_WIF to go live)');
  } else if (!DEMO) {
    try {
      const rpcUrl = await pickRpc(CFG.network);
      chain.configure({
        network: CFG.network, rpcs: [rpcUrl],
        devWif: CFG.devWif,
        collectionAddr: CFG.collectionAddr, collectionWif: CFG.collectionWif,
      });
      const [sponsorMana, sponsorKoin] = await Promise.all([
        chain.mana(chain.devAddress()), chain.koinBalance(chain.devAddress()),
      ]);
      console.log(`sponsor:  ${chain.devAddress()} (${sponsorKoin} ${NETWORKS[CFG.network].nativeSymbol}, ${Math.floor(sponsorMana)} mana)`);
      if (CFG.collectionAddr) {
        try {
          const info = await chain.collectionInfo();
          console.log(`nfts:     ${CFG.collectionAddr} "${info.name || '?'}" (${info.symbol || '?'})`);
        } catch (e) {
          console.log(`nfts:     WARNING — collection at ${CFG.collectionAddr} did not answer get_info: ${e.message}`);
        }
      } else {
        console.log('nfts:     no collection configured — run scripts/deploy-playground.js');
      }
      if (!fs.existsSync(TOKEN_WASM)) {
        console.log('tokens:   WARNING — contracts/prebuilt/token/contract.wasm missing; token launches will fail');
      }
    } catch (e) {
      DEMO = true;
      BOOT_NOTE = 'chain unreachable at boot';
      console.log(`mode:     DEMO — ${e.message}`);
    }
  } else {
    console.log('mode:     DEMO (DEMO_MODE=1)');
  }
  server.listen(CFG.port, () => {
    console.log(`serving:  http://localhost:${CFG.port} ${DEMO ? '(demo mode)' : ''}`);
  });
})();
