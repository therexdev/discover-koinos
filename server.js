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
  maxCollectionsPerDay: parseInt(process.env.MAX_COLLECTIONS_PER_DAY || '10', 10),
  demo: process.env.DEMO_MODE === '1',

  /* Social login (custodial). Needs LOGIN_SECRET to custody keys, plus the
     provider credentials. Without LOGIN_SECRET the social buttons stay off
     and only Local Wallet / Import are offered. */
  loginSecret: process.env.LOGIN_SECRET || '',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  xClientId: process.env.X_CLIENT_ID || '',
  xClientSecret: process.env.X_CLIENT_SECRET || '',
  xRedirectUri: process.env.X_REDIRECT_URI || '',
  publicOrigin: process.env.PUBLIC_ORIGIN || '',

  /* OURO marketplace auto-registration (discoverability). Server-to-server;
     no key needed to register, admin key only lifts the rate limit. */
  ouroApiBase: (process.env.OURO_API_BASE || 'https://ouro.lifestyle').replace(/\/+$/, ''),
  ouroAdminKey: process.env.OURO_ADMIN_KEY || '',
  autoListOuro: process.env.AUTO_LIST_OURO !== '0',

  /* Trade Koinos orderbook DEX — mainnet only; no testnet deployment. */
  dexOrderbook: process.env.DEX_ORDERBOOK_ADDR ||
    ((process.env.KOINOS_NETWORK || 'harbinger') === 'mainnet' ? '1Bke72aGbpq4brDY3m1UQxRCGBB9GPTJQz' : ''),

  /* Uploaded NFT images (the "Upload" path). Stored on the gateway, served
     by URL, referenced from on-chain metadata. */
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES || String(3 * 1024 * 1024), 10),
};

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TOKEN_WASM = path.join(__dirname, 'contracts', 'prebuilt', 'token', 'contract.wasm');
const COLLECTION_WASM = path.join(__dirname, 'contracts', 'prebuilt', 'collection', 'contract.wasm');

const { createAuth } = require('./tools/auth');
const xRedirectUri = CFG.xRedirectUri || (CFG.publicOrigin ? CFG.publicOrigin.replace(/\/+$/, '') + '/auth/x/callback' : '');
const auth = createAuth({
  dataDir: DATA_DIR,
  loginSecret: CFG.loginSecret || require('node:crypto').randomBytes(32).toString('hex'),
  // A provider is only enabled when LOGIN_SECRET is set (so custodied keys
  // survive restarts) AND its own credentials are present.
  googleClientId: CFG.loginSecret ? CFG.googleClientId : '',
  xClientId: CFG.loginSecret ? CFG.xClientId : '',
  xClientSecret: CFG.loginSecret ? CFG.xClientSecret : '',
  xRedirectUri: CFG.loginSecret ? xRedirectUri : '',
});

let DEMO = CFG.demo;          // may flip on at boot if the chain is unreachable
let BOOT_NOTE = '';
const PAINT_NAME = 'Discover Koinos Paint';   // the one shared Paint collection

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
  nfts: loadJson('nfts.json', []),          // public: minted NFTs (all collections)
  collections: loadJson('collections.json', []), // public: collections (paint + per-user)
  counters: loadJson('counters.json', {}),  // per-day action counts
};
/* Contract account keys — the upgrade authority + free-mint authority for
   every launched token and collection. Owner-only file permissions, never
   logged, never sent to a browser. */
const tokenKeys = loadJson('token-keys.json', {});
const collectionKeys = loadJson('collection-keys.json', {});
const saveTokens = () => saveJson('tokens.json', registry.tokens);
const saveNfts = () => saveJson('nfts.json', registry.nfts);
const saveCollections = () => saveJson('collections.json', registry.collections);
const saveCounters = () => saveJson('counters.json', registry.counters);
const saveTokenKeys = () => saveJson('token-keys.json', tokenKeys, { secret: true });
const saveCollectionKeys = () => saveJson('collection-keys.json', collectionKeys, { secret: true });

/* ---------------- OURO marketplace registration ----------------
   Discoverability only: a free, unauthenticated POST that adds a KCS-2
   collection to OURO's browse index. Best-effort — a failure never blocks a
   mint; we just record that the collection isn't listed yet and can retry.
   (Server-to-server: OURO's API sets no CORS header, so a browser couldn't
   do this.) Only meaningful on the network OURO runs on (mainnet). */
async function registerOnOuro(rec) {
  if (!CFG.autoListOuro || DEMO) return false;
  if (!NETWORKS[CFG.network] || NETWORKS[CFG.network].testnet) return false; // OURO is mainnet
  try {
    const body = {
      address: rec.address, name: rec.name,
      description: rec.description || `Created at Discover Koinos`,
      image: rec.image || undefined, by: rec.owner || undefined,
    };
    if (CFG.ouroAdminKey) body.key = CFG.ouroAdminKey;
    const r = await fetch(CFG.ouroApiBase + '/api/collections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
    // "already registered" is success from our side.
    if (r.ok) return true;
    const d = await r.json().catch(() => ({}));
    return /already registered/i.test(String(d.error || ''));
  } catch (_) { return false; }
}
const ouroCollectionUrl = (addr) => `${CFG.ouroApiBase}/#/c/${addr}`;

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
const COST_MINT = 2, COST_LAUNCH = 50, COST_COLLECTION = 55, COST_ACTION = 2;

/* ---------------- uploaded image handling ----------------
   Accept only raster images (never SVG — an inline-script SVG served
   same-origin is stored XSS). Sniff the real bytes, cap the size, store
   under data/uploads, and reference by URL from the NFT metadata. */
const IMG_TYPES = {
  '\x89PNG\r\n\x1a\n': { ext: 'png', mime: 'image/png' },
  '\xff\xd8\xff': { ext: 'jpg', mime: 'image/jpeg' },
  'GIF87a': { ext: 'gif', mime: 'image/gif' },
  'GIF89a': { ext: 'gif', mime: 'image/gif' },
};
function sniffImage(buf) {
  const head = buf.slice(0, 16).toString('binary');
  for (const [magic, t] of Object.entries(IMG_TYPES)) if (head.startsWith(magic)) return t;
  // WEBP: "RIFF"...."WEBP"
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}
/** Parse a data: URL image, validate type + size, return { buf, ext, mime }. */
function decodeUploadImage(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw httpError(400, 'send the image as a base64 data URL');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw httpError(400, 'that image is empty');
  if (buf.length > CFG.maxUploadBytes) throw httpError(413, `image too large — max ${Math.round(CFG.maxUploadBytes / 1048576)}MB`);
  const t = sniffImage(buf);
  if (!t) throw httpError(400, 'unsupported image — use PNG, JPEG, GIF or WebP (not SVG)');
  return { buf, ext: t.ext, mime: t.mime };
}
function storeUpload(buf, ext) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const id = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, id), buf);
  return id;
}
function originFor(req) {
  if (CFG.publicOrigin) return CFG.publicOrigin.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['host'] || `localhost:${CFG.port}`;
  return `${proto}://${host}`;
}
const symbolFrom = (name) => (String(name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'DK') ;

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
    paintCollectionName: PAINT_NAME,
    faucets: net.faucets,
    auth: {
      google: auth.googleEnabled(),
      x: auth.xEnabled(),
      googleClientId: auth.googleEnabled() ? CFG.googleClientId : null,
    },
    dex: {
      enabled: DEMO ? true : chain.dexEnabled(),
      name: 'Trade Koinos',
      mainnetOnly: true,
      available: DEMO || (chain.dexEnabled() && !net.testnet),
    },
    ouro: {
      autoList: CFG.autoListOuro && (DEMO || !net.testnet),
      base: CFG.ouroApiBase,
    },
    limits: {
      launchesPerDay: CFG.maxLaunchesPerDay,
      mintsPerDay: CFG.maxMintsPerDay,
      collectionsPerDay: CFG.maxCollectionsPerDay,
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

/** Collections this address can mint into: the shared Paint collection
    plus any the address created via Upload. */
function myCollections(address) {
  return registry.collections
    .filter(c => c.kind === 'paint' || c.owner === address)
    .map(c => ({ address: c.address, name: c.name, symbol: c.symbol, kind: c.kind, ouro: !!c.ouro, ouroUrl: c.ouro ? ouroCollectionUrl(c.address) : null }));
}

api.account = async (params) => {
  const address = params.get('address');
  if (!chain.isAddr(address)) throw httpError(400, 'a valid Koinos address is required');
  const mine = {
    nfts: registry.nfts.filter(n => n.owner === address),
    tokens: registry.tokens.filter(t => t.owner === address),
    collections: myCollections(address).filter(c => c.kind !== 'paint'),
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
  return { ok: true, koin, mana, nfts: mine.nfts, tokens, collections: mine.collections };
};

/** GET /api/collections?address= — the collections this address can mint
    into (Paint + own). Drives the Upload page's collection picker. */
api.collections = async (params) => {
  const address = params.get('address');
  if (!chain.isAddr(address)) throw httpError(400, 'a valid Koinos address is required');
  return { ok: true, collections: myCollections(address) };
};

api.gallery = async () => ({
  ok: true,
  nfts: registry.nfts.slice(-24).reverse(),
  tokens: registry.tokens.slice(-24).reverse(),
  collections: registry.collections.slice(-24).reverse().map(c => ({
    address: c.address, name: c.name, symbol: c.symbol, kind: c.kind,
    ouroUrl: c.ouro ? ouroCollectionUrl(c.address) : null,
  })),
});

/* ---------------- auth (custodial social login) ---------------- */

api.auth = async (body, ip) => {
  const action = String(body.action || '');
  if (rateLimited('auth:ip:' + ip, 30, 3600000)) throw httpError(429, 'too many sign-in attempts — wait a few minutes');
  if (action === 'google') {
    const r = await auth.google(body.idToken);
    return { ok: true, wif: r.wif, address: r.address, created: r.created, label: r.label };
  }
  if (action === 'x-claim') {
    const r = auth.xClaimWif(body.claim);
    return { ok: true, wif: r.wif, address: r.address, label: r.label };
  }
  throw httpError(400, 'unknown action');
};

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
  const rec = { code, tokenId, name, image, collection: CFG.collectionAddr || null, collectionName: PAINT_NAME, owner: address, txid, ts: Date.now(), demo: DEMO || undefined };
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

/* ---------------- NFT: upload → own collection ----------------
   The Upload path: an image + a collection (new or one the address already
   made) + an NFT name. A new collection deploys a fresh KCS-2 contract
   (owner = the visitor), is remembered so they can mint into it again, and
   is auto-registered on OURO. The image is stored on the gateway and
   referenced by URL from the on-chain metadata. */
api.uploadNft = async (body, ip, req) => {
  const err = verifyProof(body, 'upload-nft');
  if (err) throw httpError(400, err);
  const address = body.address;
  const nftName = cleanText(body.name, 48);
  if (!nftName) throw httpError(400, 'give your NFT a name');
  if (rateLimited('upload:addr:' + address, 8, 24 * 3600000)) throw httpError(429, 'that account has uploaded a lot today — come back tomorrow');
  if (rateLimited('upload:ip:' + ip, 15, 24 * 3600000)) throw httpError(429, 'too many uploads from this connection today');

  const { buf, ext, mime } = decodeUploadImage(body.image);

  // Resolve the target collection.
  let coll = null;
  const wantAddr = String(body.collection || '').trim();
  if (wantAddr) {
    coll = registry.collections.find(c => c.address === wantAddr && (c.kind === 'paint' || c.owner === address));
    if (!coll) throw httpError(404, 'that collection is not one you can mint into');
    if (coll.kind === 'paint') throw httpError(400, 'the Paint collection is for painted NFTs — pick or create your own collection for uploads');
  }

  // Reserve the daily mint slot up front (id + budget), before any await.
  const releaseMintDaily = reserveDaily('mints', CFG.maxMintsPerDay);
  if (!releaseMintDaily) throw httpError(503, 'the playground hit today’s mint budget — come back tomorrow');
  const seq = nextSeq();

  let createdCollection = null, releaseColDaily = null;
  try {
    // Create a new collection if none chosen.
    if (!coll) {
      const collName = cleanText(body.collectionName, 64);
      if (!collName) throw httpError(400, 'name your new collection (or pick an existing one)');
      releaseColDaily = reserveDaily('collections', CFG.maxCollectionsPerDay);
      if (!releaseColDaily) throw httpError(503, 'the gateway hit today’s collection budget — come back tomorrow');
      const symbol = symbolFrom(collName);
      if (DEMO) {
        coll = { address: demoAddr(), name: collName, symbol, owner: address, kind: 'user', createdAt: Date.now(), demo: true };
      } else {
        if (!chain.enabled()) throw httpError(503, 'the sponsor wallet is not configured yet');
        const releaseMana = await reserveMana(COST_COLLECTION, CFG.minManaLaunch,
          (live) => httpError(503, `the sponsor wallet is recharging its mana (${Math.floor(live)} of ${CFG.minManaLaunch} needed) — deploying a collection stores real bytecode on-chain. Try again later`));
        try {
          const acct = chain.newAccount();
          collectionKeys[acct.address] = acct.wif; saveCollectionKeys();
          const wasm = fs.readFileSync(COLLECTION_WASM);
          const launched = await chain.launchCollection({ name: collName, symbol, owner: address, description: `A collection created at Discover Koinos by ${address}` }, wasm, acct.key);
          coll = { address: launched.address, name: collName, symbol, owner: address, kind: 'user', createdAt: Date.now(), ouro: false };
        } finally { releaseMana(); }
      }
      registry.collections.push(coll); saveCollections();
      createdCollection = coll;
      releaseColDaily = null;   // the collection deployed; don't refund its slot if the mint then fails
      // Auto-register on OURO (best-effort; never blocks the mint).
      registerOnOuro({ address: coll.address, name: coll.name, owner: address }).then((ok) => {
        if (ok) { coll.ouro = true; saveCollections(); }
      }).catch(() => {});
    }

    // Store the image and mint into the collection.
    const fileId = storeUpload(buf, ext);
    const imageUrl = originFor(req) + '/uploads/' + fileId;
    const code = coll.symbol + '-' + seq;
    const tokenId = chain.codeToTokenId(code);
    const metadata = JSON.stringify({ name: nftName, image: imageUrl, description: `Minted at Discover Koinos by ${address}` });

    let txid;
    if (DEMO || coll.demo) { txid = demoTxid(); }
    else {
      const releaseMana = await reserveMana(COST_MINT, CFG.minManaMint,
        () => httpError(503, 'the sponsor wallet is recharging its mana — try again in a few minutes'));
      try { txid = await chain.mintToCollection(collectionKeys[coll.address], address, tokenId, metadata); }
      finally { releaseMana(); }
    }
    const rec = {
      code, tokenId, name: nftName, image: imageUrl, mime,
      collection: coll.address, collectionName: coll.name,
      owner: address, txid, ts: Date.now(), demo: (DEMO || coll.demo) || undefined,
    };
    registry.nfts.push(rec); saveNfts();
    return {
      ok: true, ...rec,
      explorer: (DEMO || coll.demo) ? null : explorerTx(txid),
      collectionOuroUrl: coll.ouro ? ouroCollectionUrl(coll.address) : null,
      createdCollection: createdCollection ? { address: coll.address, name: coll.name, symbol: coll.symbol } : null,
    };
  } catch (e) {
    releaseMintDaily(); if (releaseColDaily) releaseColDaily();
    throw e;
  }
};

/* ---------------- token: list on Trade Koinos DEX ----------------
   Free (mana only): ensure the TOKEN/KOIN market exists (server creates it,
   permissionless), then hand back a SELL order for the visitor to sign that
   escrows only their own token. Mainnet only. Uses the prepare/submit
   round-trip — the returned ref is redeemed via /api/submit. */
api.listDex = async (body, ip) => {
  const err = verifyProof(body, 'list-dex');
  if (err) throw httpError(400, err);
  const address = body.address;
  const rec = registry.tokens.find(t => t.address === String(body.token || ''));
  if (!rec) throw httpError(404, 'unknown gateway token');
  if (rec.owner !== address) throw httpError(403, 'only the token owner can list it');
  if (rateLimited('dex:addr:' + address, 5, 3600000) || rateLimited('dex:ip:' + ip, 10, 3600000)) {
    throw httpError(429, 'too many listings — slow down a moment');
  }

  let quantityUnits, priceUnits;
  try { quantityUnits = chain.toUnits(String(body.amount || '0'), rec.decimals); }
  catch (e) { throw httpError(400, `bad amount: ${e.message}`); }
  try { priceUnits = chain.toDexPrice(String(body.price || '0'), rec.decimals); }
  catch (e) { throw httpError(400, e.message); }
  // The order must be worth at least one KOIN-satoshi.
  if ((BigInt(quantityUnits) * BigInt(priceUnits)) / 100000000n <= 0n) {
    throw httpError(400, 'that amount × price rounds to zero KOIN — raise one of them');
  }

  if (DEMO) {
    const ref = rememberPrepared('demo', address);
    return { ok: true, demo: true, ref, tx: { id: 'demo' }, dex: 'Trade Koinos' };
  }
  if (!chain.dexEnabled() || NETWORKS[CFG.network].testnet) {
    throw httpError(400, 'Trade Koinos is only deployed on mainnet — token DEX listing is available once you go live on mainnet');
  }
  const releaseMana = await reserveMana(COST_ACTION, CFG.minManaAction,
    () => httpError(503, 'the sponsor wallet is recharging its mana — try again in a few minutes'));
  let marketId;
  try { marketId = await chain.ensureDexMarket(rec.address); }
  finally { releaseMana(); }

  const ops = await chain.opsDexSell(rec.address, address, marketId, priceUnits, quantityUnits);
  const tx = await chain.prepareUserTx(address, ops);
  const ref = rememberPrepared(tx.id, address);
  return { ok: true, ref, tx, marketId, dex: 'Trade Koinos', explorerAddr: explorerAddr(chain.K.dexOrderbook) };
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

/* CSP stays strict; it only widens to Google's sign-in origins when Google
   login is actually configured (its script + button iframe + token calls). */
function buildCsp() {
  const g = auth.googleEnabled() ? ' https://accounts.google.com' : '';
  return [
    "default-src 'self'",
    "script-src 'self'" + g,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com" + g,
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'" + g,
    "frame-src" + (g || " 'none'"),
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}
const CSP = buildCsp();

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

/** Serve an uploaded NFT image from data/uploads with a locked-down
    content type (never as HTML/SVG) so a stored file can't run as script. */
function serveUpload(req, res, pathname) {
  const name = pathname.slice('/uploads/'.length);
  if (!/^[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(name)) { res.writeHead(404); return res.end('not found'); }
  const file = path.join(UPLOAD_DIR, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).slice(1);
    const mime = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
    res.writeHead(200, {
      'Content-Type': mime, 'Content-Length': st.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const GET_ROUTES = {
  '/api/config': api.config,
  '/api/stats': api.stats,
  '/api/account': api.account,
  '/api/collections': api.collections,
  '/api/gallery': api.gallery,
  '/api/health': api.health,
};
const POST_ROUTES = {
  '/api/mint-nft': api.mintNft,
  '/api/launch-token': api.launchToken,
  '/api/upload-nft': api.uploadNft,
  '/api/list-dex': api.listDex,
  '/api/auth': api.auth,
  '/api/prepare': api.prepare,
  '/api/submit': api.submit,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  try {
    // X (Twitter) OAuth redirect endpoints — full-page redirects, not JSON.
    if (pathname === '/auth/x/login') {
      if (rateLimited('xlogin:ip:' + clientIp(req), 20, 3600000)) { res.writeHead(429, { 'Content-Type': 'text/plain' }); return res.end('slow down'); }
      try { res.writeHead(302, { Location: auth.xLoginUrl() }); return res.end(); }
      catch (e) { res.writeHead(e.status || 500, { 'Content-Type': 'text/plain' }); return res.end(String(e.message || e)); }
    }
    if (pathname === '/auth/x/callback') {
      if (rateLimited('xcb:ip:' + clientIp(req), 30, 3600000)) { res.writeHead(429, { 'Content-Type': 'text/plain' }); return res.end('slow down'); }
      try {
        const { claim } = await auth.xCallback(url.searchParams.get('code'), url.searchParams.get('state'));
        res.writeHead(302, { Location: '/wallet?auth=x&claim=' + encodeURIComponent(claim) });
        return res.end();
      } catch (e) {
        res.writeHead(302, { Location: '/wallet?auth=x_error&msg=' + encodeURIComponent(String(e.message || e).slice(0, 120)) });
        return res.end();
      }
    }
    if (pathname.startsWith('/uploads/')) return serveUpload(req, res, pathname);

    if (pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      let out;
      if (req.method === 'GET' && GET_ROUTES[pathname]) {
        out = await GET_ROUTES[pathname](url.searchParams);
      } else if (req.method === 'POST' && POST_ROUTES[pathname]) {
        if (rateLimited('api:ip:' + clientIp(req), 240, 60000)) throw httpError(429, 'slow down');
        // The upload route carries a base64 image; everyone else is tiny.
        const cap = pathname === '/api/upload-nft' ? CFG.maxUploadBytes * 2 + 65536 : 128 * 1024;
        const body = await readBody(req, cap);
        out = await POST_ROUTES[pathname](body, clientIp(req), req);
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
        dexOrderbook: CFG.dexOrderbook,
      });
      const [sponsorMana, sponsorKoin] = await Promise.all([
        chain.mana(chain.devAddress()), chain.koinBalance(chain.devAddress()),
      ]);
      console.log(`sponsor:  ${chain.devAddress()} (${sponsorKoin} ${NETWORKS[CFG.network].nativeSymbol}, ${Math.floor(sponsorMana)} mana)`);
      if (CFG.collectionAddr) {
        try {
          const info = await chain.collectionInfo();
          console.log(`paint:    ${CFG.collectionAddr} "${info.name || '?'}" (${info.symbol || '?'})`);
          registerPaintCollection(info);
        } catch (e) {
          console.log(`paint:    WARNING — collection at ${CFG.collectionAddr} did not answer get_info: ${e.message}`);
        }
      } else {
        console.log('paint:    no Paint collection configured — run scripts/deploy-playground.js');
      }
      console.log(`dex:      ${chain.dexEnabled() ? 'Trade Koinos ' + CFG.dexOrderbook : 'off (mainnet only)'}`);
      if (!fs.existsSync(TOKEN_WASM)) console.log('tokens:   WARNING — contracts/prebuilt/token/contract.wasm missing; token launches will fail');
      if (!fs.existsSync(COLLECTION_WASM)) console.log('upload:   WARNING — contracts/prebuilt/collection/contract.wasm missing; Upload collections will fail');
    } catch (e) {
      DEMO = true;
      BOOT_NOTE = 'chain unreachable at boot';
      console.log(`mode:     DEMO — ${e.message}`);
    }
  } else {
    console.log('mode:     DEMO (DEMO_MODE=1)');
  }
  // Social login readiness.
  if (auth.googleEnabled()) console.log('auth:     Google sign-in ENABLED');
  else if (CFG.googleClientId && !CFG.loginSecret) console.log('auth:     Google client id set but LOGIN_SECRET is unset — Google sign-in stays OFF');
  if (auth.xEnabled()) console.log('auth:     X (Twitter) sign-in ENABLED');
  else if (CFG.xClientId && !CFG.loginSecret) console.log('auth:     X client id set but LOGIN_SECRET is unset — X sign-in stays OFF');
  console.log('auth:     Local Wallet + Import always available');

  server.listen(CFG.port, () => {
    console.log(`serving:  http://localhost:${CFG.port} ${DEMO ? '(demo mode)' : ''}`);
  });
})();

/* Ensure the shared Paint collection is in the registry (kind:'paint') and,
   on mainnet, discoverable on OURO. Idempotent. */
function registerPaintCollection(info) {
  let rec = registry.collections.find(c => c.address === CFG.collectionAddr);
  if (!rec) {
    rec = { address: CFG.collectionAddr, name: info.name || PAINT_NAME, symbol: info.symbol || 'PAINT', owner: null, kind: 'paint', createdAt: Date.now(), ouro: false };
    registry.collections.push(rec); saveCollections();
  }
  if (!rec.ouro) registerOnOuro({ address: rec.address, name: rec.name }).then((ok) => { if (ok) { rec.ouro = true; saveCollections(); } }).catch(() => {});
}
