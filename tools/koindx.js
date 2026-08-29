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

   The official bytecode is not vendored in this repo. Every live pool
   already carries it — hash-verified the day it was created — so we read
   the creation transaction of the KOIN/VHP pool (its very first
   account-history entry), extract the uploaded bytecode, and cache it in
   DATA_DIR. If KoinDX ever rotates the pinned bytecode, our create_pair
   reverts with KOINDX: INVALID_HASH; deleting the cache file after
   pointing SOURCE_TOKEN_B at a pool created under the new pin fixes it.

   The fresh pool key is throwaway BY DESIGN: the periphery requires the
   upload to set all three authorizes_* overrides, which hands authority
   to the pool contract itself the moment it lands — after that block the
   key can neither upgrade the pool nor touch its funds.
   ============================================================ */
'use strict';

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
const CACHE_FILE = path.join(DATA_DIR, 'koindx-pool.wasm');

/* KoinDX periphery (mainnet) — the same address the launchpad contract
   calls for add_liquidity, from @koindx/v2-sdk. */
const PERIPHERY_B58 = '17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s';

let _bytecode = null; // Buffer, memoized

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
    tokenA: chain.net().koinContract,
    tokenB: tokenB58,
  });
  const value = result && result.value;
  return value && String(value).length ? String(value) : null;
}

/** The official pool bytecode, from cache or from the source pool's
    creation transaction on-chain. */
async function poolBytecode(chain, log) {
  if (_bytecode) return _bytecode;
  try {
    const cached = fs.readFileSync(CACHE_FILE);
    if (cached.length > 10000) {
      _bytecode = cached;
      return _bytecode;
    }
  } catch (_) {}

  // the KOIN/VHP pool has existed since KoinDX launched and its first
  // account-history entry is the 2-op creation transaction we mirror
  const sourceToken = chain.net().vhpContract;
  const sourcePair = await getPair(chain, sourceToken);
  if (!sourcePair) throw new Error('KoinDX KOIN/VHP pool not found - cannot learn the pool bytecode');

  const history = await chain.provider().call('account_history.get_account_history', {
    address: sourcePair,
    limit: 10,
    ascending: true,
  });
  const entries = (history && history.values) || [];
  for (const entry of entries) {
    const ops =
      (entry.trx && entry.trx.transaction && entry.trx.transaction.operations) || [];
    for (const op of ops) {
      if (op.upload_contract && op.upload_contract.bytecode) {
        const wasm = Buffer.from(utils.decodeBase64url(op.upload_contract.bytecode));
        if (wasm.length > 10000) {
          const digest = crypto.createHash('sha256').update(wasm).digest('hex');
          if (log) log(`koindx:   learned pool bytecode from ${sourcePair} (${wasm.length} bytes, sha256 ${digest.slice(0, 16)}…)`);
          try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(CACHE_FILE, wasm);
          } catch (_) {}
          _bytecode = wasm;
          return _bytecode;
        }
      }
    }
  }
  throw new Error(`no upload_contract found in the first history entries of pool ${sourcePair}`);
}

/** Create the KOIN/token pool: upload the official bytecode to a fresh
    throwaway account + create_pair, in the one 2-op transaction the
    periphery demands. Sponsor pays the mana. Returns { pair, txId }. */
async function createPair(chain, tokenB58, log) {
  const bytecode = await poolBytecode(chain, log);
  const poolKey = new Signer({ privateKey: crypto.randomBytes(32).toString('hex') });

  const uploadOp = await chain.opUploadContract(poolKey.getAddress(), bytecode, {
    contractAuthority: true,
  });
  const { operation: createOp } = await peripheryContract(chain, poolKey).functions.create_pair(
    { tokenA: chain.net().koinContract, tokenB: tokenB58 },
    { onlyOperation: true }
  );

  const txId = await chain.sendAsAccount(poolKey, [uploadOp, createOp], {
    rcLimit: chain.K.rcLimitUpload,
  });

  const pair = await getPair(chain, tokenB58);
  if (!pair) throw new Error(`create_pair mined (${txId}) but the pool is still missing`);
  return { pair, txId };
}

module.exports = { getPair, createPair, poolBytecode, PERIPHERY_B58 };
