/* ============================================================
   Koinos chain facade — every on-chain concern in one module.

   The model the gateway runs on:
     · Each visitor gets a real Koinos account (the browser generates
       and keeps the key; the address IS the identity).
     · The DEV WALLET pays for everything through mana sharing: every
       transaction is co-signed by the dev wallet as payer, so trying
       Koinos costs the visitor nothing — ever.
     · The playground NFT collection and every launched token keep
       their account keys server-side, which is what lets the gateway
       mint and launch with ZERO wallet interaction: the server signs
       as the contract, pays as dev, and the asset lands in the
       visitor's address.

   Transactions come in three shapes:
     · devTx(ops)        — server-only actions, dev wallet alone.
     · prepareUserTx()   — actions that move a VISITOR's assets. The
       + submitCosigned    server builds the exact transaction (payer =
                           dev, payee = visitor, visitor's nonce), the
                           browser signs it, the server verifies id +
                           signature, co-signs as payer and broadcasts.
                           The server prepared every byte, so a tampered
                           transaction simply doesn't match.
     · sendAsAccount()   — the contract's own account signs (mint as the
                           collection, initialize as the token), dev
                           co-signs as payer. No visitor signature: the
                           payee is the contract account, not the user.
   ============================================================ */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Signer, Provider, Contract, Transaction, utils } = require('koilib');
const { NETWORKS, rpcCandidates } = require('./rpc');

/* Every generated Koinos ABI carries a `koinos.btype` node that EXTENDS
   google.protobuf.FieldOptions — and the protobufjs bundled with koilib
   9.x refuses JSON descriptors with unresolved extensions. The extension
   only DECLARES the custom option; the per-field "(koinos.btype)" values
   koilib actually reads live in each field's options and survive
   untouched. So strip the declaration nodes once at load. */
function sanitizeAbi(abi) {
  const out = JSON.parse(JSON.stringify(abi));
  const koinos = out.koilib_types?.nested?.koinos?.nested;
  if (koinos) { delete koinos.btype; delete koinos._btype; }
  return out;
}
/* Some ABIs (koinos-abi-proto-gen output, e.g. Trade Koinos' orderbook)
   name their METHOD fields camelCase (entryPoint/input/output/readOnly) and
   put the protobuf descriptor under `types` rather than `koilib_types`.
   koilib wants snake_case method fields and reads `koilib_types`. Normalize
   once at load, then sanitize the btype extension like any other ABI. */
function normalizeGeneratedAbi(abi) {
  const methods = {};
  for (const [name, m] of Object.entries(abi.methods || {})) {
    methods[name] = {
      entry_point: m.entry_point ?? m.entryPoint ??
        (m['entry-point'] != null ? parseInt(m['entry-point'], 16) : undefined),
      argument: m.argument ?? m.input,
      return: m.return ?? m.output,
      read_only: m.read_only ?? m.readOnly ?? m['read-only'],
      description: m.description,
    };
  }
  return sanitizeAbi({ methods, koilib_types: abi.koilib_types || abi.types });
}

const ABI_DIR = path.join(__dirname, '..', 'server-abi');
const COLLECTION_ABI = sanitizeAbi(JSON.parse(fs.readFileSync(path.join(ABI_DIR, 'collection-abi.json'))));
const TOKEN_ABI = sanitizeAbi(JSON.parse(fs.readFileSync(path.join(ABI_DIR, 'token-abi.json'))));
const ORDERBOOK_ABI = normalizeGeneratedAbi(JSON.parse(fs.readFileSync(path.join(ABI_DIR, 'orderbook-abi.json'))));
const LAUNCHPAD_ABI = normalizeGeneratedAbi(JSON.parse(fs.readFileSync(path.join(ABI_DIR, 'launchpad-abi.json'))));
/* NOT koilib's utils.tokenAbi: that one names its methods in camelCase
   (balanceOf), while this facade — and the KCS standard — speak snake_case
   (balance_of). The launchpad token ABI shares KOIN's standard entry
   points and reads the real KOIN contract fine. */
const KOIN_ABI = TOKEN_ABI;

const K = {
  network: 'harbinger',
  rpcs: [],
  devWif: '',
  collectionAddr: '',
  collectionWif: '',
  /* Trade Koinos orderbook DEX (mainnet only — no testnet deployment). */
  dexOrderbook: '',
  /* Trade Koinos launchpad — the keeper settles its launches. */
  launchpadAddr: '',
  /* rc_limit for ordinary co-signed operations. Mana is not spent up to
     this limit — it only caps the charge — and it regenerates, so a
     generous fixed ceiling beats a fragile estimation round-trip. A real
     contract call burns ~0.4-1.3 KOIN of mana; 5 KOIN covers any ordinary
     gateway operation. Contract UPLOADS are priced separately. */
  rcLimit: '500000000',
  /* A 60KB contract upload eats ~46 KOIN of mana (~0.00077 KOIN/byte).
     80 KOIN of headroom is the ceiling marketplace launches proved out. */
  rcLimitUpload: '8000000000',
};

let _provider = null, _devSigner = null, _chainId = '';

function configure(opts) {
  Object.assign(K, opts || {});
  if (!K.rpcs.length) K.rpcs = rpcCandidates(K.network);
  _provider = null; _devSigner = null; _devAddr = ''; _chainId = '';
}

const net = () => NETWORKS[K.network];
const enabled = () => !!K.devWif;
const nftEnabled = () => !!(K.devWif && K.collectionAddr && K.collectionWif);
const dexEnabled = () => !!(K.devWif && K.dexOrderbook);
const launchpadEnabled = () => !!(K.devWif && K.launchpadAddr);

function provider() {
  if (!_provider) {
    _provider = new Provider(K.rpcs.slice());
    /* koilib's fetch has no timeout: one stalled connection would hang a
       read forever. Race every call against a 25s clock. */
    const rawCall = _provider.call.bind(_provider);
    _provider.call = (method, params) => Promise.race([
      rawCall(method, params),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error(`koinos rpc timeout (${method})`)), 25000);
        if (t.unref) t.unref();
      }),
    ]);
  }
  return _provider;
}

function devSigner() {
  if (!_devSigner && K.devWif) {
    _devSigner = Signer.fromWif(K.devWif);
    _devSigner.provider = provider();
  }
  return _devSigner;
}

let _devAddr = '';
function devAddress() {
  if (!_devAddr && K.devWif) _devAddr = Signer.fromWif(K.devWif).getAddress();
  return _devAddr || null;
}

/** Base58check address that decodes to a 25-byte payload — a Koinos
    (Bitcoin-style) address. Case matters; never lowercase these. */
function isAddr(a) {
  const s = String(a || '');
  if (!/^1[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s)) return false;
  try { return utils.decodeBase58(s).length >= 20 && utils.isChecksumAddress(s); }
  catch (_) { return false; }
}

async function chainId() {
  if (!_chainId) _chainId = await provider().getChainId();
  return _chainId;
}

/* ---------------- contracts ---------------- */

const koinContract = () => new Contract({
  id: net().koinContract, abi: KOIN_ABI, provider: provider(),
});
const vhpContract = () => new Contract({
  id: net().vhpContract, abi: KOIN_ABI, provider: provider(),
});
const collectionContract = (signer) => new Contract({
  id: K.collectionAddr, abi: COLLECTION_ABI, provider: provider(),
  ...(signer ? { signer } : {}),
});
/* A collection at an arbitrary address (a per-user "Upload" collection). */
const collectionContractAt = (addr, signer) => new Contract({
  id: addr, abi: COLLECTION_ABI, provider: provider(),
  ...(signer ? { signer } : {}),
});
const tokenContractAt = (addr, signer) => new Contract({
  id: addr, abi: TOKEN_ABI, provider: provider(),
  ...(signer ? { signer } : {}),
});
const launchpadContract = (signer) => new Contract({
  id: K.launchpadAddr, abi: LAUNCHPAD_ABI, provider: provider(),
  ...(signer ? { signer } : {}),
});
const orderbookContract = (signer) => new Contract({
  id: K.dexOrderbook, abi: ORDERBOOK_ABI, provider: provider(),
  ...(signer ? { signer } : {}),
});

/* Koinos convention: 8 decimals. Values cross the wire as satoshi
   STRINGS; BigInt math only, never floats. */
const SATS = 100000000n;
const fromSatsExact = (s) => Number(BigInt(String(s || '0'))) / 1e8;

/** Human amount -> smallest-units string for an arbitrary-decimals token.
    String math (no floats): "12.5" with 8 decimals -> "1250000000". */
function toUnits(amountStr, decimals) {
  const s = String(amountStr).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('bad amount');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimal places`);
  const units = BigInt(whole + frac.padEnd(decimals, '0'));
  if (units <= 0n) throw new Error('amount must be positive');
  if (units > 0xffffffffffffffffn) throw new Error('amount too large');
  return units.toString();
}
function fromUnits(unitsStr, decimals) {
  const u = BigInt(String(unitsStr || '0'));
  const base = 10n ** BigInt(decimals);
  const whole = u / base, frac = u % base;
  if (!frac) return whole.toString();
  return whole.toString() + '.' + frac.toString().padStart(decimals, '0').replace(/0+$/, '');
}

/* ---------------- reads ---------------- */

async function koinBalance(addr) {
  const { result } = await koinContract().functions.balance_of({ owner: addr });
  return fromSatsExact(result?.value);
}

/** Free mana right now (KOIN units). Every Koinos account regenerates
    this — it is why the gateway can pay for everyone. */
async function mana(addr) {
  const rc = await provider().getAccountRc(addr);
  return fromSatsExact(rc);
}

async function headInfo() {
  return provider().call('chain.get_head_info', {});
}

/** KOIN + VHP supplies. Burning KOIN mints VHP one-for-one, so the VHP
    supply IS the amount of KOIN currently burned into block production. */
async function supplies() {
  const [koin, vhp] = await Promise.all([
    koinContract().functions.total_supply({}),
    vhpContract().functions.total_supply({}),
  ]);
  return {
    koin: fromSatsExact(koin.result?.value),
    vhp: fromSatsExact(vhp.result?.value),
  };
}

async function collectionInfo() {
  const { result } = await collectionContract().functions.get_info({});
  return result || {};
}

async function collectionSupply() {
  const { result } = await collectionContract().functions.total_supply({});
  return Number(result?.value || 0);
}

async function tokensOfOwner(addr, limit = 100) {
  const { result } = await collectionContract().functions.get_tokens_by_owner(
    { owner: addr, limit });
  return (result?.token_ids || []);
}

async function nftOwner(tokenIdHex) {
  const { result } = await collectionContract().functions.owner_of({ token_id: tokenIdHex });
  return result?.value || null;
}

async function nftMetadata(tokenIdHex) {
  try {
    const { result } = await collectionContract().functions.metadata_of({ token_id: tokenIdHex });
    return result?.value || '';
  } catch (_) { return ''; }
}

/** Every token id in the Paint collection, straight off the chain — the
    source of truth the registry can be rebuilt against after a data wipe
    or a mint whose confirmation was lost to an RPC hiccup. */
async function allCollectionTokens(max = 2000) {
  const ids = [];
  let start = undefined;
  while (ids.length < max) {
    const { result } = await collectionContract().functions.get_tokens(
      start ? { start, limit: 100 } : { limit: 100 });
    const page = result?.token_ids || [];
    if (!page.length) break;
    ids.push(...page);
    if (page.length < 100) break;
    start = page[page.length - 1];
  }
  return ids;
}

/** A launched token's on-chain identity + supply, via its own contract. */
async function tokenInfoAt(addr) {
  const c = tokenContractAt(addr);
  const [info, supply] = await Promise.all([
    c.functions.get_info({}),
    c.functions.total_supply({}),
  ]);
  return {
    name: info.result?.name || '', symbol: info.result?.symbol || '',
    decimals: Number(info.result?.decimals || 0),
    supply: String(supply.result?.value || '0'),
  };
}

async function tokenBalanceAt(addr, owner) {
  const { result } = await tokenContractAt(addr).functions.balance_of({ owner });
  return String(result?.value || '0');
}

/* ---------------- operation builders ---------------- */

async function opKoinTransfer(from, to, valueSats) {
  const { operation } = await koinContract().functions.transfer(
    { from, to, value: String(valueSats) }, { onlyOperation: true });
  return operation;
}
async function opNftMint(to, tokenIdHex) {
  const { operation } = await collectionContract().functions.mint(
    { to, token_id: tokenIdHex }, { onlyOperation: true });
  return operation;
}
async function opNftSetMetadata(tokenIdHex, metadata) {
  const { operation } = await collectionContract().functions.set_metadata(
    { token_id: tokenIdHex, metadata }, { onlyOperation: true });
  return operation;
}
async function opNftTransfer(from, to, tokenIdHex) {
  const { operation } = await collectionContract().functions.transfer(
    { from, to, token_id: tokenIdHex }, { onlyOperation: true });
  return operation;
}
async function opTokenTransfer(tokenAddr, from, to, valueUnits) {
  const { operation } = await tokenContractAt(tokenAddr).functions.transfer(
    { from, to, value: String(valueUnits) }, { onlyOperation: true });
  return operation;
}
async function opTokenMint(tokenAddr, to, valueUnits) {
  const { operation } = await tokenContractAt(tokenAddr).functions.mint(
    { to, value: String(valueUnits) }, { onlyOperation: true });
  return operation;
}
async function opTokenBurn(tokenAddr, from, valueUnits) {
  const { operation } = await tokenContractAt(tokenAddr).functions.burn(
    { from, value: String(valueUnits) }, { onlyOperation: true });
  return operation;
}
async function opUploadContract(contractId, wasmBuffer) {
  return {
    upload_contract: {
      contract_id: contractId,
      /* koilib's own encoder, NOT Buffer.toString('base64url'): the
         node's JSON codec wants PADDED base64url, and Node never pads. */
      bytecode: utils.encodeBase64url(wasmBuffer),
    },
  };
}
async function opTokenInitialize(tokenAddr, spec) {
  const { operation } = await tokenContractAt(tokenAddr).functions.initialize({
    name: spec.name, symbol: spec.symbol, decimals: spec.decimals,
    initial_supply: String(spec.initialSupply), mintable: !!spec.mintable,
    owner: spec.owner,
  }, { onlyOperation: true });
  return operation;
}

/* ---------------- transactions ---------------- */

/* One queue for everything the dev wallet signs: nonce order is
   guaranteed and a burst of mints can't race each other. */
let _txQueue = Promise.resolve();
function queueTx(fn) {
  const run = _txQueue.then(fn, fn);
  _txQueue = run.catch(() => {});
  return run;
}

/* Unwrap the node's JSON error bodies ({"error":"...","code":1}, sometimes
   nested) into the plain reason — nobody should ever read raw JSON in red. */
function humanChainError(e) {
  let msg = String((e && e.message) || e || 'transaction failed');
  for (let i = 0; i < 3; i++) {
    try {
      const j = JSON.parse(msg);
      if (j && typeof j.error === 'string') { msg = j.error; continue; }
      if (j && j.error && typeof j.error.message === 'string') { msg = j.error.message; continue; }
    } catch (_) {}
    break;
  }
  return msg;
}

/* A submit error that does NOT prove rejection. The node's own "request
   timeout: <id>" means ITS REPLY died — the transaction is often accepted
   and mined anyway (big contract uploads hit this constantly). A real
   rejection names its reason (insufficient rc, invalid nonce, reverted…). */
const TRANSIENT_SEND = /request timeout|timed? ?out|unexpected token|invalid json|fetch|network|econn|socket|hang up|abort|bad gateway|gateway time|service unavailable|too many request|(^|[^0-9])(429|500|502|503|504)([^0-9]|$)/i;

/** Broadcast, tolerating an ambiguous reply: on a transient-looking send
    error the mined-check (waitMined) becomes the arbiter instead of the
    error. A definitive chain rejection still throws immediately, unwrapped. */
async function sendTolerant(tx) {
  try { await tx.send(); }
  catch (e) {
    const msg = humanChainError(e);
    if (!TRANSIENT_SEND.test(msg)) { const err = new Error(msg); err.cause = e; throw err; }
    // Ambiguous — fall through; waitMined decides whether it landed.
  }
}

/** Wait until a broadcast transaction is mined — OUR loop, not koilib's.
    koilib's wait() dies on the first bad RPC answer, and public RPCs
    routinely answer one poll with an HTML error page ("Unexpected token <
    in JSON") while the transaction mines fine — which is how a successful
    launch got reported to a user as a failure. Here every poll error is
    treated as transient; only the clock ends the wait. */
async function waitMined(txId, timeoutMs = 90000) {
  const p = provider();
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const { transactions } = await p.getTransactionsById([txId]);
      const t = transactions && transactions[0];
      if (t && t.containing_blocks && t.containing_blocks.length) {
        return { blockId: t.containing_blocks[0] };
      }
    } catch (e) { lastErr = e; }          // transient: HTML page, timeout, blip
    await new Promise(r => setTimeout(r, 2500));
  }
  const why = lastErr ? ` (last poll error: ${String(lastErr.message || lastErr).slice(0, 120)})` : '';
  throw new Error(`not seen in a block within ${Math.round(timeoutMs / 1000)}s${why}`);
}

/** Server-only transaction: ops signed by the dev wallet, mined before
    resolving. Returns the transaction id. */
async function devTx(ops) {
  return queueTx(async () => {
    const tx = new Transaction({
      signer: devSigner(), provider: provider(),
      options: { rcLimit: K.rcLimit },
    });
    for (const op of ops) await tx.pushOperation(op);
    await tx.prepare();
    await tx.sign();
    await sendTolerant(tx);
    try { await waitMined(tx.transaction.id); }
    catch (e) {
      /* Mined-confirmation timed out; the transaction may still land.
         The id is carried on the error so a caller that later finds the
         effect DID happen can still record which transaction did it. */
      const err = new Error(`transaction ${tx.transaction.id} not confirmed: ${humanChainError(e)}`);
      err.txId = tx.transaction.id;
      err.broadcast = true;
      throw err;
    }
    return tx.transaction.id;
  });
}

/** A contract account acts as itself: `key` signs (mint as the
    collection, initialize as the token), dev co-signs as mana payer.
    The PAYEE is the contract account — the payee is whose nonce a
    transaction spends, and borrowing the busy dev nonce loses races. */
async function sendAsAccount(key, ops, { rcLimit = K.rcLimit } = {}) {
  key.provider = provider();
  /* prepare() reads the PAYEE's nonce — and for playground mints the payee
     is the ONE shared collection account. Do the nonce read + sign + send
     all INSIDE the queue, or two concurrent mints read the same nonce and
     the second is rejected as a duplicate (devTx honors this same rule). */
  return queueTx(async () => {
    const tx = new Transaction({
      signer: key, provider: provider(),
      options: { payer: devAddress(), payee: key.getAddress(), rcLimit },
    });
    for (const op of ops) await tx.pushOperation(op);
    await tx.prepare();
    await tx.sign();
    await devSigner().signTransaction(tx.transaction);
    const send = new Transaction({ provider: provider() });
    send.transaction = tx.transaction;
    await sendTolerant(send);
    try { await waitMined(tx.transaction.id); }
    catch (e) {
      const err = new Error(`transaction ${tx.transaction.id} not confirmed: ${humanChainError(e)}`);
      err.txId = tx.transaction.id;
      err.broadcast = true;
      throw err;
    }
    return tx.transaction.id;
  });
}

/** Build a transaction a VISITOR must sign: dev wallet is payer (mana),
    the visitor is payee (their nonce, their authority). Returns the
    complete unsigned transaction JSON — id included, so the server can
    later prove the signed copy is byte-identical. */
async function prepareUserTx(userAddr, ops) {
  const tx = new Transaction({
    provider: provider(),
    options: { payer: devAddress(), payee: userAddr, rcLimit: K.rcLimit },
  });
  for (const op of ops) await tx.pushOperation(op);
  await tx.prepare({ chainId: await chainId() });
  return tx.transaction;
}

/** Verify a visitor-signed transaction against the copy we prepared,
    co-sign as payer and broadcast. Resolves once mined. */
async function submitCosigned(signedTx, preparedId, userAddr) {
  if (!signedTx || signedTx.id !== preparedId) {
    throw new Error('transaction does not match the prepared action');
  }
  const recomputed = Transaction.computeTransactionId(signedTx.header);
  if (recomputed !== preparedId) throw new Error('transaction header was altered');
  const signers = await Signer.recoverAddresses(signedTx);
  if (!signers.includes(userAddr)) throw new Error('missing your signature');
  /* A transaction returned through a browser round-trip accumulates
     koilib-attached extras the node rejects; rebuild it from exactly the
     four protocol fields before co-signing. */
  const clean = {
    id: signedTx.id, header: signedTx.header,
    operations: signedTx.operations, signatures: signedTx.signatures,
  };
  return queueTx(async () => {
    await devSigner().signTransaction(clean);
    const tx = new Transaction({ provider: provider() });
    tx.transaction = clean;
    await sendTolerant(tx);
    try { await waitMined(clean.id); }
    catch (e) {
      const err = new Error(`transaction ${clean.id} not confirmed: ${humanChainError(e)}`);
      err.txId = clean.id;
      err.broadcast = true;
      throw err;
    }
    return clean.id;
  });
}

/* ---------------- gateway actions ---------------- */

/** Mint a playground NFT straight into `to`'s wallet — no visitor
    signature. The collection contract authorizes mint/set_metadata by
    owner OR its own account; the server holds the collection key. */
async function mintNft(to, tokenIdHex, metadataJson) {
  return mintToCollection(K.collectionWif, to, tokenIdHex, metadataJson);
}

/** Mint into ANY collection whose key the server holds (the shared Paint
    collection, or a per-user Upload collection) — no visitor signature.
    The collection authorizes mint by owner OR its own account, and we sign
    as the collection. */
async function mintToCollection(collectionWif, to, tokenIdHex, metadataJson) {
  return mintManyToCollection(collectionWif, to, [{ tokenId: tokenIdHex, metadata: metadataJson }]);
}

/** Batch-mint several NFTs into one collection in a SINGLE transaction —
    a 10-image upload is one broadcast and one wait, not ten. rc_limit
    scales with the op count (it's a ceiling, not a charge). */
async function mintManyToCollection(collectionWif, to, items) {
  const key = Signer.fromWif(collectionWif);
  const c = collectionContractAt(key.getAddress(), key);
  const ops = [];
  for (const it of items) {
    const { operation: mintOp } = await c.functions.mint({ to, token_id: it.tokenId }, { onlyOperation: true });
    const { operation: metaOp } = await c.functions.set_metadata({ token_id: it.tokenId, metadata: it.metadata }, { onlyOperation: true });
    ops.push(mintOp, metaOp);
  }
  const rcLimit = String(Math.min(30e8, Math.max(5e8, 3e8 * items.length)));
  return sendAsAccount(key, ops, { rcLimit });
}

/** Has this collection been initialized on-chain? (get_info answers with a
    real name once initialize has run.) */
async function collectionInitializedAt(address) {
  try {
    const { result } = await collectionContractAt(address).functions.get_info({});
    return !!(result && result.name && result.name !== 'Uninitialized collection');
  } catch (_) { return false; }
}

/** Launch a fresh KCS-2 collection for `spec.owner` — no visitor signature.
    Same shape as launchToken (upload the audited collection WASM to a fresh
    account, then initialize), tolerant of a timed-out-but-mined step. The
    key is minted + persisted by the caller. Returns { address, uploadTx, initTx }. */
async function launchCollection(spec, wasmBuffer, key) {
  key.provider = provider();
  const address = key.getAddress();

  let uploadTx = null;
  try {
    uploadTx = await sendAsAccount(key, [await opUploadContract(address, wasmBuffer)], { rcLimit: K.rcLimitUpload });
  } catch (e) {
    if (!e.broadcast) throw e;
    uploadTx = e.txId || null;
  }

  let initTx = null, lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 4000 + attempt * 2000));
    if (await collectionInitializedAt(address)) { initTx = initTx || 'confirmed'; lastErr = null; break; }
    try {
      const c = collectionContractAt(address, key);
      const { operation } = await c.functions.initialize({
        name: spec.name, symbol: spec.symbol, uri: spec.uri || '',
        description: spec.description || '', owner: spec.owner,
        royalty_bps: String(spec.royaltyBps || 0), royalty_address: spec.owner,
      }, { onlyOperation: true });
      initTx = await sendAsAccount(key, [operation]);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (/already been set up/i.test(String(e.message || e))) { initTx = initTx || 'confirmed'; lastErr = null; break; }
    }
  }
  if (lastErr) {
    const err = new Error(`collection deployed at ${address} but initialize failed: ${lastErr.message || lastErr}`);
    err.address = address;
    err.uploadTx = uploadTx;
    throw err;
  }
  return { address, uploadTx, initTx };
}

/* ---------------- Trade Koinos DEX (orderbook) ----------------
   Listing a token against KOIN is FREE (mana only): create the TOKEN/KOIN
   market (permissionless — the gateway signs and pays), then place a SELL
   order that escrows only the user's OWN token. The KOIN only ever comes
   from a later buyer. Mainnet only — no orderbook is deployed on testnet. */

/** Price the orderbook wants = human KOIN-per-token × 10^(8 + quoteDec − baseDec).
    KOIN is 8 decimals, so the exponent is (16 − tokenDecimals). Returns an
    integer string; throws if it would round to zero. */
function toDexPrice(humanKoinPerToken, tokenDecimals) {
  const s = String(humanKoinPerToken).trim();
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) <= 0) throw new Error('price must be a positive number');
  const exp = 16 - Number(tokenDecimals);
  if (exp < 0) throw new Error('too many token decimals for a KOIN price');
  const [whole, frac = ''] = s.split('.');
  // shift the decimal point right by `exp`, as integer string math
  const digits = (whole + frac).replace(/^0+(?=\d)/, '');
  const shift = exp - frac.length;
  let out;
  if (shift >= 0) out = BigInt(digits) * (10n ** BigInt(shift));
  else out = BigInt(digits) / (10n ** BigInt(-shift));
  if (out <= 0n) throw new Error('price is too small for this token’s decimals');
  return out.toString();
}

/** The marketId for TOKEN/KOIN if it already exists, else null. */
async function dexMarketId(tokenAddr) {
  const koin = net().koinContract;
  const { result } = await orderbookContract().functions.get_markets({});
  const markets = (result && result.markets) || [];
  for (const m of markets) {
    if (m.baseToken === tokenAddr && m.quoteToken === koin) return Number(m.marketId);
  }
  return null;
}

/** Ensure the TOKEN/KOIN market exists (create it, dev-signed + dev-paid, if
    not) and return its marketId. create_market is permissionless. */
async function ensureDexMarket(tokenAddr) {
  let id = await dexMarketId(tokenAddr);
  if (id != null) return id;
  const { operation } = await orderbookContract(devSigner()).functions.create_market({
    baseToken: tokenAddr, quoteToken: net().koinContract, minBaseAmount: '1',
  }, { onlyOperation: true });
  await devTx([operation]);
  // Read back the id (the create result isn't surfaced through devTx).
  for (let i = 0; i < 3 && id == null; i++) {
    id = await dexMarketId(tokenAddr);
    if (id == null) await new Promise(r => setTimeout(r, 2500));
  }
  if (id == null) throw new Error('market was created but could not be read back — try again');
  return id;
}

/** Ops for a user to LIST `quantityUnits` of their token as a SELL order at
    `priceUnits` (orderbook price units), escrowing only their own token:
    approve(token → orderbook, quantity) + place_order(side=SELL, GTC). */
async function opsDexSell(tokenAddr, owner, marketId, priceUnits, quantityUnits) {
  const token = tokenContractAt(tokenAddr);
  const ob = orderbookContract();
  const { operation: approveOp } = await token.functions.approve(
    { owner, spender: K.dexOrderbook, value: String(quantityUnits) }, { onlyOperation: true });
  const { operation: orderOp } = await ob.functions.place_order({
    owner, marketId, side: 1 /* SELL base for quote */,
    price: String(priceUnits), quantity: String(quantityUnits), flags: 0 /* GTC */,
  }, { onlyOperation: true });
  return [approveOp, orderOp];
}

/** A fresh Koinos account for a launch: { key, address, wif }. The caller
    persists the wif (the token's upgrade authority) BEFORE any on-chain
    work, so a half-completed launch never strands an un-recorded key. */
function newAccount() {
  const key = new Signer({ privateKey: crypto.randomBytes(32).toString('hex') });
  key.provider = provider();
  return { key, address: key.getAddress(), wif: key.getPrivateKey('wif', true) };
}

/** Rehydrate a held account key (token/collection) from its stored WIF. */
function keyFromWif(wif) {
  const key = Signer.fromWif(wif);
  key.provider = provider();
  return key;
}

/** Is this launched token already initialized on-chain? A read, so it
    tells a timed-out-but-mined initialize apart from a real failure. */
async function tokenInitialized(address) {
  try {
    const { result } = await tokenContractAt(address).functions.get_config({});
    return !!(result && result.initialized);
  } catch (_) { return false; }
}

/** Launch a fresh token for `spec.owner` — no visitor signature.
    Two transactions: upload the audited bytecode to `key`'s account, then
    initialize (a contract must exist before it can be called). The key is
    minted and persisted by the caller (see newAccount) and passed in, so
    this function never handles or throws the secret. Returns
    { address, uploadTx, initTx }. */
async function launchToken(spec, wasmBuffer, key) {
  key.provider = provider();
  const address = key.getAddress();

  let uploadTx = null;
  try {
    uploadTx = await sendAsAccount(key, [
      await opUploadContract(address, wasmBuffer),
    ], { rcLimit: K.rcLimitUpload });
  } catch (e) {
    /* A wait-timeout may still have mined. Only give up if the contract
       genuinely isn't there — otherwise fall through to initialize. */
    if (!e.broadcast) throw e;
    uploadTx = e.txId || null;
  }

  /* Initialize as a SEPARATE transaction, retried: right after a big
     upload the node's resource view can be stale and reject the next
     transaction spuriously. A retry after a timed-out-but-mined attempt
     would hit the contract's own "already set up" guard, so treat an
     on-chain initialized flag (or that message) as success. */
  let initTx = null, lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 4000 + attempt * 2000));
    if (await tokenInitialized(address)) { initTx = initTx || 'confirmed'; lastErr = null; break; }
    try {
      initTx = await sendAsAccount(key, [await opTokenInitialize(address, spec)]);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (/already been set up/i.test(String(e.message || e))) { initTx = initTx || 'confirmed'; lastErr = null; break; }
      // e.broadcast (timed out) → next loop re-checks tokenInitialized
    }
  }
  if (lastErr) {
    // No secret on the error: the caller already persisted the key.
    const err = new Error(`token deployed at ${address} but initialize failed: ${lastErr.message || lastErr}`);
    err.address = address;
    err.uploadTx = uploadTx;
    throw err;
  }
  return { address, uploadTx, initTx };
}

/* ---------------- auth ---------------- */

/** Does this signature over `message` belong to `addr`?
    (signMessage = sign(sha256(message)) in koilib.) */
function verifyAuthSignature(message, signatureB64, addr) {
  try {
    const sig = new Uint8Array(Buffer.from(String(signatureB64), 'base64'));
    const hash = new Uint8Array(crypto.createHash('sha256').update(message).digest());
    return Signer.recoverAddress(hash, sig) === addr;
  } catch (_) { return false; }
}

/* ---------------- misc ---------------- */

/** Playground token ids are "DK<n>" in hex — reversible and unique. */
const codeToTokenId = (code) => '0x' + Buffer.from(String(code), 'utf8').toString('hex');
const tokenIdToCode = (hex) => {
  try { return Buffer.from(String(hex).replace(/^0x/, ''), 'hex').toString('utf8'); }
  catch (_) { return null; }
};

module.exports = {
  configure, net, enabled, nftEnabled, dexEnabled, launchpadEnabled, K,
  provider, devSigner, devAddress, isAddr, chainId, sanitizeAbi,
  koinContract, vhpContract, collectionContract, collectionContractAt,
  tokenContractAt, orderbookContract, launchpadContract,
  fromSatsExact, toUnits, fromUnits,
  koinBalance, mana, headInfo, supplies,
  collectionInfo, collectionSupply, tokensOfOwner, nftOwner, nftMetadata,
  tokenInfoAt, tokenBalanceAt,
  opKoinTransfer, opNftMint, opNftSetMetadata, opNftTransfer,
  opTokenTransfer, opTokenMint, opTokenBurn, opUploadContract, opTokenInitialize,
  devTx, sendAsAccount, prepareUserTx, submitCosigned, queueTx,
  mintNft, mintToCollection, mintManyToCollection, launchToken, launchCollection, newAccount, keyFromWif,
  humanChainError,
  tokenInitialized, collectionInitializedAt, allCollectionTokens,
  toDexPrice, dexMarketId, ensureDexMarket, opsDexSell,
  verifyAuthSignature, codeToTokenId, tokenIdToCode,
  COLLECTION_ABI, TOKEN_ABI, KOIN_ABI, ORDERBOOK_ABI, LAUNCHPAD_ABI,
};
