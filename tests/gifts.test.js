/* Sending to an email address, end to end.

   The whole point of the feature is that you can send a token or an NFT to
   someone who has never heard of Koinos, and they get it. That means three
   things have to be true, and each is checked here:

     1. an email the gateway already knows goes STRAIGHT to that wallet — no
        escrow, nothing to collect, no reason to make them do anything;
     2. an email it does not know is held, and released the moment that
        Google account signs in — matched on the address Google VERIFIED,
        never on what a sender typed;
     3. Gmail's dots and +tags do not split one inbox into two people.

   Run: node tests/gifts.test.js
*/
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGifts, normalizeEmail } = require('../tools/gifts');

const ALICE = '1AliceWalletAddressXXXXXXXXXXXXXXX';
const BOB = '1BobWalletAddressXXXXXXXXXXXXXXXXX';
const ESCROW_SEED = '1EscrowAccountAddressXXXXXXXXXXXXX';

/** Just enough chain to watch what the gift module asks it to do. */
function stubChain() {
  const sent = [];
  return {
    sent,
    isAddr: (a) => /^1[0-9A-Za-z]{10,}$/.test(String(a || '')),
    newAccount: () => ({ address: ESCROW_SEED, wif: '5KescrowWifXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' }),
    keyFromWif: (wif) => ({ wif, getAddress: () => ESCROW_SEED }),
    opTokenTransfer: async (token, from, to, units) => ({ op: 'token', token, from, to, units }),
    opNftTransfer: async (from, to, tokenId) => ({ op: 'nft', from, to, tokenId }),
    sendAsAccount: async (key, ops) => { sent.push(ops[0]); return '0x' + (sent.length).toString(16).padStart(4, '0'); },
  };
}

function stubMailer() {
  const outbox = [];
  return { outbox, send: async (m) => { outbox.push(m); return { sent: true }; }, enabled: () => true, status: () => ({ enabled: true }) };
}

function setup(known = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gifts-'));
  const chain = stubChain();
  const mailer = stubMailer();
  const gifts = createGifts({
    dataDir: dir, chain, mailer, origin: 'https://usekoinos.com',
    lookupEmail: (e) => known[normalizeEmail(e)] || null,
    log: () => {},
  });
  return { dir, chain, mailer, gifts };
}

const TOKEN_GIFT = {
  kind: 'token', token: '1TokenAddr', symbol: 'RKT', amount: '12.5',
  units: '1250000000', decimals: 8, from: ALICE, txid: '0xabc',
};

(async () => {
  /* --- 1. Gmail spellings are one inbox --- */
  {
    assert.strictEqual(normalizeEmail('A.B+koinos@Gmail.com'), 'ab@gmail.com');
    assert.strictEqual(normalizeEmail('ab@googlemail.com'), 'ab@gmail.com');
    /* Dots are NOT noise outside Gmail — collapsing them there would send
       one person's gift to a different mailbox entirely. */
    assert.strictEqual(normalizeEmail('a.b@fastmail.com'), 'a.b@fastmail.com');
    assert.strictEqual(normalizeEmail('not-an-email'), null);
    console.log('✓ Gmail dots and +tags collapse to one inbox; other domains keep their dots');
  }

  /* --- 2. a known email goes straight to their wallet --- */
  {
    const { gifts, chain } = setup({ 'bob@gmail.com': BOB });
    const dest = gifts.resolve('B.o.b+shopping@gmail.com');
    assert.strictEqual(dest.kind, 'direct');
    assert.strictEqual(dest.address, BOB, 'a known email must resolve to that wallet, not escrow');
    assert.strictEqual(chain.sent.length, 0, 'and nothing is escrowed');
    console.log('✓ an email we already know a wallet for goes straight there');
  }

  /* --- 3. an unknown email is held, then released on sign-in --- */
  {
    const { gifts, chain, mailer } = setup();
    const dest = gifts.resolve('Stranger+x@Gmail.com');
    assert.strictEqual(dest.kind, 'escrow');
    assert.strictEqual(dest.address, ESCROW_SEED);
    assert.strictEqual(dest.email, 'stranger@gmail.com');

    await gifts.recordEscrow({ ...TOKEN_GIFT, mode: 'escrow', email: dest.email, label: 'Stranger+x@Gmail.com' });
    assert.strictEqual(mailer.outbox.length, 1, 'the recipient is told there is something to collect');
    assert.match(mailer.outbox[0].subject, /sent you 12\.5 RKT/);
    assert.match(mailer.outbox[0].text, /usekoinos\.com\/wallet\?claim=/, 'with a link that works');
    assert.strictEqual(gifts.pendingCount('stranger@gmail.com'), 1);

    /* Signing in with a DIFFERENT account must not collect it. */
    const wrong = await gifts.collect('someone.else@gmail.com', BOB);
    assert.strictEqual(wrong.released, 0, 'a different Google account collects nothing');
    assert.strictEqual(chain.sent.length, 0);

    /* The right one does — matched on the verified address, any spelling. */
    const got = await gifts.collect('stranger@GMAIL.com', BOB);
    assert.strictEqual(got.released, 1);
    assert.deepStrictEqual(chain.sent[0], {
      op: 'token', token: '1TokenAddr', from: ESCROW_SEED, to: BOB, units: '1250000000',
    }, 'the escrow forwards exactly what was held, to the wallet that just proved the email');
    assert.strictEqual(gifts.pendingCount('stranger@gmail.com'), 0, 'and it is not collectable twice');

    const again = await gifts.collect('stranger@gmail.com', BOB);
    assert.strictEqual(again.released, 0);
    assert.strictEqual(chain.sent.length, 1, 'a second sign-in must not re-send it');
    console.log('✓ an unknown email is held, released to the account that proves it, and only once');
  }

  /* --- 4. NFTs travel the same road --- */
  {
    const { gifts, chain } = setup();
    const dest = gifts.resolve('newbie@example.org');
    await gifts.recordEscrow({
      kind: 'nft', tokenId: '0x99', nftCode: 'DK00007', nftName: 'Pixel Cat',
      from: ALICE, mode: 'escrow', email: dest.email, label: 'newbie@example.org',
    });
    const got = await gifts.collect('newbie@example.org', BOB);
    assert.strictEqual(got.released, 1);
    assert.deepStrictEqual(chain.sent[0], { op: 'nft', from: ESCROW_SEED, to: BOB, tokenId: '0x99' });
    console.log('✓ an NFT is held and released the same way');
  }

  /* --- 5. a failed release keeps the gift, it does not lose it --- */
  {
    const { gifts, chain } = setup();
    const dest = gifts.resolve('flaky@example.org');
    await gifts.recordEscrow({ ...TOKEN_GIFT, mode: 'escrow', email: dest.email, label: 'flaky@example.org' });
    chain.sendAsAccount = async () => { throw new Error('rpc down'); };
    const bad = await gifts.collect('flaky@example.org', BOB);
    assert.strictEqual(bad.released, 0);
    assert.strictEqual(bad.failed, 1);
    assert.strictEqual(gifts.pendingCount('flaky@example.org'), 1,
      'a failed release must leave the gift claimable, never mark it gone');
    console.log('✓ a failed release leaves the gift claimable next time');
  }

  /* --- 6. the sender can see what is still waiting --- */
  {
    const { gifts } = setup();
    const dest = gifts.resolve('waiting@example.org');
    await gifts.recordEscrow({ ...TOKEN_GIFT, mode: 'escrow', email: dest.email, label: 'waiting@example.org' });
    const out = gifts.outbox(ALICE);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].status, 'pending');
    assert.strictEqual(out[0].email, 'waiting@example.org');
    assert.strictEqual(gifts.outbox(BOB).length, 0, "and cannot see anyone else's");
    console.log('✓ the sender sees their own pending gifts, and only their own');
  }

  /* --- 7. state survives a restart (the escrow holds real value) --- */
  {
    const { dir, gifts, chain, mailer } = setup();
    const dest = gifts.resolve('restart@example.org');
    await gifts.recordEscrow({ ...TOKEN_GIFT, mode: 'escrow', email: dest.email, label: 'restart@example.org' });
    const reopened = createGifts({
      dataDir: dir, chain, mailer, origin: 'https://usekoinos.com', lookupEmail: () => null, log: () => {},
    });
    assert.strictEqual(reopened.pendingCount('restart@example.org'), 1, 'a pending gift must survive a restart');
    assert.strictEqual(reopened.escrowAddress(), ESCROW_SEED, 'and the escrow account must not be regenerated');
    const got = await reopened.collect('restart@example.org', BOB);
    assert.strictEqual(got.released, 1);
    console.log('✓ pending gifts and the escrow account survive a restart');
  }

  console.log('\nALL GIFT CHECKS PASSED');
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
