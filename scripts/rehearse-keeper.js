#!/usr/bin/env node
'use strict';

// One manual cycle of the actual keeper and transaction facade, restricted
// to one NEW isolated Harbinger launch. No server, timers or deployment.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Serializer, utils } = require('koilib');
const chain = require('../tools/koinos');
const { createLaunchpadKeeper } = require('../tools/launchpad-keeper');
const { createHarbingerRehearsalDex, HARBINGER_CHAIN_ID, PERIPHERY_B58 } = require('../tools/koindx');

const METHODS = Object.freeze({
  finalize: 3264789715, process: 434979007, claim_locked: 3596177968,
  provide_liquidity: 664964575, claim_liquidity: 2109732178,
});
const codec = new Serializer({ nested: {
  Address: { fields: { value: { type: 'bytes', id: 1 } } },
  Args: { fields: { launchId: { type: 'uint64', id: 1 }, limit: { type: 'uint32', id: 2 } } },
  Metadata: { fields: { hash: { type: 'bytes', id: 1 }, system: { type: 'bool', id: 2 },
    authorizesCall: { type: 'bool', id: 3 }, authorizesTransaction: { type: 'bool', id: 4 }, authorizesUpload: { type: 'bool', id: 5 } } },
} });

function validateConfig(c) {
  assert.equal(c.schemaVersion, 1);
  assert.equal(c.network, 'harbinger');
  assert.equal(c.chainId, HARBINGER_CHAIN_ID);
  assert.equal(c.rpc, 'https://testnet.koinosfoundation.org/jsonrpc');
  assert.ok(Number.isSafeInteger(c.launchId) && c.launchId >= 5, 'use a new launch, never a prior rehearsal position');
  assert.equal(c.protectedLaunchId, 3);
  for (const key of ['launchpad', 'metadataReader', 'router', 'pair', 'creator', 'buyer', 'saleToken', 'payer']) {
    assert.ok(chain.isAddr(c[key]), `invalid ${key}`);
  }
  assert.notEqual(c.router, PERIPHERY_B58);
  for (const key of ['launchpad', 'metadataReader', 'router', 'pair']) {
    assert.match(c.sha256?.[key] || '', /^[a-f0-9]{64}$/, `missing ${key} pin`);
  }
  for (const key of ['keysFile', 'protectedLaunchFile', 'pendingFile', 'reportFile']) {
    assert.ok(path.isAbsolute(c[key] || ''), `${key} must be absolute`);
    c[key] = path.resolve(c[key]);
  }
  assert.equal(new Set([c.keysFile, c.protectedLaunchFile, c.pendingFile, c.reportFile].map(p => path.resolve(p))).size, 4,
    'private inputs, pending journal and report must be separate files');
  assert.equal(c.keyRole, 'payer');
  assert.equal(c.expectedLaunch?.creator, c.creator);
  assert.equal(c.expectedLaunch?.token, c.saleToken);
  assert.equal(c.expectedLaunch?.id, c.launchId);
  assert.equal(c.expectedLaunch?.mode, 0);
  assert.ok(BigInt(c.expectedLaunch?.forSaleAmount || '0') > 0n);
  assert.ok(BigInt(c.expectedLaunch?.price || '0') > 0n);
  assert.ok(BigInt(c.expectedLaunch.forSaleAmount) * BigInt(c.expectedLaunch.price) / 100000000n <= 10000000n,
    'isolated launch is capped at 0.1 tKOIN');
  return c;
}

async function assertAllowedOperations(operations, c) {
  assert.equal(operations.length, 1, 'only a single keeper action is permitted');
  const operation = operations[0];
  assert.deepEqual(Object.keys(operation), ['call_contract'], 'uploads/transfers cannot be sent by this harness');
  const call = operation.call_contract;
  assert.equal(call.contract_id, c.launchpad);
  const action = Object.keys(METHODS).find(name => METHODS[name] === call.entry_point);
  assert.ok(action, 'unexpected keeper entry point');
  const args = await codec.deserialize(call.args, 'Args');
  assert.equal(Number(args.launchId), c.launchId, 'keeper action targets another launch');
  if (action === 'process') assert.equal(Number(args.limit), 20);
  return action;
}

function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'w', 0o600);
    fs.writeFileSync(fd, JSON.stringify(report, null, 2) + '\n');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

async function refreshPendingRecords(report, readOutcome) {
  for (const record of report.transactions.filter(record => record.status === 'pending')) {
    // Receipt reconciliation is read-only; the production keeper remains
    // the sole owner of its nonce reservation and clears it itself.
    try { Object.assign(record, await readOutcome(record.txId)); }
    catch (_) { /* an unreadable outcome remains pending */ }
  }
}

async function run(configFile, { readOnly = false } = {}) {
  assert.ok(path.isAbsolute(configFile || ''), 'config path must be absolute');
  configFile = path.resolve(configFile);
  const c = validateConfig(JSON.parse(fs.readFileSync(configFile, 'utf8')));
  assert.ok(![c.pendingFile, c.reportFile].includes(path.resolve(configFile)), 'config cannot be an output file');
  const wif = JSON.parse(fs.readFileSync(c.keysFile, 'utf8'))[c.keyRole];
  chain.configure({ network: 'harbinger', rpcs: [c.rpc], devWif: wif,
    launchpadAddr: c.launchpad, dexOrderbook: '', keeperPendingFile: c.pendingFile, rcLimit: '500000000' });
  assert.equal(chain.devAddress(), c.payer, 'sponsor key does not match the expected isolated payer');
  const protectedLaunch = JSON.parse(fs.readFileSync(c.protectedLaunchFile, 'utf8'));
  const binding = { network: c.network, chainId: c.chainId, launchpad: c.launchpad, launchId: c.launchId, payer: c.payer };
  let report = { schemaVersion: 1, testOnly: true, mode: 'local-production-modules', binding, transactions: [], cycles: [] };
  if (fs.existsSync(c.reportFile)) {
    report = JSON.parse(fs.readFileSync(c.reportFile, 'utf8'));
    assert.deepEqual(report.binding, binding, 'report belongs to another rehearsal');
  }
  const launch = async id => (await chain.launchpadContract().functions.get_launch({ launchId: id })).result?.value;
  const metadata = async address => {
    const args = utils.encodeBase64url(await codec.serialize({ value: utils.encodeBase64url(utils.decodeBase58(address)) }, 'Address'));
    const response = await chain.provider().readContract({ contract_id: c.metadataReader, entry_point: 0x10000003, args });
    return codec.deserialize(response.result, 'Metadata');
  };
  const dex = createHarbingerRehearsalDex({ router: c.router, routerSha256: c.sha256.router, readMetadata: metadata });
  async function verify() {
    assert.equal(await chain.provider().getChainId(), HARBINGER_CHAIN_ID);
    for (const role of ['metadataReader', 'launchpad', 'router', 'pair']) {
      const meta = await metadata(c[role]);
      assert.equal(Buffer.from(meta.hash || '', 'base64url').toString('hex'), '1220' + c.sha256[role], `${role} bytecode changed`);
      assert.ok(!meta.system, `${role} must not be a system contract`);
      for (const flag of ['authorizesCall', 'authorizesTransaction', 'authorizesUpload']) {
        assert.equal(!!meta[flag], role === 'pair', `${role} authority changed`);
      }
    }
    assert.equal(await dex.getPair(chain, c.saleToken), c.pair, 'router pair changed');
    assert.deepEqual(await launch(c.protectedLaunchId), protectedLaunch, 'seven-day reclaim launch changed');
    const active = await launch(c.launchId);
    assert.ok(active, 'new rehearsal launch missing');
    for (const [field, value] of Object.entries(c.expectedLaunch)) {
      // The node omits protobuf's zero-valued fixed-sale enum.
      assert.deepEqual(field === 'mode' ? (active[field] ?? 0) : active[field], value, `launch field ${field} changed`);
    }
    return active;
  }

  const before = await verify();
  if (readOnly) return { testOnly: true, mode: 'read-only', binding, launch: before, protectedLaunchUnchanged: true };
  await refreshPendingRecords(report, chain.transactionOutcome);
  const cycle = { startedAt: new Date().toISOString(), before, logs: [] };
  report.cycles.push(cycle);
  writeReport(c.reportFile, report);
  const restricted = Object.create(chain);
  restricted.launchpadContract = signer => {
    const real = chain.launchpadContract(signer);
    return { ...real, functions: { ...real.functions,
      get_launches: async () => ({ result: { launches: [await launch(c.launchId)] } }),
    } };
  };
  restricted.devTx = async (operations, options) => {
    const action = await assertAllowedOperations(operations, c);
    let record;
    try {
      const id = await chain.devTx(operations, { ...options, beforeSend: async prepared => {
        const current = await verify();
        if (action === 'claim_locked' || action === 'claim_liquidity') {
          const head = await chain.provider().getHeadInfo();
          const due = action === 'claim_locked' ? current.unlockTime : current.lpUnlockTime;
          assert.ok(BigInt(head.head_block_time) >= BigInt(due), 'actual chain time has not reached the lock deadline');
        }
        await options.beforeSend(prepared); // actual production durable nonce reservation
        record = { txId: prepared.txId, action, preparedAt: new Date().toISOString(), status: 'pending' };
        report.transactions.push(record); writeReport(c.reportFile, report);
      } });
      Object.assign(record, await chain.transactionOutcome(id));
      writeReport(c.reportFile, report);
      return id;
    } catch (error) {
      if (record) {
        record.status = error.rejected ? 'rejected' : error.reverted ? 'reverted' : 'pending';
        record.error = error.message; writeReport(c.reportFile, report);
      }
      throw error;
    }
  };
  restricted.sendAsAccount = async () => { throw new Error('rehearsal pool uploads are forbidden'); };
  const keeper = createLaunchpadKeeper({ chain: restricted, koindx: dex, pendingFile: c.pendingFile,
    manaFloor: 6, log: message => { cycle.logs.push(message); } });
  await keeper.cycle();
  cycle.after = await verify();
  cycle.finishedAt = new Date().toISOString();
  cycle.protectedLaunchUnchanged = true;
  cycle.pending = fs.existsSync(c.pendingFile) ? JSON.parse(fs.readFileSync(c.pendingFile, 'utf8')).launches : {};
  writeReport(c.reportFile, report);
  return { testOnly: true, binding, cycle, transactions: report.transactions.map(({ txId, action, status, blockId, blockNumber }) => ({ txId, action, status, blockId, blockNumber })) };
}

module.exports = { run, validateConfig, assertAllowedOperations, refreshPendingRecords, METHODS };
if (require.main === module) {
  run(process.argv[2], { readOnly: process.argv[3] === '--check' })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
