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
const kaiChat = require('./tools/kai-chat');
const { pickRpcs, NETWORKS } = require('./tools/rpc');
const { nftCardPng } = require('./tools/png');

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

  /* Google sign-in is BRIDGED to Aurvania so the wallet matches the one the
     same Google account has in Aurvania and on OURO. aurvania.quest 403s
     unfamiliar User-Agents, hence the curl-like bridge identity. */
  aurvaniaApi: (process.env.AURVANIA_API || 'https://aurvania.quest').replace(/\/+$/, ''),
  bridgeUa: (process.env.BRIDGE_UA || 'curl/8.5.0 (Discover-Koinos gateway)').trim(),
  // overridable only so the Google verification path is testable offline
  googleTokenInfo: (process.env.GOOGLE_TOKENINFO || 'https://oauth2.googleapis.com/tokeninfo').replace(/\/+$/, ''),

  /* Origins allowed to call the signer endpoints (/api/session, /api/sign)
     cross-origin — the apps that let a Google account sign WITHOUT ever
     receiving the private key. Comma-separated, exact scheme+host[:port], no
     trailing slash. e.g. SIGNER_ORIGINS="https://app.tradekoinos.com".
     Empty ⇒ same-origin only (the gateway's own pages). */
  signerOrigins: (process.env.SIGNER_ORIGINS || '')
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean),
  /* How long a signing session lasts before the app must sign in again. A
     stolen session token can authorize signing only within this window (and
     only through the rate-limited endpoint), so keep it modest. */
  signerSessionTtlMins: Math.max(5, Number(process.env.SIGNER_SESSION_TTL_MINS || 180)),

  /* OURO marketplace auto-registration (discoverability). Server-to-server;
     no key needed to register, admin key only lifts the rate limit. */
  ouroApiBase: (process.env.OURO_API_BASE || 'https://ouro.lifestyle').replace(/\/+$/, ''),
  ouroAdminKey: process.env.OURO_ADMIN_KEY || '',
  autoListOuro: process.env.AUTO_LIST_OURO !== '0',

  /* Trade Koinos orderbook DEX — mainnet only; no testnet deployment. */
  dexOrderbook: process.env.DEX_ORDERBOOK_ADDR ||
    ((process.env.KOINOS_NETWORK || 'harbinger') === 'mainnet' ? '1Bke72aGbpq4brDY3m1UQxRCGBB9GPTJQz' : ''),
  tradeAppUrl: (process.env.TRADE_APP_URL || 'https://app.tradekoinos.com').replace(/\/+$/, ''),

  /* Uploaded NFT images (the "Upload" path). Stored on the gateway, served
     by URL, referenced from on-chain metadata. */
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES || String(3 * 1024 * 1024), 10),

  /* Koinos AI visitor chat. Answered by the Koinos AI NETWORK — volunteer
     machines earning KOIN — never by this box, which only relays. The
     answers come through the owner's OWN Koinos AI app: KAI_API_URL points
     at the app's API on their computer (default port 41100, through
     whatever tunnel or port-forward exposes it) and KAI_API_KEY is an API
     key minted in the app — never a wallet key. The app signs network
     requests itself and its account is billed per AI token. Unset ⇒ the
     chat page says the feature is off and nothing else changes. */
  kaiApiUrl: process.env.KAI_API_URL || '',
  kaiApiKey: process.env.KAI_API_KEY || '',
  kaiChatModel: process.env.KAI_CHAT_MODEL || 'koinos-network',
  maxChatsPerDay: parseInt(process.env.MAX_CHATS_PER_DAY || '400', 10),
};

kaiChat.configure({ url: CFG.kaiApiUrl, key: CFG.kaiApiKey, model: CFG.kaiChatModel });

const PUBLIC_DIR = path.join(__dirname, 'public');
/* DATA_DIR can live OUTSIDE the deploy directory (env DATA_DIR) — a git
   redeploy that wipes the app folder must not wipe minted-NFT records,
   token keys and uploads with it. */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TOKEN_WASM = path.join(__dirname, 'contracts', 'prebuilt', 'token', 'contract.wasm');
const COLLECTION_WASM = path.join(__dirname, 'contracts', 'prebuilt', 'collection', 'contract.wasm');

const { createAuth } = require('./tools/auth');
const xRedirectUri = CFG.xRedirectUri || (CFG.publicOrigin ? CFG.publicOrigin.replace(/\/+$/, '') + '/auth/x/callback' : '');
const auth = createAuth({
  dataDir: DATA_DIR,
  loginSecret: CFG.loginSecret || require('node:crypto').randomBytes(32).toString('hex'),
  googleClientId: CFG.googleClientId,
  aurvaniaApi: CFG.aurvaniaApi,
  bridgeUa: CFG.bridgeUa,
  /* With LOGIN_SECRET this gateway becomes the account home for Google and
     holds the keys itself; without it Google stays bridged to Aurvania and
     nothing is custodied here. The user's address is the same either way —
     the local path adopts the wallet Aurvania already has on first sight
     instead of generating one. Gated on the REAL secret, never the random
     per-boot fallback above, which no stored key could survive. */
  googleLocalCustody: !!CFG.loginSecret,
  googleTokenInfo: CFG.googleTokenInfo,
  // server-side signer session lifetime (see the signer section of auth.js)
  sessionTtlMins: CFG.signerSessionTtlMins,
  /* Bulk import from Aurvania at boot: drop aurvania-logins.json into
     DATA_DIR and set AURVANIA_LOGIN_SECRET, then restart — see tools/auth.js.
     Gated on the real LOGIN_SECRET for the same reason custody is. */
  aurvaniaImportSecret: CFG.loginSecret ? (process.env.AURVANIA_LOGIN_SECRET || '') : '',
  // X is custodied here, so it stays gated on LOGIN_SECRET (encrypted keys
  // must survive restarts) AND its own credentials.
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
/* An individual NFT's page on OURO — OURO reads the token straight off the
   chain, so any minted id in a registered collection resolves. */
const ouroNftUrl = (collAddr, tokenIdHex) => `${CFG.ouroApiBase}/#/t/${collAddr}/${tokenIdHex}`;
/* The token's trading-pair page on the Trade Koinos app. The app resolves
   #/market/<base>_<quote> by contract address (its canonical form). */
const dexPairUrl = (tokenAddr) =>
  `${CFG.tradeAppUrl}/#/market/${tokenAddr}_${(NETWORKS[CFG.network] || {}).koinContract || 'KOIN'}`;
/* Is the shared Paint collection registered on OURO? (set at boot) */
const paintOuroRec = () => registry.collections.find(c => c.kind === 'paint' && c.address === CFG.collectionAddr);

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
/* The gateway's own origin. PUBLIC_ORIGIN is authoritative; without it we
   derive from the request but VALIDATE — an attacker-controlled Host must
   never be reflected verbatim into HTML, a redirect Location, or on-chain
   metadata. Only a bare hostname[:port] and http/https survive, so a forged
   header can neither break out of an attribute nor become a full URL. */
function originFor(req) {
  if (CFG.publicOrigin) return CFG.publicOrigin.replace(/\/+$/, '');
  const rawProto = String((req.headers['x-forwarded-proto'] || 'http')).split(',')[0].trim().toLowerCase();
  const proto = rawProto === 'https' ? 'https' : 'http';
  const rawHost = String(req.headers['host'] || '').split(',')[0].trim();
  const host = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(rawHost) ? rawHost : `localhost:${CFG.port}`;
  return `${proto}://${host}`;
}
/* Absolutize a stored image reference. Uploads are stored as an
   origin-agnostic PATH ("/uploads/…") so they survive a domain change and
   can never be a poisoned absolute URL; paint NFTs store a data: URL. */
const absImage = (image, origin) =>
  (image && image.startsWith('/')) ? origin + image : String(image || '');
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
  if (meta.action === 'dex_listed') {
    const rec = registry.tokens.find(t => t.address === meta.token);
    if (rec) { rec.dex = { amount: meta.amount, price: meta.price, ts: Date.now() }; saveTokens(); }
  }
}

/** An NFT record as the API shows it — without the raw paint grid (kept
    only for rendering raster social cards), plus its page on OURO when its
    collection is registered there (OURO reads tokens off the chain, so any
    minted id in a registered collection resolves). */
function pubNft(n) {
  const { art, ...rest } = n;
  const coll = n.collection && registry.collections.find(c => c.address === n.collection);
  rest.ouroUrl = coll && coll.ouro && !n.demo ? ouroNftUrl(n.collection, n.tokenId) : null;
  return rest;
}

/** A token record as the API shows it — with its outbound links: the
    explorer always, the Trade Koinos pair page once listed on the DEX. */
function pubToken(t) {
  return {
    ...t,
    explorerUrl: t.demo ? null : explorerAddr(t.address),
    dexUrl: t.dex && !t.demo ? dexPairUrl(t.address) : null,
  };
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
      googleClientId: auth.googleEnabled() ? auth.googleClientId() : null,
    },
    dex: {
      enabled: DEMO ? true : chain.dexEnabled(),
      name: 'Trade Koinos',
      mainnetOnly: true,
      available: DEMO || (chain.dexEnabled() && !net.testnet),
      appUrl: CFG.tradeAppUrl,
    },
    ouro: {
      autoList: CFG.autoListOuro && (DEMO || !net.testnet),
      base: CFG.ouroApiBase,
    },
    /* The Paint collection's page on OURO, once registered there. */
    paintOuroUrl: (() => { const p = paintOuroRec(); return p && p.ouro ? ouroCollectionUrl(p.address) : null; })(),
    limits: {
      launchesPerDay: CFG.maxLaunchesPerDay,
      mintsPerDay: CFG.maxMintsPerDay,
      collectionsPerDay: CFG.maxCollectionsPerDay,
    },
    aiChat: { enabled: kaiChat.enabled() },
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
    nfts: registry.nfts.filter(n => n.owner === address).map(pubNft),
    tokens: registry.tokens.filter(t => t.owner === address).map(pubToken),
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
  nfts: registry.nfts.slice(-24).reverse().map(pubNft),
  tokens: registry.tokens.slice(-24).reverse().map(pubToken),
  collections: registry.collections.filter(c => c.kind !== 'paint').slice(-24).reverse().map(c => ({
    address: c.address, name: c.name, symbol: c.symbol, kind: c.kind, ts: c.createdAt,
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

/* ---------------- server-side signer ----------------
   The wallet key never leaves the server: /api/session hands the app a
   short-lived session token instead of a WIF, and /api/sign signs a prepared
   transaction with the held key. Both are callable cross-origin from the app
   origins in SIGNER_ORIGINS (see the CORS block in the request handler). */

/* Minimal public config for a signer app (e.g. app.tradekoinos.com) that has
   no server of its own: just what it needs to draw the Google button and mint
   an id token this server will accept. CORS-allowed for SIGNER_ORIGINS. */
api.signerConfig = async () => ({
  ok: true,
  signer: auth.signerEnabled(),
  google: auth.signerEnabled(),
  googleClientId: auth.signerEnabled() ? auth.googleClientId() : null,
  sessionTtlMins: CFG.signerSessionTtlMins,
});

api.session = async (body, ip) => {
  if (rateLimited('session:ip:' + ip, 30, 3600000)) throw httpError(429, 'too many sign-in attempts — wait a few minutes');
  const r = await auth.googleSession(body.idToken);
  return { ok: true, token: r.token, address: r.address, label: r.label, expiresInMs: r.expiresInMs };
};

api.sign = async (body, ip) => {
  // signing is a normal in-session action, so a looser per-IP cap than login
  if (rateLimited('sign:ip:' + ip, 120, 60000)) throw httpError(429, 'signing too fast — slow down');
  const r = await auth.signWithToken(body.token, body.transaction);
  return { ok: true, address: r.address, id: r.id, signatures: r.signatures };
};

api.mintNft = async (body, ip, req) => {
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
  const rec = {
    code, tokenId, name, image, collection: CFG.collectionAddr || null, collectionName: PAINT_NAME,
    owner: address, txid, ts: Date.now(), demo: DEMO || undefined,
    /* the raw grid, kept so /og/nft/<code>.png can render a raster social
       card (X/Telegram won't unfurl SVG). Stripped from API payloads. */
    art: { palette: body.palette, cells: body.cells },
  };
  registry.nfts.push(rec); saveNfts();
  return { ok: true, ...pubNft(rec), explorer: DEMO ? null : explorerTx(txid), shareUrl: originFor(req) + '/n/' + rec.code };
};

api.launchToken = async (body, ip, req) => {
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

  /* Optional coin logo — validated + stored on the gateway, shown on the
     token's page and its share card. Off-chain by design: KCS-4 has no
     logo field, so the image lives with the gateway like NFT uploads do. */
  let imagePath = null;
  if (body.logo) {
    const img = decodeUploadImage(body.logo);
    imagePath = '/uploads/' + storeUpload(img.buf, img.ext);
  }

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
        /* The spec rides along with the key: if the launch dies between
           upload and initialize (an RPC blackout), the boot reconciler can
           FINISH it instead of stranding a paid-for contract. */
        tokenKeys[acct.address] = { wif: acct.wif, spec, ts: Date.now() }; saveTokenKeys();
        const launched = await chain.launchToken(spec, wasm, acct.key);
        address2 = launched.address; uploadTx = launched.uploadTx; initTx = launched.initTx;
      } finally { releaseMana(); }
    }
  } catch (e) { releaseDaily(); throw e; }
  const rec = {
    address: address2, name, symbol, decimals, mintable,
    supplyUnits, supply: chain.fromUnits(supplyUnits, decimals),
    owner: address, txid: initTx || uploadTx, uploadTx, ts: Date.now(), demo: DEMO || undefined,
    image: imagePath || undefined,   // origin-agnostic path, absolutized at render
  };
  registry.tokens.push(rec); saveTokens();
  return {
    ok: true, ...pubToken(rec),
    explorer: DEMO ? null : explorerAddr(address2),
    explorerTx: DEMO ? null : explorerTx(rec.txid),
    shareUrl: originFor(req) + '/t/' + address2,
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

  /* One image or a batch of up to 10. A batch gets NAME #1 … NAME #N. */
  const rawImages = Array.isArray(body.images) ? body.images : (body.image ? [body.image] : []);
  if (!rawImages.length) throw httpError(400, 'choose at least one image');
  if (rawImages.length > 10) throw httpError(400, 'up to 10 images per mint');

  if (rateLimited('upload:addr:' + address, 8, 24 * 3600000)) throw httpError(429, 'that account has uploaded a lot today — come back tomorrow');
  // (per-IP upload cap is enforced in the dispatcher, before the body read)

  // Validate EVERY image before touching budgets or the chain.
  const images = rawImages.map((d) => decodeUploadImage(d));

  // Resolve the target collection.
  let coll = null;
  const wantAddr = String(body.collection || '').trim();
  if (wantAddr) {
    coll = registry.collections.find(c => c.address === wantAddr && (c.kind === 'paint' || c.owner === address));
    if (!coll) throw httpError(404, 'that collection is not one you can mint into');
    if (coll.kind === 'paint') throw httpError(400, 'the Paint collection is for painted NFTs — pick or create your own collection for uploads');
  }

  // Reserve one daily mint slot PER IMAGE up front, before any await.
  const releases = [];
  for (let i = 0; i < images.length; i++) {
    const r = reserveDaily('mints', CFG.maxMintsPerDay);
    if (!r) {
      releases.forEach(x => x());
      throw httpError(503, images.length > 1
        ? 'not enough of today’s mint budget left for that many — try fewer, or come back tomorrow'
        : 'the playground hit today’s mint budget — come back tomorrow');
    }
    releases.push(r);
  }
  const releaseMintDaily = () => releases.forEach(x => x());
  const seqs = images.map(() => nextSeq());

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

    // Store every image, build every mint, then mint the whole batch in
    // ONE transaction — ten NFTs is one broadcast and one wait. The image
    // is kept as an origin-agnostic PATH; only the on-chain metadata needs
    // an absolute URL, which uses the gateway's OWN (validated) origin so a
    // forged Host can never be baked into the immutable record.
    const origin = originFor(req);
    const metaOrigin = CFG.publicOrigin ? CFG.publicOrigin.replace(/\/+$/, '') : origin;
    const items = images.map((img, i) => {
      const fileId = storeUpload(img.buf, img.ext);
      const imagePath = '/uploads/' + fileId;
      const name = images.length > 1 ? `${nftName} #${i + 1}` : nftName;
      const code = coll.symbol + '-' + seqs[i];
      const metadata = JSON.stringify({ name, image: metaOrigin + imagePath, description: `Minted at Discover Koinos by ${address}` });
      if (metadata.length > 8192) throw httpError(400, 'that name is too long to store on-chain');
      return { code, tokenId: chain.codeToTokenId(code), name, imagePath, mime: img.mime, metadata };
    });

    let txid;
    if (DEMO || coll.demo) { txid = demoTxid(); }
    else {
      const releaseMana = await reserveMana(COST_MINT * items.length, CFG.minManaMint,
        () => httpError(503, 'the sponsor wallet is recharging its mana — try again in a few minutes'));
      try {
        txid = await chain.mintManyToCollection(collectionKeys[coll.address], address,
          items.map(it => ({ tokenId: it.tokenId, metadata: it.metadata })));
      } finally { releaseMana(); }
    }

    const isDemo = (DEMO || coll.demo) || undefined;
    const recs = items.map(it => ({
      code: it.code, tokenId: it.tokenId, name: it.name, image: it.imagePath, mime: it.mime,
      collection: coll.address, collectionName: coll.name,
      owner: address, txid, ts: Date.now(), demo: isDemo,
    }));
    registry.nfts.push(...recs); saveNfts();
    const first = recs[0];
    return {
      ok: true, ...pubNft(first),
      count: recs.length,
      minted: recs.map(r => ({
        code: r.code, name: r.name, image: r.image, shareUrl: origin + '/n/' + r.code,
        ouroUrl: coll.ouro && !isDemo ? ouroNftUrl(coll.address, r.tokenId) : null,
      })),
      explorer: isDemo ? null : explorerTx(txid),
      collectionOuroUrl: coll.ouro ? ouroCollectionUrl(coll.address) : null,
      createdCollection: createdCollection ? { address: coll.address, name: coll.name, symbol: coll.symbol } : null,
      shareUrl: origin + '/n/' + first.code,
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
api.listDex = async (body, ip, req) => {
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

  const dexMeta = {
    action: 'dex_listed', token: rec.address,
    amount: String(body.amount), price: String(body.price),
  };
  const shareUrl = originFor(req) + '/t/' + rec.address;
  if (DEMO) {
    const ref = rememberPrepared('demo', address, dexMeta);
    return { ok: true, demo: true, ref, tx: { id: 'demo' }, dex: 'Trade Koinos', shareUrl };
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
  const ref = rememberPrepared(tx.id, address, dexMeta);
  return {
    ok: true, ref, tx, marketId, dex: 'Trade Koinos',
    explorerAddr: explorerAddr(chain.K.dexOrderbook),
    dexUrl: dexPairUrl(rec.address),   // the pair's page on the Trade Koinos app
    shareUrl,
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

/* ---------------- public share pages ----------------
   The viral loop: someone posts their NFT/token link, the link UNFURLS
   with the actual artwork (OG tags + a raster card), and the page that
   opens exists to convert the friend: "made free, no wallet, no fees —
   make yours". Server-rendered, everything user-authored escaped. */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sharePageShell({ origin, path, title, desc, ogImage, bodyHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Discover Koinos">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:url" content="${esc(origin + path)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(ogImage)}">
<link rel="icon" href="/assets/brand/Koinos-Icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Plus+Jakarta+Sans:wght@700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/site.css">
</head>
<body>
<header class="site-header"><div class="wrap">
  <a class="logo" href="/"><img src="/assets/brand/koinos-logomark-white.svg" alt="Koinos"><span>Discover <span class="logo-sub">Koinos</span></span></a>
</div></header>
<main class="wrap section" style="max-width:760px">${bodyHtml}</main>
<footer class="site-footer"><div class="wrap">
  <img src="/assets/brand/koinos-logo-white.svg" alt="Koinos">
  <nav class="foot-links"><a href="/">Discover Koinos</a><a href="https://koinos.io" target="_blank" rel="noopener">koinos.io</a></nav>
</div></footer>
</body></html>`;
}

function sendShareHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(stampAssets(html));   // share pages link site.css too — same cache-bust
}

function sharePageNft(req, res, code) {
  const rec = registry.nfts.find(n => n.code === code);
  if (!rec) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no such NFT'); }
  const origin = originFor(req);
  const ogImage = rec.art
    ? `${origin}/og/nft/${encodeURIComponent(rec.code)}.png`
    : (rec.image && rec.image.startsWith('/') ? origin + rec.image : `${origin}/assets/og-card.png`);
  const title = `"${rec.name}" — minted free on Koinos${rec.demo ? ' (demo)' : ''}`;
  const desc = rec.demo
    ? 'A demo of Discover Koinos — mint a real NFT in a browser with no wallet, no gas and no signup. Try it free.'
    : 'Made in a browser with no wallet setup, no gas fees and no technical experience — a real on-chain NFT. Make yours in under a minute, free.';
  const body = `
    <div style="text-align:center">
      <img src="${esc(absImage(rec.image, origin))}" alt="${esc(rec.name)}" style="width:min(380px,80vw);aspect-ratio:1;image-rendering:pixelated;border-radius:14px;border:1px solid var(--line-strong);background:var(--bg-inset)">
      <h1 style="margin-top:22px">${esc(rec.name)}</h1>
      <p class="sub" style="color:var(--text-dim)">
        A real on-chain NFT in <strong>${esc(rec.collectionName || 'a Koinos collection')}</strong>,
        minted by <code>${esc(UIshort(rec.owner))}</code> — with <strong>no wallet setup, no gas fees, no signup</strong>.
        ${rec.demo ? '<br><em>(demo — this instance is not chain-connected yet)</em>' : ''}
      </p>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:26px">
        <a class="btn big" href="/nft">Make yours — it&#39;s free</a>
        <a class="btn big ghost" href="/">How is this free?</a>
      </div>
      ${comparisonHtml('This NFT was minted in a browser by someone with an <strong>empty wallet</strong> — no gas, no signup, no extension.')}
      ${extLinksHtml([
        (() => { const c = rec.collection && registry.collections.find(x => x.address === rec.collection); return c && c.ouro && !rec.demo && `<a href="${esc(ouroNftUrl(rec.collection, rec.tokenId))}" target="_blank" rel="noopener">this NFT on the OURO marketplace ↗</a>`; })(),
        rec.txid && !rec.demo && explorerTx(rec.txid) && `<a href="${esc(explorerTx(rec.txid))}" target="_blank" rel="noopener">verify it on KoinosBlocks ↗</a>`,
      ])}
    </div>`;
  sendShareHtml(res, sharePageShell({ origin, path: '/n/' + rec.code, title, desc, ogImage, bodyHtml: body }));
}

function sharePageToken(req, res, addr) {
  const rec = registry.tokens.find(t => t.address === addr);
  if (!rec) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no such token'); }
  const origin = originFor(req);
  const title = `$${rec.symbol} — a token launched free on Koinos${rec.demo ? ' (demo)' : ''}`;
  const desc = rec.demo
    ? `A demo of Discover Koinos — launch a real KCS-4 token in one click, no wallet, no fees, no signup. Try it free.`
    : `"${rec.name}" ($${rec.symbol}) — a real KCS-4 token contract, deployed from a browser with no wallet, no fees and no technical experience. Launch yours in one click, free.`;
  const logo = rec.image
    ? `<img src="${esc(absImage(rec.image, origin))}" alt="$${esc(rec.symbol)} logo" class="tok-hero-logo">`
    : `<div class="tok-hero-logo tok-hero-mono" aria-hidden="true">${esc(String(rec.symbol).slice(0, 4))}</div>`;
  const launched = rec.ts ? new Date(rec.ts).toISOString().slice(0, 10) : null;
  const body = `
    <div style="text-align:center">
      ${logo}
      <div style="font-family:var(--font-head);font-weight:800;font-size:clamp(2.2rem,8vw,3.6rem);color:var(--accent-soft);letter-spacing:-.02em;margin-top:14px">$${esc(rec.symbol)}</div>
      <h1 style="margin-top:2px;font-size:clamp(1.5rem,4vw,2.2rem)">${esc(rec.name)}</h1>
      <p class="sub" style="color:var(--text-dim)">
        A real KCS-4 token contract on Koinos, launched by <code>${esc(UIshort(rec.owner))}</code>
        in one click, with <strong>no wallet setup, no gas fees, no signup</strong>.
        ${rec.demo ? '<br><em>(demo — this instance is not chain-connected yet)</em>' : ''}
      </p>
      ${rec.dex ? `<p><span class="badge-ouro">📈 live on Trade Koinos with a KOIN pair</span></p>` : ''}
      <dl class="tok-facts">
        <div><dt>Token</dt><dd>${esc(rec.name)} ($${esc(rec.symbol)})</dd></div>
        <div><dt>Contract ID</dt><dd class="mono-wrap">${esc(rec.address)}</dd></div>
        <div><dt>Supply</dt><dd>${esc(rec.supply)}${rec.mintable ? ' · mintable' : ' · fixed forever'}</dd></div>
        <div><dt>Decimals</dt><dd>${esc(String(rec.decimals))}</dd></div>
        <div><dt>Owner</dt><dd class="mono-wrap">${esc(rec.owner || '—')}</dd></div>
        ${launched ? `<div><dt>Launched</dt><dd>${esc(launched)} · free, at Discover Koinos</dd></div>` : ''}
      </dl>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:26px">
        <a class="btn big" href="/token">Launch yours — it&#39;s free</a>
        <a class="btn big ghost" href="/">How is this free?</a>
      </div>
      ${comparisonHtml('This is a real token contract, deployed free by someone with an <strong>empty wallet</strong> — no gas, no native coin bought first.')}
      ${extLinksHtml([
        !rec.demo && explorerAddr(rec.address) && `<a href="${esc(explorerAddr(rec.address))}" target="_blank" rel="noopener">the contract on KoinosBlocks ↗</a>`,
        rec.dex && !rec.demo && `<a href="${esc(dexPairUrl(rec.address))}" target="_blank" rel="noopener">trade the $${esc(rec.symbol)}/KOIN pair on Trade Koinos ↗</a>`,
        !rec.demo && rec.txid && `<a href="${esc(explorerTx(rec.txid))}" target="_blank" rel="noopener">the launch transaction ↗</a>`,
      ])}
    </div>`;
  sendShareHtml(res, sharePageShell({
    origin, path: '/t/' + rec.address, title, desc,
    ogImage: rec.image ? absImage(rec.image, origin) : `${origin}/assets/og-card.png`,
    bodyHtml: body,
  }));
}

const UIshort = (a) => (a ? String(a).slice(0, 6) + '…' + String(a).slice(-4) : '');

/* The bottom links strip on share pages — rendered only when at least one
   link survives its condition, so demo pages never show a stray divider. */
function extLinksHtml(links) {
  const real = links.filter(Boolean);
  return real.length ? `<div class="ext-links">${real.join('')}</div>` : '';
}

/* The FOMO chart — "that wasn't magic, it's architecture". What this page's
   action would have cost anywhere else. Shared by the NFT and token share
   pages; public/build.html carries the same chart statically. */
function comparisonHtml(claim) {
  return `
    <div class="vs-card">
      <h2>That wasn't magic — it's architecture</h2>
      <p class="sub">${claim} Try that anywhere else:</p>
      <ul class="vs-list">
        <li class="no"><span class="mark">❌</span><div class="who"><strong>Ethereum</strong><span class="why">buy ETH before you can touch anything — every click burns gas, and it's gone</span></div></li>
        <li class="no"><span class="mark">❌</span><div class="who"><strong>Solana</strong><span class="why">hold SOL for fees and rent before your first transaction</span></div></li>
        <li class="no"><span class="mark">❌</span><div class="who"><strong>Base · BNB · Polygon…</strong><span class="why">cheaper gas is still gas — someone has to buy it first</span></div></li>
        <li class="yes"><span class="mark">✅</span><div class="who"><strong>Koinos</strong><span class="why">mana recharges like energy and apps can share theirs — a newcomer's first transaction costs nobody anything, ever</span></div></li>
      </ul>
      <p class="vs-punch">Holding tokens on chains that charge you to use them? Now you know what you're missing. <a href="/">Feel it yourself — free →</a></p>
    </div>`;
}

/* Raster social card for a painted NFT — rendered once, cached. */
const OG_CACHE = new Map();
function serveNftOg(req, res, code) {
  const rec = registry.nfts.find(n => n.code === code);
  if (!rec) { res.writeHead(404); return res.end(); }
  if (!rec.art) {
    /* Uploaded NFT: the stored raster is the card. Redirect ONLY to our own
       /uploads path — never forward to an arbitrary stored URL (that would
       make this trusted endpoint an open redirect). */
    const loc = (rec.image && rec.image.startsWith('/uploads/'))
      ? originFor(req) + rec.image
      : originFor(req) + '/assets/og-card.png';
    res.writeHead(302, { Location: loc });
    return res.end();
  }
  let png = OG_CACHE.get(code);
  if (!png) {
    try { png = nftCardPng(rec.art.palette, rec.art.cells); }
    catch (_) { res.writeHead(500); return res.end(); }
    // Evict the oldest entry rather than flushing the whole cache.
    if (OG_CACHE.size >= 500) OG_CACHE.delete(OG_CACHE.keys().next().value);
    OG_CACHE.set(code, png);
  }
  res.writeHead(200, {
    'Content-Type': 'image/png', 'Content-Length': png.length,
    'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
  });
  res.end(png);
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
  '/ai': 'ai.html',
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
    /* Code assets (css/js) must never outlive a deploy: a phone holding
       yesterday's site.css against today's ui.js renders a broken hybrid
       (that is exactly how Google's raw sign-in iframe ended up visible
       inside the styled button). They revalidate on every load — cheap 304s
       when unchanged — while images/fonts keep a day of cache. */
    const isCode = ext === '.css' || ext === '.js' || ext === '.mjs';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': (isHtml || isCode) ? 'no-cache' : 'public, max-age=86400',
      ...(isHtml ? {
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      } : {}),
    };
    if (isHtml) {
      /* Static pages carry OG tags whose URLs must be ABSOLUTE — inject the
         request origin into the %%ORIGIN%% placeholders at serve time. Local
         css/js URLs get a version stamp so caches that predate the no-cache
         policy (or any CDN in front) are busted the moment the HTML updates. */
      fs.readFile(file, 'utf8', (rerr, text) => {
        if (rerr) { res.writeHead(500); return res.end(); }
        const body = Buffer.from(stampAssets(text.replace(/%%ORIGIN%%/g, originFor(req))));
        res.writeHead(200, { ...headers, 'Content-Length': body.length });
        res.end(body);
      });
      return;
    }
    /* Conditional GET: the no-cache policy means every page load revalidates
       code assets — answer the common case with an empty 304. */
    const lastMod = st.mtime.toUTCString();
    headers['Last-Modified'] = lastMod;
    if (req.headers['if-modified-since'] === lastMod) {
      res.writeHead(304, headers); return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

/* One stamp per server start — appended as ?v= to every local css/js URL in
   served HTML. Restart (= every deploy) → new URLs → no stale hybrid pages. */
const ASSET_V = Date.now().toString(36);
const stampAssets = (html) =>
  html.replace(/(["'])(\/(?:css|js)\/[^"'?#]+\.(?:css|js))\1/g, (_, q, p) => q + p + '?v=' + ASSET_V + q);

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

/* POST /api/ai-chat {question, history?} → SSE. The visitor's question is
   relayed to the owner's own Koinos AI app, which answers through the
   network and gets billed per AI token — so spending controls live HERE,
   before the relay: per-IP pacing, a per-IP daily cap, and a site-wide
   daily budget on the same reserveDaily used for mints — reserved
   synchronously so a burst can't sail past the ceiling together, refunded
   when no answer was generated. The system prompt and history bounds are
   kai-chat.js's job. */
async function handleAiChat(req, res) {
  if (!kaiChat.enabled()) throw httpError(503, 'AI chat is not switched on for this server');
  const ip = clientIp(req);
  if (rateLimited('aichat:ip:' + ip, 6, 60000)) throw httpError(429, 'one question at a time — give it a few seconds');
  if (rateLimited('aichat:ipday:' + ip, 60, 24 * 3600000)) throw httpError(429, 'that is a lot of questions for one connection today — come back tomorrow');
  const release = reserveDaily('aiChats', CFG.maxChatsPerDay);
  if (!release) throw httpError(503, "today's AI budget for this site is used up — it resets at midnight UTC");

  let spent = false; // tokens were bought: the daily slot stays consumed
  try {
    const body = await readBody(req, 32 * 1024);
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) throw httpError(400, 'ask something');

    const messages = kaiChat.buildMessages(question, body.history);
    let upstream;
    try {
      upstream = await kaiChat.requestChat(messages);
    } catch (e) {
      /* The upstream is one real computer running Koinos AI. Unreachable
         means it is off or the tunnel is down — say so honestly. */
      console.error(`[${new Date().toISOString()}] ai-chat: app unreachable -`, String(e.message || e).slice(0, 200));
      throw httpError(503, 'the Koinos AI node this chat runs on is offline right now — try again later');
    }
    if (!upstream.ok) {
      /* The app's own messages can name keys, balances and accounts — log
         them for the operator, hand the visitor something they can act on.
         401/403 is a bad or missing API key (operator's problem, not the
         visitor's). */
      const uj = await upstream.json().catch(() => null);
      const detail = uj?.error?.message || `HTTP ${upstream.status}`;
      console.error(`[${new Date().toISOString()}] ai-chat: app refused -`, String(detail).slice(0, 300));
      if (upstream.status === 401 || upstream.status === 403) throw httpError(503, 'the chat is misconfigured on this site — the operator has been notified in the logs');
      if (upstream.status === 402) throw httpError(503, "the site's AI allowance for today ran out — try again later");
      throw httpError(502, 'the Koinos AI network could not take that question — try again in a moment');
    }

    spent = true; // a provider is generating from here on
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    /* Relay the app's SSE frames untouched (OpenAI-style
       chat.completion.chunk lines ending in "data: [DONE]") — the page
       understands them directly. Cancel upstream if the visitor leaves:
       generation stops and the app's account stops paying for words nobody
       will read. */
    const reader = upstream.body.getReader();
    let gone = false;
    res.on('close', () => { gone = true; reader.cancel().catch(() => {}); });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || gone) break;
        res.write(Buffer.from(value));
      }
    } catch (e) {
      if (!gone) console.error(`[${new Date().toISOString()}] ai-chat: stream broke -`, String(e.message || e).slice(0, 200));
    }
    return res.end();
  } finally {
    if (!spent) release();
  }
}

const GET_ROUTES = {
  '/api/config': api.config,
  '/api/signer-config': api.signerConfig,
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
  '/api/session': api.session,
  '/api/sign': api.sign,
  '/api/prepare': api.prepare,
  '/api/submit': api.submit,
};

/* The signer endpoints are meant to be called from other origins (the apps
   that sign through this server). Everything else stays same-origin. Only an
   origin explicitly listed in SIGNER_ORIGINS is ever reflected, and only for
   /api/session and /api/sign. */
const SIGNER_CORS_PATHS = new Set(['/api/session', '/api/sign', '/api/signer-config']);
function applySignerCors(req, res, pathname) {
  const origin = req.headers.origin;
  if (!origin || !SIGNER_CORS_PATHS.has(pathname)) return;
  if (!CFG.signerOrigins.includes(origin.replace(/\/+$/, ''))) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  try {
    applySignerCors(req, res, pathname);
    if (req.method === 'OPTIONS' && SIGNER_CORS_PATHS.has(pathname)) {
      // preflight: headers already set above (or withheld for a disallowed origin)
      res.writeHead(res.getHeader('Access-Control-Allow-Origin') ? 204 : 403);
      return res.end();
    }
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

    // Public share pages + their raster social cards.
    let m;
    if ((m = /^\/n\/([A-Z0-9-]{1,40})$/.exec(pathname))) return sharePageNft(req, res, m[1]);
    /* Loose shape on purpose: demo-mode addresses aren't strict base58,
       and the registry lookup inside is the real gate. */
    if ((m = /^\/t\/([A-Za-z0-9]{20,40})$/.exec(pathname))) return sharePageToken(req, res, m[1]);
    if ((m = /^\/og\/nft\/([A-Z0-9-]{1,40})\.png$/.exec(pathname))) return serveNftOg(req, res, m[1]);

    /* Streams, so it cannot go through the JSON route table below. Errors
       thrown before the stream starts still land in the outer catch and
       come back as ordinary JSON errors — awaited, because a rejected
       promise merely RETURNED from inside a try block skips its catch. */
    if (pathname === '/api/ai-chat' && req.method === 'POST') return await handleAiChat(req, res);

    if (pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      let out;
      if (req.method === 'GET' && GET_ROUTES[pathname]) {
        out = await GET_ROUTES[pathname](url.searchParams);
      } else if (req.method === 'POST' && POST_ROUTES[pathname]) {
        if (rateLimited('api:ip:' + clientIp(req), 240, 60000)) throw httpError(429, 'slow down');
        // Everyone is tiny EXCEPT the upload route (up to 10 base64 images).
        // Gate the big read behind the per-IP daily upload cap BEFORE
        // buffering, so an unauthenticated flood can't OOM us pre-auth; and
        // size the cap to the real 10×maxUploadBytes batch (base64 overhead).
        let cap = 128 * 1024;
        if (pathname === '/api/upload-nft') {
          if (rateLimited('upload:ip:' + clientIp(req), 15, 24 * 3600000)) throw httpError(429, 'too many uploads from this connection today');
          cap = Math.ceil(CFG.maxUploadBytes * 10 * 4 / 3) + 64 * 1024;
        } else if (pathname === '/api/launch-token') {
          // One optional base64 logo rides along with a launch.
          if (rateLimited('launchbody:ip:' + clientIp(req), 12, 24 * 3600000)) throw httpError(429, 'too many launch attempts from this connection today');
          cap = Math.ceil(CFG.maxUploadBytes * 4 / 3) + 64 * 1024;
        }
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
      /* The FULL ordered candidate list, not just the first healthy one —
         koilib's Provider rotates to the next node when one starts
         answering with garbage mid-flight. */
      const rpcUrls = await pickRpcs(CFG.network);
      chain.configure({
        network: CFG.network, rpcs: rpcUrls,
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
          if (/^Uninitialized/.test(info.name || '')) {
            /* Deployed but never initialized — this is what OURO (and every
               chain reader) shows as an unnamed collection. The deploy
               script's initialize step retries safely. */
            console.log(`paint:    WARNING — ${CFG.collectionAddr} is deployed but NOT initialized (name/symbol unset).`);
            console.log(`paint:    Fix: KOINOS_NETWORK=${CFG.network} node scripts/deploy-playground.js gateway.env  (idempotent — it will only run the missing initialize)`);
          } else {
            console.log(`paint:    ${CFG.collectionAddr} "${info.name || '?'}" (${info.symbol || '?'})`);
            registerPaintCollection(info);
          }
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
  // Google sign-in is bridged to Aurvania — inherit its client id if we have
  // none of our own, so the shared-wallet login works out of the box.
  await auth.warmup();
  // Social login readiness.
  if (auth.googleEnabled()) {
    console.log(auth.googleCustody()
      ? `auth:     Google sign-in ENABLED — wallets held HERE, adopted from ${auth.aurvania()} on first login (same address as Aurvania / OURO)`
      : `auth:     Google sign-in ENABLED (bridged to ${auth.aurvania()} — shared wallet with Aurvania / OURO)`);
    if (!auth.googleCustody()) console.log('          set LOGIN_SECRET to hold Google wallets here instead of bridging every login');
  }
  else console.log(`auth:     Google sign-in OFF — set GOOGLE_CLIENT_ID (Aurvania's) or make ${auth.aurvania()} reachable at boot`);
  if (auth.xEnabled()) console.log('auth:     X (Twitter) sign-in ENABLED');
  else if (CFG.xClientId && !CFG.loginSecret) console.log('auth:     X client id set but LOGIN_SECRET is unset — X sign-in stays OFF');
  console.log('auth:     Local Wallet + Import always available');
  if (auth.signerEnabled()) {
    console.log(`signer:   /api/session + /api/sign ENABLED — apps sign via this server, the key never leaves it (${CFG.signerSessionTtlMins}-min sessions)`);
    console.log(CFG.signerOrigins.length
      ? `signer:   cross-origin allowed for: ${CFG.signerOrigins.join(', ')}`
      : 'signer:   same-origin only — set SIGNER_ORIGINS to let another app (e.g. app.tradekoinos.com) sign through this server');
  } else if (auth.googleEnabled() && !auth.googleCustody()) {
    console.log('signer:   OFF — set LOGIN_SECRET to enable server-side signing (keys held here instead of handed to browsers)');
  }

  server.listen(CFG.port, () => {
    console.log(`serving:  http://localhost:${CFG.port} ${DEMO ? '(demo mode)' : ''}`);
  });

  /* Heal the registry against the chain in the background — never blocks
     serving, and a mint recorded on-chain but lost to an RPC hiccup (or a
     data/ wipe) reappears on the site within a minute of boot. */
  if (!DEMO) reconcileRegistry().catch((e) => console.log(`heal:     skipped — ${e.message}`));
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

/* ---------------- registry ⇄ chain reconciliation ----------------
   An RPC hiccup mid-launch, or a redeploy that wiped data/, leaves things
   that EXIST on-chain missing from the registry — a visitor's very real
   token or NFT simply vanishes from the site. The chain is the source of
   truth; rebuild what can be rebuilt:
     · launched tokens — every key held in token-keys.json is checked on-chain
     · upload collections — same, from collection-keys.json
     · paint NFTs — the collection's token ids are enumerated and missing
       ones rebuilt from their on-chain metadata (name + image live on-chain)
     · the DK sequence counter is bumped past every id seen, so a wiped
       counters.json can never re-issue a used id ("token already minted") */
async function reconcileRegistry() {
  let healed = 0;

  for (const addr of Object.keys(tokenKeys)) {
    if (registry.tokens.some(t => t.address === addr)) continue;
    try {
      const held = tokenKeys[addr];
      const wif = typeof held === 'string' ? held : held.wif;
      const spec = typeof held === 'string' ? null : held.spec;
      let { result: cfg } = await chain.tokenContractAt(addr).functions.get_config({});
      if (!cfg) continue;                        // no contract deployed — nothing on-chain to recover
      if (!cfg.initialized) {
        /* Deployed but never set up — the upload landed and its mana is
           already spent. With the stored spec we can FINISH the launch. */
        if (!spec || !wif) continue;
        console.log(`heal:     finishing interrupted launch at ${addr} ("${spec.symbol}")…`);
        try {
          await chain.sendAsAccount(chain.keyFromWif(wif), [await chain.opTokenInitialize(addr, spec)]);
        } catch (e) {
          if (!(await chain.tokenInitialized(addr))) { console.log(`heal:     ${addr} initialize failed — ${e.message}`); continue; }
        }
        ({ result: cfg } = await chain.tokenContractAt(addr).functions.get_config({}));
        if (!cfg || !cfg.initialized) continue;
      }
      const decimals = Number(cfg.decimals || 0);
      const [supplyR, ownerR] = await Promise.all([
        chain.tokenContractAt(addr).functions.total_supply({}).catch(() => ({ result: null })),
        chain.tokenContractAt(addr).functions.owner({}).catch(() => ({ result: null })),
      ]);
      const supplyUnits = String(supplyR.result?.value || '0');
      registry.tokens.push({
        address: addr, name: cfg.name || '', symbol: cfg.symbol || '', decimals,
        mintable: !!cfg.mintable, supplyUnits, supply: chain.fromUnits(supplyUnits, decimals),
        owner: ownerR.result?.value || null, txid: null, uploadTx: null,
        ts: Date.now(), recovered: true,
      });
      healed++;
    } catch (_) { /* unreadable right now — retried next boot */ }
  }
  if (healed) saveTokens();

  let healedCols = 0;
  for (const addr of Object.keys(collectionKeys)) {
    if (registry.collections.some(c => c.address === addr)) continue;
    try {
      const c = chain.collectionContractAt(addr);
      const { result: info } = await c.functions.get_info({});
      if (!info || !info.name || /^Uninitialized/.test(info.name)) continue;
      const { result: ownerR } = await c.functions.owner({}).catch(() => ({ result: null }));
      const rec = {
        address: addr, name: info.name, symbol: info.symbol || '',
        owner: ownerR?.value || null, kind: 'user', createdAt: Date.now(),
        ouro: false, recovered: true,
      };
      registry.collections.push(rec);
      healedCols++;
      registerOnOuro({ address: addr, name: info.name, owner: rec.owner })
        .then((ok) => { if (ok) { rec.ouro = true; saveCollections(); } }).catch(() => {});
    } catch (_) {}
  }
  if (healedCols) saveCollections();

  let healedNfts = 0;
  if (chain.nftEnabled()) {
    try {
      const ids = await chain.allCollectionTokens();
      const have = new Set(registry.nfts.filter(n => n.collection === CFG.collectionAddr).map(n => n.tokenId));
      let maxSeq = 0;
      for (const id of ids) {
        const code = chain.tokenIdToCode(id);
        const m = /^DK0*(\d+)$/.exec(code || '');
        if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
        if (have.has(id)) continue;
        let meta = {};
        try { meta = JSON.parse(await chain.nftMetadata(id) || '{}'); } catch (_) {}
        const owner = await chain.nftOwner(id).catch(() => null);
        registry.nfts.push({
          code: code || id, tokenId: id, name: meta.name || code || id,
          image: meta.image || '', collection: CFG.collectionAddr, collectionName: PAINT_NAME,
          owner, txid: null, ts: Date.now(), recovered: true,
        });
        healedNfts++;
      }
      if (healedNfts) saveNfts();
      rollDay();
      if ((registry.counters.seq || 0) < maxSeq) {
        console.log(`heal:     DK sequence counter behind the chain (${registry.counters.seq || 0} < ${maxSeq}) — bumped`);
        registry.counters.seq = maxSeq; saveCounters();
      }
    } catch (e) { console.log(`heal:     paint reconcile skipped — ${e.message}`); }
  }

  if (healed || healedCols || healedNfts) {
    console.log(`heal:     recovered from chain — ${healed} token(s), ${healedCols} collection(s), ${healedNfts} paint NFT(s)`);
  }
}
