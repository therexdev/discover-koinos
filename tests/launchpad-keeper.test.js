'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLaunchpadKeeper } = require('../tools/launchpad-keeper');
const { createPendingStore } = require('../tools/keeper-pending');

function fixture(t, launch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pendingFile = path.join(dir, 'pending.json');
  const f = {
    pendingFile, log: [], sent: [], reads: [], available: 100, serial: 0,
    launch: { id: 1, status: 0, mode: 0, endTime: 0, token: 'sale-token', ...launch },
    outcome: { status: 'pending' },
    effect(action) {
      if (action === 'finalize') this.launch.status = 1;
      if (action === 'claim_locked') this.launch.lockedClaimed = true;
      if (action === 'provide_liquidity') this.launch.liquidityState = 2;
      if (action === 'claim_liquidity') this.launch.lpClaimed = true;
    },
  };
  const functions = {
    get_launches: async () => { f.reads.push('launches'); return { result: { launches: [{ ...f.launch }, ...(f.otherLaunches || [])] } }; },
    get_launch: async () => { f.reads.push('fresh'); return { result: { value: { ...f.launch } } }; },
  };
  for (const action of ['finalize', 'process', 'claim_locked', 'provide_liquidity', 'claim_liquidity']) {
    functions[action] = async () => ({ operation: { action } });
  }
  async function send(ops, options) {
    const txId = `test-tx-${++f.serial}`;
    if (f.beforeQueue) await f.beforeQueue();
    await options.beforeSend({ txId });
    assert.equal(JSON.parse(fs.readFileSync(pendingFile, 'utf8')).launches['1'].txId, txId,
      'pending ID must reach disk before broadcast');
    const action = ops[0].action;
    f.sent.push({ action, txId });
    if (f.sendFailure) throw f.sendFailure;
    f.effect(action);
    return txId;
  }
  f.chain = {
    K: { network: 'harbinger', launchpadAddr: 'launchpad' },
    chainId: async () => 'chain-id', devAddress: () => 'payer', devSigner: () => ({}),
    launchpadEnabled: () => true, dexEnabled: () => false,
    launchpadContract: () => ({ functions }),
    mana: async () => { if (f.manaFailure) throw new Error('offline'); return f.available; },
    devTx: send, sendAsAccount: async (_key, ops, options) => send(ops, options),
    transactionOutcome: async id => { f.reads.push(id); return f.outcome; },
    ensureDexMarket: async (_token, options) => send([{ action: 'create_market' }], options),
  };
  f.dex = { getPair: async () => 'existing-pair' };
  f.keeper = () => createLaunchpadKeeper({ chain: f.chain, pendingFile, koindx: f.dex, log: m => f.log.push(m) });
  return f;
}

test('first transaction is blocked below floor or on unreadable mana; recharge resumes without backoff', async t => {
  const f = fixture(t);
  const keeper = f.keeper();
  f.available = 0;
  await keeper.cycle();
  f.available = 100; f.manaFailure = true;
  await keeper.cycle();
  assert.equal(f.sent.length, 0);
  assert.equal(fs.existsSync(f.pendingFile), false);
  f.manaFailure = false;
  await keeper.cycle();
  assert.deepEqual(f.sent.map(s => s.action), ['finalize']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.pendingFile)).launches, {});
});

test('mana consumed while waiting for the signing queue prevents submission', async t => {
  const f = fixture(t);
  f.beforeQueue = async () => { f.available = 0; };
  await f.keeper().cycle();
  assert.equal(f.sent.length, 0);
});

test('each process batch and subsequent creator/market/liquidity step checks current mana', async t => {
  const f = fixture(t, { status: 1, buyerCount: 40, cursor: 0 });
  f.effect = function () { this.launch.cursor = 20; this.available = 0; };
  await f.keeper().cycle();
  assert.deepEqual(f.sent.map(s => s.action), ['process']);
  const g = fixture(t, { status: 2, lockedAmount: '10', unlockTime: 0, liquidityState: 1, liquidityKoin: '10' });
  g.chain.dexEnabled = () => true;
  g.effect = function () { this.launch.lockedClaimed = true; this.available = 0; };
  await g.keeper().cycle();
  assert.deepEqual(g.sent.map(s => s.action), ['claim_locked']);
  assert.equal(g.log.some(s => s.includes('liquidity added')), false);
});

test('market, liquidity provision and LP claim cannot submit as first action below the floor', async t => {
  for (const action of ['create_market', 'provide_liquidity', 'claim_liquidity']) {
    const f = fixture(t, { status: 2,
      liquidityState: action === 'provide_liquidity' ? 1 : action === 'claim_liquidity' ? 2 : 0,
      liquidityKoin: '10', lpAmount: '10', lpUnlockTime: 0 });
    f.chain.dexEnabled = () => action === 'create_market';
    f.available = 0;
    const keeper = f.keeper();
    await keeper.cycle();
    assert.equal(f.sent.length, 0, action);
    f.available = 100;
    await keeper.cycle();
    assert.deepEqual(f.sent.map(s => s.action), [action]);
  }
});

test('pool candidate retries recheck the higher upload floor before every send', async t => {
  const f = fixture(t, { status: 2, liquidityState: 1, liquidityKoin: '10' });
  f.dex.getPair = async () => null;
  f.dex.createPair = async chain => {
    try { await chain.sendAsAccount({}, [{ action: 'create_pair' }], { rcLimit: 'upload-limit' }); }
    catch (e) { assert.equal(e.rejected, true); }
    f.available = 84;
    await chain.sendAsAccount({}, [{ action: 'create_pair' }], { rcLimit: 'upload-limit' });
    assert.fail('second candidate must pause before broadcast');
  };
  f.sendFailure = Object.assign(new Error('KOINDX: INVALID_HASH'), { rejected: true });
  await f.keeper().cycle();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.pendingFile)).launches, {});
  assert.equal(f.log.some(s => s.includes('pool created')), false);
});

test('ambiguous outcome survives next cycle and restart; confirmation rereads state before advancing', async t => {
  const f = fixture(t);
  f.sendFailure = Object.assign(new Error('confirmation timed out'), { pending: true, broadcast: true });
  const keeper = f.keeper();
  await keeper.cycle();
  await keeper.cycle();
  const restarted = f.keeper();
  await restarted.cycle();
  assert.equal(f.sent.length, 1, 'must never replace unresolved transaction');
  assert.equal(f.log.some(s => s.includes(' finalized')), false);
  assert.equal(JSON.parse(fs.readFileSync(f.pendingFile)).launches['1'].txId, 'test-tx-1');
  // Reconciliation must precede the launch read used to build any action.
  f.chain.transactionOutcome = async () => {
    f.launch.status = 2; f.sendFailure = null;
    return { status: 'confirmed', blockId: 'canonical-block' };
  };
  await restarted.cycle();
  assert.equal(f.sent.length, 1);
  assert.equal(f.reads.at(-1), 'launches');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.pendingFile)).launches, {});
});

test('canonical revert is failure, clears pending, and cannot advance settlement or log success', async t => {
  const f = fixture(t, { status: 1, buyerCount: 40, cursor: 0 });
  f.sendFailure = Object.assign(new Error('reverted'), { confirmed: true, reverted: true, broadcast: true });
  const keeper = f.keeper();
  await keeper.cycle();
  await keeper.cycle();
  assert.deepEqual(f.sent.map(s => s.action), ['process']);
  assert.deepEqual(f.reads, ['launches', 'launches']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.pendingFile)).launches, {});
  assert.equal(f.log.some(s => s.includes('fully paid') || s.includes('batch done')), false);
});

test('pending market stops later liquidity; RPC failure and reconciled revert never replace it', async t => {
  const f = fixture(t, { status: 2, liquidityState: 1, liquidityKoin: '10' });
  f.chain.dexEnabled = () => true;
  f.sendFailure = Object.assign(new Error('lost response'), { pending: true });
  const keeper = f.keeper();
  await keeper.cycle();
  f.chain.transactionOutcome = async () => { throw new Error('RPC unavailable'); };
  await keeper.cycle();
  assert.deepEqual(f.sent.map(s => s.action), ['create_market']);
  f.chain.transactionOutcome = async () => ({ status: 'reverted', blockId: 'canonical' });
  await keeper.cycle();
  await keeper.cycle();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.pendingFile)).launches, {});
});

test('journal corruption or changed chain/payer prevents all sends', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.pendingFile, '{broken');
  await f.keeper().cycle();
  assert.equal(f.sent.length, 0);
  fs.writeFileSync(f.pendingFile, JSON.stringify({ version: 1, binding: { network: 'another-chain' }, launches: {} }));
  await f.keeper().cycle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.log.some(s => s.includes('binding')), true);
});

test('pre-broadcast journal record blocks automatic replacement after restart', async t => {
  const f = fixture(t);
  const store = createPendingStore(f.pendingFile, {
    network: 'harbinger', chainId: 'chain-id', launchpad: 'launchpad', payer: 'payer',
  });
  store.set(1, { txId: 'crashed-before-send', action: 'finalize', createdAt: new Date().toISOString() });
  await f.keeper().cycle();
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.reads, ['crashed-before-send']);
});

test('pending transaction blocks another launch sharing the keeper nonce, including after restart', async t => {
  const f = fixture(t);
  f.otherLaunches = [{ ...f.launch, id: 2 }];
  f.sendFailure = Object.assign(new Error('confirmation unknown'), { pending: true });
  await f.keeper().cycle();
  assert.equal(f.sent.length, 1);
  // The original launch no longer appears in the enumeration; the journal
  // must still prevent building a replacement transaction for launch #2.
  f.launch = f.otherLaunches[0]; f.otherLaunches = [];
  await f.keeper().cycle();
  assert.equal(f.sent.length, 1);
});
