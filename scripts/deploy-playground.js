#!/usr/bin/env node
/* Deploy the playground NFT collection for the Discover Koinos gateway.

   Idempotent: run it again and it re-checks each step before acting.
     1. upload the audited collection bytecode to the COLLECTION account
     2. initialize it (name/symbol/owner = the dev wallet)
   Both transactions are paid by the DEV wallet's mana.

   Usage:
     node scripts/deploy-playground.js [gateway.env]     # default network: harbinger
     KOINOS_NETWORK=mainnet node scripts/deploy-playground.js gateway.env

   Reads GATEWAY_DEV_WIF and GATEWAY_COLLECTION_WIF from the env file
   (made by tools/keygen.js) or from the environment.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { Signer, Provider, Contract, Transaction, utils } = require('koilib');
const { pickRpcs, NETWORKS } = require('../tools/rpc');

const NETWORK = process.env.KOINOS_NETWORK || 'harbinger';
const COLLECTION_NAME = process.env.PLAYGROUND_NAME || 'Discover Koinos Paint';
const COLLECTION_SYMBOL = process.env.PLAYGROUND_SYMBOL || 'PAINT';

function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function sanitizeAbi(abi) {
  const out = JSON.parse(JSON.stringify(abi));
  const koinos = out.koilib_types?.nested?.koinos?.nested;
  if (koinos) { delete koinos.btype; delete koinos._btype; }
  return out;
}

(async () => {
  loadEnvFile(process.argv[2] || 'gateway.env');
  const devWif = process.env.GATEWAY_DEV_WIF;
  const colWif = process.env.GATEWAY_COLLECTION_WIF;
  if (!devWif || !colWif) {
    console.error('GATEWAY_DEV_WIF and GATEWAY_COLLECTION_WIF are required — run tools/keygen.js first.');
    process.exit(1);
  }

  const net = NETWORKS[NETWORK];
  const provider = new Provider(await pickRpcs(NETWORK));
  const dev = Signer.fromWif(devWif); dev.provider = provider;
  const col = Signer.fromWif(colWif); col.provider = provider;
  const colAddr = col.getAddress();
  console.log(`network:    ${net.label}`);
  console.log(`dev:        ${dev.getAddress()}`);
  console.log(`collection: ${colAddr}`);

  const wasmPath = path.join(__dirname, '..', 'contracts', 'prebuilt', 'collection', 'contract.wasm');
  const abiPath = path.join(__dirname, '..', 'server-abi', 'collection-abi.json');
  const wasm = fs.readFileSync(wasmPath);
  const abi = sanitizeAbi(JSON.parse(fs.readFileSync(abiPath)));

  /* Preflight the mana budget from live chain prices — a contract upload
     is disk-priced, and failing halfway wastes the day's recharge. */
  const availableMana = Number(await provider.getAccountRc(dev.getAddress())) / 1e8;
  const { resource_limit_data: limits } = await provider.call('chain.get_resource_limits', {});
  const storedBytes = wasm.length + 2048;
  const estimate =
    (storedBytes * Number(limits.disk_storage_cost) +
      (storedBytes + 2048) * Number(limits.network_bandwidth_cost)) / 1e8 + 2;
  console.log(`mana:       ${availableMana.toFixed(1)} available, ~${estimate.toFixed(1)} needed`);
  if (availableMana < estimate && process.env.FORCE !== '1') {
    console.error(`\nNot enough mana. Fund ${dev.getAddress()} with ${net.nativeSymbol} first` +
      (net.faucets[0] ? `\n  ${net.faucets[0].name}: ${net.faucets[0].note}` : '') +
      `\n(Re-run with FORCE=1 to try anyway — a re-upload over an existing contract costs much less.)`);
    process.exit(1);
  }

  const contract = new Contract({ id: colAddr, provider, abi });

  /* Step 1 — upload, unless the account already answers get_info. */
  let deployed = false;
  try { await contract.functions.get_info({}); deployed = true; } catch (_) {}
  if (deployed) {
    console.log('upload:     already deployed — skipping');
  } else {
    const tx = new Transaction({
      signer: col, provider,
      options: { payer: dev.getAddress(), payee: colAddr, rcLimit: String(80e8) },
    });
    await tx.pushOperation({
      upload_contract: {
        contract_id: colAddr,
        /* koilib's own encoder, NOT Buffer.toString('base64url'): the
           node's JSON codec wants PADDED base64url. */
        bytecode: utils.encodeBase64url(wasm),
      },
    });
    await tx.prepare();
    await tx.sign();                        // the collection authorizes its own upload
    await dev.signTransaction(tx.transaction);  // the dev wallet pays
    const send = new Transaction({ provider });
    send.transaction = tx.transaction;
    await send.send();
    console.log(`upload:     ${tx.transaction.id} — waiting to be mined…`);
    await send.wait('byTransactionId', 90000);
    console.log('upload:     mined');
  }

  /* Step 2 — initialize, unless it already has a name. A separate
     transaction: the contract must exist before it can be called, and
     right after a big upload the node's resource view can be stale, so
     retry a few times. */
  let initialized = false;
  try {
    const { result } = await contract.functions.get_info({});
    initialized = !!(result && result.name && result.name !== 'Uninitialized collection');
    if (initialized) console.log(`initialize: already done — "${result.name}" (${result.symbol})`);
  } catch (_) {}
  if (!initialized) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) { console.log(`initialize: retrying (${attempt + 1}/3)…`); await new Promise(r => setTimeout(r, 5000)); }
      try {
        /* koilib only signs with the CONSTRUCTOR's signer — a per-call
           signer option is silently ignored, so build a signed handle. */
        const asCollection = new Contract({ id: colAddr, provider, abi, signer: col });
        const { transaction } = await asCollection.functions.initialize({
          name: COLLECTION_NAME, symbol: COLLECTION_SYMBOL,
          uri: '', description: 'Pixel art minted first-hand by Koinos newcomers at the Discover Koinos gateway.',
          owner: dev.getAddress(), royalty_bps: '0', royalty_address: dev.getAddress(),
        }, {
          payer: dev.getAddress(), payee: colAddr, rcLimit: String(5e8),
          beforeSend: async (t) => { await dev.signTransaction(t); },
        });
        console.log(`initialize: ${transaction.id} — waiting to be mined…`);
        await transaction.wait('byTransactionId', 90000);
        lastErr = null;
        break;
      } catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;
    console.log('initialize: mined');
  }

  console.log(`\nDone. Server environment:
  KOINOS_NETWORK=${NETWORK}
  GATEWAY_DEV_WIF=<from your env file>
  GATEWAY_COLLECTION_WIF=<from your env file>
  GATEWAY_COLLECTION_ADDR=${colAddr}
Explorer: ${net.explorer}/address/${colAddr}`);
})().catch((e) => { console.error('\nFAILED:', e.message || e); process.exit(1); });
