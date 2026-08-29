/* ============================================================
   KoinDX pool bootstrap.

   KoinDX pairs are real contracts, and the periphery's create_pair only
   accepts a transaction of EXACTLY two operations: an upload_contract op
   carrying the official pool bytecode (sha256-pinned inside the deployed
   periphery, KOINDX: INVALID_HASH otherwise) followed by the create_pair
   call itself. That shape cannot be staged from inside a contract call,
   which is why the launchpad contract's own create_pair attempt is dead
   weight and the keeper prepares pairs here, off-chain, before asking the
   launchpad to provide_liquidity.

   The official bytecode is not vendored in this repo, and KoinDX rotates
   the pinned hash over time (koin/vhp — the oldest pool — no longer
   matches it). Candidate bytecodes are gathered newest-source-first:
   whatever the KoinDX web app itself ships for pool creation, then the
   creation transaction of the koin/vhp pool as a legacy fallback. A hash
   the periphery rejects is remembered in DATA_DIR and never resubmitted
   (rejected attempts still cost sponsor mana); the hash that actually
   creates a pool is cached in DATA_DIR and tried first from then on.

   The fresh pool key is throwaway BY DESIGN: the periphery requires the
   upload to set all three authorizes_* overrides, which hands authority
   to the pool contract itself the moment it lands — after that block the
   key can neither upgrade the pool nor touch its funds.
   ============================================================ */
'use strict';

/* Bumped with every change here; the keeper prints it at boot so
   /api/keeper-log proves which koindx build a host is actually running
   (a live host was observed with a NEWER keeper and an OLDER koindx). */
const VERSION = 'v4-candidates';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Signer, Contract, utils } = require('koilib');

const PERIPHERY_ABI = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'server-abi', 'koindx-periphery-abi.json'))
);

/* Same resolution as server.js so the cache survives redeploys when
   DATA_DIR points outside the deploy directory. */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
/* v2: the pre-candidates code cached a bytecode WITHOUT proving the
   periphery accepts it, and one stale copy is known to be sitting in
   DATA_DIR on the live host. New name = the old file is simply never
   trusted; this file only ever holds a version that created a pool. */
const CACHE_FILE = path.join(DATA_DIR, 'koindx-pool-v2.wasm');

/* KoinDX periphery (mainnet) — the same address the launchpad contract
   calls for add_liquidity, from @koindx/v2-sdk. */
const PERIPHERY_B58 = '17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s';

/* KoinDX identifies chain-native tokens by NAMESPACE, not address: every
   canonical pair keys KOIN as the literal string "koin" (and VHP as
   "vhp") — the koindx token-list says so verbatim. Asking get_pair with
   the base58 KOIN address finds nothing, ever. */
const KOIN_DEX_ID = 'koin';
const VHP_DEX_ID = 'vhp';


function peripheryContract(chain, signer) {
  return new Contract({
    id: PERIPHERY_B58,
    abi: PERIPHERY_ABI,
    provider: chain.provider(),
    signer,
  });
}

/** Pool (pair) contract address for KOIN/token, or null if none exists. */
async function getPair(chain, tokenB58) {
  const { result } = await peripheryContract(chain).functions.get_pair({
    tokenA: KOIN_DEX_ID,
    tokenB: tokenB58,
  });
  const value = result && result.value;
  return value && String(value).length ? String(value) : null;
}

/* ---------------- pool bytecode candidates ----------------
   The periphery pins ONE sha256 and KoinDX upgrades it over time, so a
   bytecode that created an old pool can be stale (KOINDX: INVALID_HASH —
   observed live: the koin/vhp pool predates the current pin). Candidates
   are gathered newest-source-first, every hash that gets rejected on
   chain is remembered forever (rejected attempts still cost sponsor
   mana), and only a hash that actually created a pool is cached. */

const BAD_FILE = path.join(DATA_DIR, 'koindx-bad-hashes.json');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function loadBadHashes() {
  try { return new Set(JSON.parse(fs.readFileSync(BAD_FILE))); }
  catch (_) { return new Set(); }
}
function saveBadHash(hash) {
  const bad = loadBadHashes();
  bad.add(hash);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BAD_FILE, JSON.stringify([...bad]));
  } catch (_) {}
}

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal, redirect: 'follow' }); }
  finally { clearTimeout(t); }
}

/** The freshest source of the CURRENT pool program: KoinDX's own web app
    ships it to every user who creates a pool. Scan its script bundles for
    embedded wasm (base64 "AGFzbQ…" = "\0asm") and for .wasm asset URLs. */
async function bytecodesFromKoindxApp(log) {
  const found = [];
  try {
    const site = 'https://app.koindx.com';
    const html = await (await fetchWithTimeout(site + '/', 20000)).text();
    const urls = new Set();
    for (const m of html.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)) {
      urls.add(new URL(m[1], site + '/').href);
    }
    let budget = 8;
    for (const url of urls) {
      if (budget-- <= 0) break;
      let body;
      try { body = await (await fetchWithTimeout(url, 20000)).text(); }
      catch (_) { continue; }
      for (const m of body.matchAll(/AGFzbQ[A-Za-z0-9+/=\\]{20000,}/g)) {
        try {
          const wasm = Buffer.from(m[0].replace(/\\/g, ''), 'base64');
          if (wasm.length > 30000 && wasm.readUInt32LE(0) === 0x6d736100) found.push(wasm);
        } catch (_) {}
      }
      for (const w of body.matchAll(/["']([^"']+\.wasm)["']/g)) {
        try {
          const res = await fetchWithTimeout(new URL(w[1], site + '/').href, 20000);
          const wasm = Buffer.from(await res.arrayBuffer());
          if (wasm.length > 30000 && wasm.readUInt32LE(0) === 0x6d736100) found.push(wasm);
        } catch (_) {}
      }
    }
    if (log) log(`koindx:   KoinDX app bundle scan: ${found.length} wasm candidate(s) across ${urls.size} script file(s)`);
  } catch (error) {
    if (log) log(`koindx:   could not read the KoinDX app bundle — ${error.message}`);
  }
  return found;
}

/** Legacy source: the creation transaction of an existing pool (works only
    while that pool was created under the CURRENT pin). */
async function bytecodeFromDonorPool(chain, log) {
  try {
    const sourcePair = await getPair(chain, VHP_DEX_ID);
    if (!sourcePair) return null;
    const history = await chain.provider().call('account_history.get_account_history', {
      address: sourcePair,
      limit: 10,
      ascending: true,
    });
    for (const entry of (history && history.values) || []) {
      const ops =
        (entry.trx && entry.trx.transaction && entry.trx.transaction.operations) || [];
      for (const op of ops) {
        if (op.upload_contract && op.upload_contract.bytecode) {
          const wasm = Buffer.from(utils.decodeBase64url(op.upload_contract.bytecode));
          if (wasm.length > 10000) {
            if (log) log(`koindx:   donor pool ${sourcePair} offers bytecode sha256 ${sha(wasm).slice(0, 16)}…`);
            return wasm;
          }
        }
      }
    }
  } catch (error) {
    if (log) log(`koindx:   donor pool lookup failed — ${error.message}`);
  }
  return null;
}

/** All distinct candidate bytecodes, best source first, known-bad removed. */
async function candidateBytecodes(chain, log) {
  const bad = loadBadHashes();
  const out = [];
  const seen = new Set();
  const push = (wasm, from) => {
    if (!wasm) return;
    const hash = sha(wasm);
    if (seen.has(hash) || bad.has(hash)) return;
    seen.add(hash);
    out.push({ wasm, hash, from });
  };
  try {
    const cached = fs.readFileSync(CACHE_FILE);
    if (cached.length > 10000) push(cached, 'cache');
  } catch (_) {}
  for (const wasm of await bytecodesFromKoindxApp(log)) push(wasm, 'koindx app');
  push(await bytecodeFromDonorPool(chain, log), 'donor pool');
  if (log) log(`koindx:   ${out.length} untried candidate(s): ${out.map((c) => `${c.from} ${c.hash.slice(0, 12)}…`).join(', ') || 'none'}`);
  return out;
}

/** Create the KOIN/token pool: upload the official bytecode to a fresh
    throwaway account + create_pair, in the one 2-op transaction the
    periphery demands. Sponsor pays the mana. Tries each candidate
    bytecode once, remembers rejected hashes so no attempt repeats, and
    caches the one that works. Returns { pair, txId }. */
async function createPair(chain, tokenB58, log) {
  const candidates = await candidateBytecodes(chain, log);
  if (!candidates.length) {
    throw new Error('no untried pool bytecode candidate available (KoinDX app unreadable and donor pool stale)');
  }

  let lastError = null;
  for (const candidate of candidates) {
    const poolKey = new Signer({ privateKey: crypto.randomBytes(32).toString('hex') });
    const uploadOp = await chain.opUploadContract(poolKey.getAddress(), candidate.wasm, {
      contractAuthority: true,
    });
    const { operation: createOp } = await peripheryContract(chain, poolKey).functions.create_pair(
      { tokenA: KOIN_DEX_ID, tokenB: tokenB58 },
      { onlyOperation: true }
    );
    try {
      const txId = await chain.sendAsAccount(poolKey, [uploadOp, createOp], {
        rcLimit: chain.K.rcLimitUpload,
      });
      const pair = await getPair(chain, tokenB58);
      if (!pair) throw new Error(`create_pair mined (${txId}) but the pool is still missing`);
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(CACHE_FILE, candidate.wasm);
      } catch (_) {}
      if (log) log(`koindx:   pool created with bytecode from ${candidate.from} (sha256 ${candidate.hash.slice(0, 16)}…)`);
      return { pair, txId };
    } catch (error) {
      lastError = error;
      if (/INVALID_HASH/i.test(String(error.message || ''))) {
        saveBadHash(candidate.hash);
        try { if (candidate.from === 'cache') fs.unlinkSync(CACHE_FILE); } catch (_) {}
        if (log) log(`koindx:   bytecode from ${candidate.from} rejected by the periphery (marked bad, never retried)`);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('pool creation failed');
}

module.exports = { getPair, createPair, PERIPHERY_B58, VERSION };
