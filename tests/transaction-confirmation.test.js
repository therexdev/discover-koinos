'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { createRequire } = require('node:module');
const { transactionOutcome, waitForTransaction } = require('../tools/transaction-confirmation');
const { createPendingStore } = require('../tools/keeper-pending');

function block(txId = 'tx', id = 'block', reverted = false) {
  return {
    block_id: id, block_height: '12',
    block: { id, header: { height: '12' }, transactions: [{ id: txId }] },
    receipt: { id, transaction_receipts: [{ id: txId, reverted, logs: [] }] },
  };
}

function providerFor(item = block()) {
  return {
    getTransactionsById: async ids => ({ transactions: [{ transaction: { id: ids[0] }, containing_blocks: ['block'] }] }),
    getBlocksById: async () => ({ block_items: [{ block_id: 'block', block_height: '12' }] }),
    getHeadInfo: async () => ({ head_topology: { id: 'current-head', height: '15' } }),
    getBlocks: async (height, count, head, opts) => {
      assert.equal(height, 12);
      assert.equal(count, 1);
      assert.equal(head, 'current-head');
      assert.deepEqual(opts, { returnBlock: true, returnReceipt: true });
      return [item];
    },
  };
}

function clock() {
  let time = 0;
  return { timeoutMs: 6, pollMs: 2, now: () => time, sleep: async ms => { time += ms; } };
}

test('only canonical block membership and a matching non-reverted receipt confirm a transaction', async () => {
  const result = await transactionOutcome(providerFor(), 'tx');
  assert.equal(result.status, 'confirmed');
  assert.equal(result.blockId, 'block');
  assert.equal(result.blockNumber, 12);
  const item = block();
  delete item.receipt.transaction_receipts[0].reverted;
  assert.equal((await transactionOutcome(providerFor(item), 'tx')).status, 'confirmed');
});

test('orphan references, missing receipts, unrelated transactions and malformed receipt flags stay pending', async t => {
  const cases = {
    orphan: item => { item.block_id = 'other-canonical-block'; },
    'missing receipt': item => { delete item.receipt; },
    'wrong receipt id': item => { item.receipt.transaction_receipts[0].id = 'other-tx'; },
    'wrong block receipt': item => { item.receipt.id = 'other-block'; },
    'wrong block payload': item => { item.block.id = 'other-block'; },
    'missing transaction': item => { item.block.transactions = []; },
    'wrong height': item => { item.block.header.height = '13'; },
    'malformed reverted': item => { item.receipt.transaction_receipts[0].reverted = 'false'; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const item = block(); mutate(item);
    assert.equal((await transactionOutcome(providerFor(item), 'tx')).status, 'pending');
  });
});

test('unrelated transaction-store entries cannot confirm the requested id', async () => {
  const provider = providerFor();
  provider.getTransactionsById = async () => ({ transactions: [{ transaction: { id: 'other' }, containing_blocks: ['block'] }] });
  assert.equal((await transactionOutcome(provider, 'tx')).status, 'pending');
});

test('canonical reverted receipt is definitive failure with its original id and receipt', async () => {
  const item = block('tx', 'block', true);
  item.receipt.transaction_receipts[0].logs = ['contract rejected the action'];
  assert.equal((await transactionOutcome(providerFor(item), 'tx')).status, 'reverted');
  await assert.rejects(waitForTransaction(providerFor(item), 'tx', clock()), error => {
    assert.equal(error.txId, 'tx');
    assert.equal(error.confirmed, true);
    assert.equal(error.reverted, true);
    assert.equal(error.broadcast, true);
    assert.equal(error.pending, undefined);
    assert.match(error.message, /contract rejected/);
    assert.equal(error.receipt, item.receipt.transaction_receipts[0]);
    return true;
  });
});

test('intermittent poll failures retry reads for the same id until its canonical receipt appears', async () => {
  const provider = providerFor();
  let reads = 0;
  provider.getTransactionsById = async ids => {
    assert.deepEqual(ids, ['tx']);
    if (++reads === 1) throw new Error('invalid JSON from RPC');
    return { transactions: [{ transaction: { id: 'tx' }, containing_blocks: ['block'] }] };
  };
  assert.equal((await waitForTransaction(provider, 'tx', clock())).status, 'confirmed');
  assert.equal(reads, 2);
});

test('missing or unreadable receipts time out as pending, never as a rejection', async t => {
  for (const unavailable of [false, true]) await t.test(String(unavailable), async () => {
    const provider = providerFor();
    provider.getBlocks = async () => { if (unavailable) throw new Error('RPC offline'); return []; };
    await assert.rejects(waitForTransaction(provider, 'tx', clock()), error => {
      assert.equal(error.txId, 'tx');
      assert.equal(error.pending, true);
      assert.equal(error.broadcast, true);
      assert.equal(error.rejected, undefined);
      assert.equal(error.confirmed, undefined);
      return true;
    });
  });
});

// Execute the real facade with inert transaction/signing classes. No WIF,
// network request or real signature is created by these integration tests.
function facade({ sendError, pending = false, reverted = false, pendingFile, outcomes = {}, journalStatError } = {}) {
  const filename = path.resolve(__dirname, '../tools/koinos.js');
  const realRequire = createRequire(filename);
  const events = [];
  let sequence = 0, marketExists = false;
  class Provider {
    async getChainId() { return 'chain-id'; }
    async getTransactionsById(ids) {
      events.push(`read:${ids[0]}`);
      if (outcomes[ids[0]] instanceof Error) throw outcomes[ids[0]];
      return { transactions: (outcomes[ids[0]] === 'pending' || (!outcomes[ids[0]] && pending)) ? [] :
        [{ transaction: { id: ids[0] }, containing_blocks: [ids[0]] }] };
    }
    async getBlocksById(ids) { return { block_items: ids.map(id => ({ block_id: id, block_height: '12' })) }; }
    async getHeadInfo() { return { head_topology: { id: 'head' } }; }
    async getBlocks() {
      const id = events.filter(event => event.startsWith('read:')).at(-1).slice(5);
      return [block(id, id, outcomes[id] ? outcomes[id] === 'reverted' : reverted)];
    }
  }
  const devSigner = { getAddress: () => 'dev', signTransaction: async tx => { events.push(`cosign:${tx.id}`); } };
  class Transaction {
    static computeTransactionId(header) { return header.id; }
    constructor() { this.transaction = { operations: [] }; }
    async pushOperation(op) { this.transaction.operations.push(op); }
    async prepare() { this.transaction.id = `tx-${++sequence}`; events.push(`prepare:${this.transaction.id}`); }
    async sign() { events.push(`sign:${this.transaction.id}`); }
    async send() {
      events.push(`send:${this.transaction.id}`);
      if (sendError) throw sendError;
      if (this.transaction.operations.includes('create-market')) marketExists = true;
    }
  }
  class Contract {
    constructor() {
      this.functions = {
        get_markets: async () => ({ result: { markets: marketExists ? [{ baseToken: 'token', quoteToken: 'koin', marketId: 7 }] : [] } }),
        create_market: async () => ({ operation: 'create-market' }),
      };
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    __dirname: path.dirname(filename), module, exports: module.exports, Buffer, setTimeout,
    require: name => {
      if (name === 'fs' && journalStatError) return { ...fs, statSync: () => { throw journalStatError; } };
      if (name === 'koilib') return { Provider, Transaction, Contract,
        Signer: { fromWif: () => devSigner, recoverAddresses: async () => ['user'] }, utils: {} };
      if (name === './rpc') return { NETWORKS: { harbinger: { koinContract: 'koin' } }, rpcCandidates: () => [], configureRpcProvider: p => p };
      if (name === './transaction-confirmation') return {
        transactionOutcome,
        waitForTransaction: (provider, id) => waitForTransaction(provider, id, clock()),
      };
      return realRequire(name);
    },
  }, { filename });
  const chain = module.exports;
  chain.configure({ devWif: 'inert-test-marker', dexOrderbook: 'orderbook', launchpadAddr: 'launchpad',
    ...(pendingFile ? { keeperPendingFile: pendingFile } : {}) });
  return { chain, events, account: { getAddress: () => 'contract-account' } };
}

test('devTx hooks run after signing and inside the queue immediately before each submission', async () => {
  const { chain, events } = facade();
  let unblock, entered;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const first = chain.devTx(['first'], { beforeSend: async ({ txId }) => {
    events.push(`hook:${txId}`); entered(); await blocked;
  } });
  await ready;
  const second = chain.devTx(['second'], { beforeSend: async ({ txId }) => { events.push(`hook:${txId}`); } });
  await Promise.resolve();
  assert.deepEqual(events, ['prepare:tx-1', 'sign:tx-1', 'hook:tx-1']);
  unblock();
  assert.deepEqual(await Promise.all([first, second]), ['tx-1', 'tx-2']);
  assert.deepEqual(events, ['prepare:tx-1', 'sign:tx-1', 'hook:tx-1', 'send:tx-1', 'read:tx-1',
    'prepare:tx-2', 'sign:tx-2', 'hook:tx-2', 'send:tx-2', 'read:tx-2']);
});

test('sendAsAccount shares the serialized queue and guards after both signatures', async () => {
  const { chain, events, account } = facade();
  const hook = async ({ txId }) => { events.push(`hook:${txId}`); };
  await Promise.all([chain.sendAsAccount(account, ['upload'], { beforeSend: hook }), chain.devTx(['next'], { beforeSend: hook })]);
  assert.deepEqual(events, ['prepare:tx-1', 'sign:tx-1', 'cosign:tx-1', 'hook:tx-1', 'send:tx-1', 'read:tx-1',
    'prepare:tx-2', 'sign:tx-2', 'hook:tx-2', 'send:tx-2', 'read:tx-2']);
});

test('a failed guard prevents both devTx and sendAsAccount from submitting', async () => {
  const { chain, events, account } = facade();
  const beforeSend = async () => { throw new Error('mana below floor'); };
  await assert.rejects(chain.devTx([], { beforeSend }), /mana below floor/);
  await assert.rejects(chain.sendAsAccount(account, [], { beforeSend }), /mana below floor/);
  assert.equal(events.some(event => event.startsWith('send:')), false);
});

test('ensureDexMarket passes its guard through to the actual queued transaction', async () => {
  const { chain, events } = facade();
  assert.equal(await chain.ensureDexMarket('token', { beforeSend: async ({ txId }) => { events.push(`hook:${txId}`); } }), 7);
  assert.deepEqual(events, ['prepare:tx-1', 'sign:tx-1', 'hook:tx-1', 'send:tx-1', 'read:tx-1']);
});

test('ambiguous send failures reconcile one transaction id without rebroadcasting', async t => {
  for (const message of ['network lost', 'unexpected failure', 'already known transaction', 'duplicate transaction', 'internal error']) {
    await t.test(message, async () => {
      const sendError = Object.assign(new Error(message), { rpcError: message !== 'unexpected failure' });
      const { chain, events } = facade({ sendError });
      assert.equal(await chain.devTx([]), 'tx-1');
      assert.equal(events.filter(event => event.startsWith('send:')).length, 1);
      assert.ok(events.includes('read:tx-1'));
    });
  }
});

test('facade preserves pending and canonical reverted classifications', async t => {
  for (const outcome of ['pending', 'reverted']) await t.test(outcome, async () => {
    const { chain } = facade({ [outcome]: true });
    await assert.rejects(chain.devTx([]), error => {
      assert.equal(error.txId, 'tx-1');
      assert.equal(error.broadcast, true);
      assert.equal(error[outcome], true);
      assert.equal(error.confirmed, outcome === 'reverted' ? true : undefined);
      return true;
    });
  });
});

test('only an explicit non-transient RPC rejection is marked rejected', async () => {
  const sendError = Object.assign(new Error('insufficient rc'), { rpcError: true });
  const { chain, events } = facade({ sendError });
  await assert.rejects(chain.devTx([]), error => error.rejected === true && error.txId === 'tx-1' && !error.pending);
  assert.deepEqual(events, ['prepare:tx-1', 'sign:tx-1', 'send:tx-1']);
});

function journalFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-nonce-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'keeper-pending.json');
  const binding = { network: 'harbinger', chainId: 'chain-id', launchpad: 'launchpad', payer: 'dev' };
  const entry = txId => ({ txId, action: 'finalize', createdAt: new Date().toISOString() });
  return { dir, file, binding, entry, open: () => createPendingStore(file, binding) };
}

test('an actual queued keeper submission reserves its nonce against interactive market creation and restart', async t => {
  const j = journalFixture(t);
  const first = facade({ pendingFile: j.file, pending: true });
  await assert.rejects(first.chain.devTx(['finalize'], { beforeSend: async ({ txId }) => {
    j.open().set(1, j.entry(txId));
  } }), error => error.pending && error.txId === 'tx-1');
  assert.equal(first.events.filter(event => event.startsWith('send:')).length, 1,
    'newly written journal must not block its own first broadcast');
  await assert.rejects(first.chain.ensureDexMarket('token'), error => error.keeperPending && error.txId === 'tx-1');
  assert.equal(first.events.filter(event => event.startsWith('prepare:')).length, 1,
    'interactive work must stop before preparing a replacement nonce');
  // No keeper is instantiated: the first gateway request after restart
  // must load the durable reservation itself.
  const restarted = facade({ pendingFile: j.file, outcomes: { 'tx-1': 'pending' } });
  await assert.rejects(restarted.chain.ensureDexMarket('token'), error => error.keeperPending && error.txId === 'tx-1');
  assert.deepEqual(restarted.events, ['read:tx-1']);
  assert.equal(j.open().get(1).txId, 'tx-1');
});

test('journal guard also runs from DATA_DIR with no keeper loop or custom path configured', async t => {
  const j = journalFixture(t);
  j.open().set(1, j.entry('old-keeper-tx'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = j.dir;
  t.after(() => { if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; });
  const { chain, events } = facade({ outcomes: { 'old-keeper-tx': 'pending' } });
  await assert.rejects(chain.ensureDexMarket('token'), error => error.keeperPending === true);
  assert.deepEqual(events, ['read:old-keeper-tx']);
});

test('unreadable, corrupt and mismatched journals fail closed before dev nonce preparation', async t => {
  const j = journalFixture(t);
  j.open().set(1, j.entry('old-keeper-tx'));
  const { chain, events } = facade({ pendingFile: j.file, outcomes: { 'old-keeper-tx': new Error('RPC offline') } });
  await assert.rejects(chain.devTx([]), error => error.keeperPending && error.txId === 'old-keeper-tx');
  fs.writeFileSync(j.file, '{broken');
  await assert.rejects(chain.devTx([]), SyntaxError);
  for (const field of ['network', 'chainId', 'launchpad', 'payer']) {
    fs.writeFileSync(j.file, JSON.stringify({ version: 1, binding: { ...j.binding, [field]: 'wrong' }, launches: {} }));
    await assert.rejects(chain.devTx([]), /chain\/account binding/);
  }
  assert.equal(events.some(event => event.startsWith('prepare:') || event.startsWith('send:')), false);
  const denied = facade({ pendingFile: j.file, journalStatError: Object.assign(new Error('journal access denied'), { code: 'EACCES' }) });
  await assert.rejects(denied.chain.devTx([]), /journal access denied/);
  assert.deepEqual(denied.events, []);
});

test('canonical resolution permits interactive devTx without mutating the keeper journal', async t => {
  for (const status of ['confirmed', 'reverted']) {
    const j = journalFixture(t);
    j.open().set(1, j.entry('old-keeper-tx'));
    const { chain, events } = facade({ pendingFile: j.file, outcomes: { 'old-keeper-tx': status } });
    assert.equal(await chain.ensureDexMarket('token'), 7);
    assert.equal(events[0], 'read:old-keeper-tx');
    assert.equal(events.filter(event => event.startsWith('send:')).length, 1);
    assert.equal(j.open().get(1).txId, 'old-keeper-tx', 'only the keeper owns journal cleanup');
  }
});

test('the guard reloads reservations cleared by operator recovery and never replaces an unresolved one', async t => {
  const j = journalFixture(t);
  const store = j.open(); store.set(1, j.entry('old-keeper-tx'));
  const { chain, events } = facade({ pendingFile: j.file, outcomes: { 'old-keeper-tx': 'pending' } });
  await assert.rejects(chain.devTx([]), error => error.keeperPending === true);
  store.clear(1, 'old-keeper-tx'); // operator recovery after independently proving non-inclusion
  assert.equal(await chain.devTx([]), 'tx-1');
  assert.equal(events.filter(event => event.startsWith('send:')).length, 1);
});

test('pending keeper nonce does not change separate contract and user payee submission semantics', async t => {
  const j = journalFixture(t);
  j.open().set(1, j.entry('old-keeper-tx'));
  const { chain, events, account } = facade({ pendingFile: j.file, outcomes: { 'old-keeper-tx': 'pending' } });
  assert.equal(await chain.sendAsAccount(account, ['upload']), 'tx-1');
  const signed = { id: 'user-tx', header: { id: 'user-tx' }, operations: [], signatures: ['inert-signature'] };
  assert.equal(await chain.submitCosigned(signed, 'user-tx', 'user'), 'user-tx');
  assert.equal(events.includes('read:old-keeper-tx'), false);
  assert.deepEqual(events.filter(event => event.startsWith('send:')), ['send:tx-1', 'send:user-tx']);
  assert.equal(j.open().get(1).txId, 'old-keeper-tx');
});
