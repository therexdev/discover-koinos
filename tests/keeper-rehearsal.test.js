'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Serializer, utils } = require('koilib');
const { createHarbingerRehearsalDex, HARBINGER_CHAIN_ID, PERIPHERY_B58, getPair, createPair } = require('../tools/koindx');
const { run, validateConfig, assertAllowedOperations, refreshPendingRecords, METHODS } = require('../scripts/rehearse-keeper');

const ADDRESS = '1BZwunANbBd57rYrDMPybNAscyDV7fw8rY';
const HASH = 'a835153f9259c73bc35cc4fd22027402fb2e3891d450f22d1719b4419c875fdf';
const config = () => ({ schemaVersion: 1, network: 'harbinger', chainId: HARBINGER_CHAIN_ID,
  rpc: 'https://testnet.koinosfoundation.org/jsonrpc', launchId: 5, protectedLaunchId: 3,
  ...Object.fromEntries(['launchpad', 'metadataReader', 'router', 'pair', 'creator', 'buyer', 'saleToken', 'payer'].map(k => [k, ADDRESS])),
  sha256: Object.fromEntries(['launchpad', 'metadataReader', 'router', 'pair'].map(k => [k, HASH])),
  keysFile: '/private/keys.json', protectedLaunchFile: '/private/protected.json', pendingFile: '/private/pending.json', reportFile: '/private/report.json', keyRole: 'payer',
  expectedLaunch: { id: 5, creator: ADDRESS, token: ADDRESS, mode: 0, forSaleAmount: '10000000', price: '100000000' },
});

test('production KoinDX calls cannot borrow the mainnet router or pool candidates on testnet', async () => {
  const chain = { K: { network: 'harbinger' } };
  await assert.rejects(getPair(chain, ADDRESS), /requires mainnet/);
  await assert.rejects(createPair(chain, ADDRESS), /requires mainnet/);
});

test('rehearsal router must be explicit, pinned and separate from mainnet', () => {
  for (const options of [{}, { router: PERIPHERY_B58, routerSha256: HASH, readMetadata: async () => ({}) },
    { router: ADDRESS, routerSha256: '', readMetadata: async () => ({}) }]) {
    assert.throws(() => createHarbingerRehearsalDex(options), /explicit router/);
  }
});

test('rehearsal adapter freshly validates chain and router metadata and refuses pool creation', async () => {
  let network = 'harbinger', chainId = HARBINGER_CHAIN_ID, reads = 0;
  let metadata = { hash: Buffer.from('1220' + HASH, 'hex').toString('base64url') };
  const chain = { get K() { return { network }; }, provider: () => ({ getChainId: async () => { reads++; return chainId; } }) };
  const dex = createHarbingerRehearsalDex({ router: ADDRESS, routerSha256: HASH, readMetadata: async () => metadata });
  await dex.verify(chain); await dex.verify(chain); assert.equal(reads, 2);
  network = 'mainnet'; await assert.rejects(dex.verify(chain), /pinned Harbinger/);
  network = 'harbinger'; chainId = 'mainnet'; await assert.rejects(dex.verify(chain), /pinned Harbinger/);
  chainId = HARBINGER_CHAIN_ID;
  metadata = { hash: 'invalid' }; await assert.rejects(dex.verify(chain), /metadata/);
  for (const flag of ['system', 'authorizesCall', 'authorizesTransaction', 'authorizesUpload']) {
    metadata = { hash: Buffer.from('1220' + HASH, 'hex').toString('base64url'), [flag]: true };
    await assert.rejects(dex.verify(chain), /metadata/);
  }
  await assert.rejects(dex.createPair(chain), /existing pinned pool only/);
});

test('live harness refuses other networks, old launches, shared output/input paths and excess value', () => {
  assert.equal(validateConfig(config()).launchId, 5);
  const mutations = [c => { c.network = 'mainnet'; }, c => { c.rpc = 'https://api.koinos.io'; },
    c => { c.launchId = 3; }, c => { c.router = PERIPHERY_B58; },
    c => { c.reportFile = c.keysFile; }, c => { c.pendingFile = c.protectedLaunchFile; },
    c => { c.expectedLaunch.forSaleAmount = '10000001'; }, c => { c.keyRole = 'owner'; },
    c => { c.sha256.pair = ''; }, c => { c.expectedLaunch.creator = 'someone-else'; }];
  for (const mutate of mutations) { const c = config(); mutate(c); assert.throws(() => validateConfig(c)); }
});

test('live submission guard permits only bounded keeper calls for launch5', async () => {
  const codec = new Serializer({ nested: { Args: { fields: { launchId: { type: 'uint64', id: 1 }, limit: { type: 'uint32', id: 2 } } } } });
  const c = config();
  const op = async (action, launchId = 5, limit = 20) => ({ call_contract: { contract_id: ADDRESS,
    entry_point: METHODS[action], args: utils.encodeBase64url(await codec.serialize({ launchId: String(launchId), limit: action === 'process' ? limit : undefined }, 'Args')) } });
  for (const action of Object.keys(METHODS)) assert.equal(await assertAllowedOperations([await op(action)], c), action);
  await assert.rejects(assertAllowedOperations([await op('finalize', 3)], c), /another launch/);
  await assert.rejects(assertAllowedOperations([await op('process', 5, 30)], c));
  await assert.rejects(assertAllowedOperations([{ upload_contract: {} }], c), /uploads/);
  await assert.rejects(assertAllowedOperations([await op('finalize'), await op('process')], c), /single keeper/);
  const wrong = await op('finalize'); wrong.call_contract.contract_id = PERIPHERY_B58;
  await assert.rejects(assertAllowedOperations([wrong], c));
  const transfer = await op('finalize'); transfer.call_contract.entry_point = 0x27f576ca;
  await assert.rejects(assertAllowedOperations([transfer], c), /entry point/);
});

test('normalized output aliases cannot overwrite the private config or another input', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-path-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  for (const output of ['reportFile', 'pendingFile']) {
    const c = config();
    c[output] = dir + '/unused/../config.json';
    const contents = JSON.stringify(c);
    fs.writeFileSync(file, contents);
    await assert.rejects(run(file), /config cannot be an output/);
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
  }
  const c = config(); c.reportFile = '/private/unused/../keys.json';
  assert.throws(() => validateConfig(c), /separate files/);
});

test('later cycles refresh pending evidence without clearing reservations or rereading resolved records', async () => {
  const report = { transactions: [
    { txId: 'included', status: 'pending', action: 'finalize' },
    { txId: 'reverted', status: 'pending', action: 'process' },
    { txId: 'unreadable', status: 'pending', action: 'provide_liquidity' },
    { txId: 'done', status: 'confirmed', action: 'claim_liquidity' },
  ] };
  const reads = [];
  await refreshPendingRecords(report, async txId => {
    reads.push(txId);
    if (txId === 'unreadable') throw new Error('offline');
    return { txId, status: txId === 'included' ? 'confirmed' : 'reverted', blockNumber: 100, blockId: 'canonical' };
  });
  assert.deepEqual(reads, ['included', 'reverted', 'unreadable']);
  assert.deepEqual(report.transactions.map(t => t.status), ['confirmed', 'reverted', 'pending', 'confirmed']);
  assert.equal(report.transactions[0].action, 'finalize');
});
