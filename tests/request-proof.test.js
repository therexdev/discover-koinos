'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { webcrypto, createHash } = require('node:crypto');
const { Signer } = require('koilib');
const chain = require('../tools/koinos');
const protocol = require('../public/js/request-proof');
const { createRequestProofVerifier } = require('../tools/request-proof');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const signer = new Signer({ privateKey: '01'.repeat(32) }); // public test key only
const address = signer.getAddress();
const audience = 'https://usekoinos.com', origin = 'https://app.tradekoinos.com';
const context = { version: 2, audience, network: 'mainnet', ttlMs: protocol.TTL_MS };
const copy = value => JSON.parse(JSON.stringify(value));
const req = (action = 'launch-token', from = origin) => ({ method: 'POST', url: protocol.PATHS[action], headers: { origin: from } });
async function signed(action = 'launch-token', payload = { name: 'Test', supply: '10', decimals: 8, mintable: false }, from = origin) {
  return protocol.create({ action, payload, address, context, audience, network: 'mainnet', origin: from, signMessage: m => signer.signMessage(m) });
}
async function resign(body) {
  const { signature, ...fields } = body.proof;
  body.proof.signature = Buffer.from(await signer.signMessage(protocol.message(fields))).toString('base64');
  return body;
}
function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-v2-'));
  const options = { audience, network: 'mainnet', origins: [origin], directory: path.join(dir, 'nonces'),
    isAddress: chain.isAddr, verifySignature: chain.verifyAuthSignature, ...overrides };
  const verifier = createRequestProofVerifier(options);
  t.after(() => { verifier.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { verifier, options, dir };
}
function rejects(verifier, body, request = req(), status = 401, action = 'launch-token') {
  assert.throws(() => verifier.verify(body, action, request), e => e.status === status);
}

test('real account signature is accepted once and is spent across verifier restarts', async t => {
  const { verifier, options } = setup(t);
  const body = await signed();
  verifier.verify(body, 'launch-token', req());
  rejects(verifier, body, req(), 409);
  verifier.close();
  const restarted = createRequestProofVerifier(options); t.after(() => restarted.close());
  rejects(restarted, body, req(), 409);
});

test('changing any payload data or adding a field fails without consuming the valid proof', async t => {
  const { verifier } = setup(t), body = await signed();
  for (const patch of [{ name: 'Other' }, { supply: '1000' }, { decimals: 0 }, { mintable: true },
    { logo: 'data:image/png;base64,changed' }, { address: new Signer({ privateKey: '02'.repeat(32) }).getAddress() }]) {
    rejects(verifier, { ...body, ...patch });
  }
  verifier.verify(body, 'launch-token', req());
});

test('nested recipients, uploads, arrays, and collection selection are bound', async t => {
  const { verifier } = setup(t);
  for (const [action, payload, change] of [
    ['prepare', { action: 'token_transfer', params: { to: address, amount: '1' } }, b => { b.params.to = 'stranger'; }],
    ['upload-nft', { images: ['image1', 'image2'], collection: address }, b => { b.images.reverse(); }],
    ['upload-nft', { images: ['image1'], collectionName: 'My art' }, b => { b.collection = address; }],
  ]) {
    const body = await signed(action, payload, audience), altered = copy(body); change(altered);
    rejects(verifier, altered, req(action, audience), 401, action);
    verifier.verify(body, action, req(action, audience));
  }
});

test('action, path, method, account, audience, network, and proof schema are enforced', async t => {
  const { verifier } = setup(t), body = await signed();
  for (const patch of [{ action: 'launchpad-logo' }, { path: '/api/launchpad-logo' }, { method: 'GET' },
    { address: 'other' }, { audience: 'https://attacker.example' }, { network: 'harbinger' },
    { version: 1 }, { unexpected: true }, { payloadHash: '00'.repeat(32) }]) {
    const altered = copy(body); Object.assign(altered.proof, patch); await resign(altered);
    rejects(verifier, altered);
  }
  for (const request of [{ ...req(), method: 'GET' }, { ...req(), url: '/api/launch-token/' },
    { ...req(), url: '/api/launch-token?extra=1' }]) rejects(verifier, body, request);
});

test('origin header must match the signature and only configured cross-origin actions work', async t => {
  const { verifier } = setup(t), body = await signed();
  for (const from of ['null', 'https://attacker.example', audience]) rejects(verifier, body, req('launch-token', from), 403);
  rejects(verifier, body, { ...req(), headers: {} }, 403);
  const evil = await signed('launch-token', {}, 'https://attacker.example');
  rejects(verifier, evil, req('launch-token', 'https://attacker.example'), 403);
  const cross = await signed('prepare', { action: 'token_transfer' });
  rejects(verifier, cross, req('prepare'), 403, 'prepare');
});

test('expired, far-future, overlong, malformed, and revived nonces fail even when signed', async t => {
  const time = Date.now(), { verifier } = setup(t, { now: () => time }), body = await signed();
  for (const patch of [
    { expiresAt: time }, { issuedAt: time + 60000, expiresAt: time + 120000 },
    { expiresAt: body.proof.issuedAt + protocol.TTL_MS + 1 }, { issuedAt: '1000' },
    { nonce: '00'.repeat(32) }, { nonce: body.proof.nonce.replace(/.$/, 'z') },
    { issuedAt: body.proof.issuedAt + 1 }, // cannot change a nonce's timestamp
  ]) {
    const altered = copy(body); Object.assign(altered.proof, patch); await resign(altered);
    rejects(verifier, altered);
  }
});

test('legacy proofs, mixed credentials, malformed bodies, and another signing key fail', async t => {
  const { verifier } = setup(t), body = await signed();
  for (const altered of [null, [], {}, { address, ts: Date.now(), sig: 'old' },
    { ...body, ts: 1 }, { ...body, sig: 'old' }, { ...body, sessionToken: '' }]) rejects(verifier, altered);
  const { signature, ...fields } = body.proof;
  body.proof.signature = Buffer.from(await new Signer({ privateKey: '02'.repeat(32) }).signMessage(protocol.message(fields))).toString('base64');
  rejects(verifier, body);
});

test('missing canonical PUBLIC_ORIGIN disables proof discovery and fails closed', async t => {
  for (const value of ['', 'http://example.com', 'https://example.com/path', 'https://user@example.com']) {
    const { verifier } = setup(t, { audience: value });
    assert.equal(verifier.config(), null); rejects(verifier, await signed(), req(), 503);
  }
});

test('unwritable nonce storage and fsync errors fail closed without exposing paths', async t => {
  const { verifier, options } = setup(t);
  fs.writeFileSync(options.directory, 'not a directory');
  const body = await signed();
  assert.throws(() => verifier.verify(body, 'launch-token', req()), e => e.status === 503 && !e.message.includes(options.directory));
  fs.unlinkSync(options.directory);
  const sync = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw new Error('simulated disk failure'); };
    rejects(verifier, body, req(), 503);
  } finally { fs.fsyncSync = sync; }
  // A failed durability check never authorizes an operation; its nonce stays spent.
  rejects(verifier, body, req(), 409);
});

test('only expired nonce files are collected and expired proofs cannot be revived', async t => {
  let time = Date.now();
  const { verifier, options } = setup(t, { now: () => time });
  const body = await signed(); verifier.verify(body, 'launch-token', req());
  const original = fs.readdirSync(options.directory)[0];
  time = body.proof.issuedAt + protocol.TTL_MS + 1;
  const fresh = copy(body);
  Object.assign(fresh.proof, { issuedAt: time, expiresAt: time + protocol.TTL_MS, nonce: time + '.' + 'ab'.repeat(32) });
  await resign(fresh); verifier.verify(fresh, 'launch-token', req());
  assert.equal(fs.existsSync(path.join(options.directory, original)), false);
  rejects(verifier, body);
  rejects(verifier, fresh, req(), 409);
});

test('two independent server processes admit exactly one copy of the same real signature', async t => {
  const { options } = setup(t), body = await signed();
  const code = `
    const chain = require('./tools/koinos');
    const { createRequestProofVerifier } = require('./tools/request-proof');
    process.send('ready');
    process.on('message', ({ options, body, req }) => {
      const v = createRequestProofVerifier({ ...options, isAddress: chain.isAddr, verifySignature: chain.verifyAuthSignature });
      let status = 200;
      try { v.verify(body, 'launch-token', req); } catch (e) { status = e.status; }
      v.close(); process.send(status); process.disconnect();
    });`;
  const children = [1, 2].map(() => spawn(process.execPath, ['-e', code], {
    cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }));
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill(); }));
  await Promise.all(children.map(child => new Promise((resolve, reject) => {
    child.once('message', resolve); child.once('error', reject);
  })));
  const results = children.map(child => new Promise(resolve => child.once('message', resolve)));
  children.forEach(child => child.send({ options, body, req: req() }));
  assert.deepEqual((await Promise.all(results)).sort(), [200, 409]);
  const restarted = createRequestProofVerifier(options); t.after(() => restarted.close());
  rejects(restarted, body, req(), 409);
});

test('canonical message matches the shared independent conformance fixture', () => {
  const fixture = require('./fixtures/request-proof-v2.json');
  assert.equal(protocol.canonical(fixture.payload), fixture.canonicalPayload);
  assert.equal(createHash('sha256').update(fixture.canonicalPayload).digest('hex'), fixture.fields.payloadHash);
  assert.equal(protocol.message(fixture.fields), fixture.message);
});

test('client snapshots mutable data before signing and refuses protocol downgrade', async () => {
  const payload = { links: { website: 'https://example.com' } };
  const pending = signed('launchpad-profile', payload); payload.links.website = 'https://changed.example';
  const body = await pending;
  assert.equal(body.links.website, 'https://example.com');
  let calls = 0;
  for (const bad of [null, { ...context, version: 1 }, { ...context, audience: 'https://evil.example' }, { ...context, network: 'harbinger' }]) {
    await assert.rejects(protocol.create({ action: 'launch-token', payload: {}, address, context: bad,
      audience, network: 'mainnet', origin, signMessage: () => { calls++; } }), /unavailable/);
  }
  assert.equal(calls, 0);
});
