'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { webcrypto, scryptSync, createHmac } = require('node:crypto');
const { Signer } = require('koilib');
const protocol = require('../public/js/request-proof');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const audience = 'https://usekoinos.com', origin = 'https://app.tradekoinos.com';
const signer = new Signer({ privateKey: '01'.repeat(32) });
const address = signer.getAddress(), secret = 'request-proof-http-test-only';

async function gateway(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-http-'));
  const code = `
    const http = require('node:http');
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function(...args) {
      this.once('listening', () => console.log('TEST_PORT=' + this.address().port));
      return listen.apply(this, args);
    };
    require('./server');`;
  const child = spawn(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: '0', DATA_DIR: dir, DEMO_MODE: '1', KOINOS_NETWORK: 'mainnet',
      PUBLIC_ORIGIN: audience, SIGNER_ORIGINS: origin, GATEWAY_DEV_WIF: '',
      GOOGLE_CLIENT_ID: 'test-client', LOGIN_SECRET: secret, LAUNCHPAD_ADDRESS: '',
      GATEWAY_COLLECTION_ADDR: '', GATEWAY_COLLECTION_WIF: '', AUTO_LIST_OURO: '0',
      EMAIL_PROVIDER: '', EMAIL_API_KEY: '', EMAIL_WEBHOOK_URL: '', SMTP_USER: '', SMTP_PASS: '',
      AURVANIA_LOGIN_SECRET: '',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', port;
  child.stdout.on('data', data => { logs += data; port = /TEST_PORT=(\d+)/.exec(logs)?.[1]; });
  child.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 300 && !port && child.exitCode === null; i++) await delay(10);
  assert.ok(port, logs);
  const base = `http://127.0.0.1:${port}`;
  const config = await (await fetch(base + '/api/config')).json();
  async function post(action, body, from = audience, suffix = '') {
    const response = await fetch(base + protocol.PATHS[action] + suffix, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: from }, body: JSON.stringify(body) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  const sign = (action, payload = {}, from = audience) => protocol.create({ action, payload, address,
    context: config.requestProof, audience, network: 'mainnet', origin: from, signMessage: m => signer.signMessage(m) });
  return { base, config, sign, post, dir };
}

test('all seven real HTTP handlers reject legacy proofs and consume valid v2 proofs before action handling', async t => {
  const app = await gateway(t);
  assert.equal(app.config.requestProof.version, 2);
  const advertised = await (await fetch(app.base + '/api/signer-config', { headers: { Origin: origin } })).json();
  assert.deepEqual(advertised.requestProof, app.config.requestProof);
  for (const action of Object.keys(protocol.PATHS)) {
    const legacy = await app.post(action, { address, ts: Date.now(), sig: 'legacy' });
    assert.equal(legacy.status, 401, action);
    const body = await app.sign(action);
    const first = await app.post(action, body);
    // Empty operation payload passes proof verification, then existing business validation rejects it.
    assert.ok([400, 404, 503].includes(first.status), action + ': ' + JSON.stringify(first.data));
    assert.doesNotMatch(first.data.error, /signed|signature|proof|secure request/);
    assert.equal((await app.post(action, body)).status, 409, action);
  }
});

test('real HTTP mutation rejects changed payload and wrong origin; one unchanged request executes once', async t => {
  const app = await gateway(t);
  const body = await app.sign('launch-token', { name: 'Test', symbol: 'TST', supply: '100', decimals: 8, mintable: false }, origin);
  assert.equal((await app.post('launch-token', { ...body, supply: '1000000' }, origin)).status, 401);
  assert.equal((await app.post('launch-token', body, 'https://attacker.example')).status, 403);
  assert.equal((await app.post('launch-token', body, origin, '?extra=1')).status, 401);
  const accepted = await app.post('launch-token', body, origin);
  assert.equal(accepted.status, 200); assert.equal(accepted.data.demo, true);
  assert.equal(accepted.headers.get('access-control-allow-origin'), origin);
  assert.equal((await app.post('launch-token', body, origin)).status, 409);
  const tokens = JSON.parse(fs.readFileSync(path.join(app.dir, 'tokens.json')));
  assert.equal(tokens.length, 1); assert.equal(tokens[0].owner, address); assert.equal(tokens[0].supplyUnits, '10000000000');
});

test('Google session authentication remains independent and mixed credential requests are rejected', async t => {
  const app = await gateway(t);
  const encoded = Buffer.from(JSON.stringify({ sub: 'fixture', addr: address, exp: Date.now() + 60000 })).toString('base64url');
  const mac = createHmac('sha256', scryptSync(secret, 'dk-session-v1', 32)).update(encoded).digest('base64url');
  const sessionToken = encoded + '.' + mac;
  for (const action of ['launch-token', 'launchpad-logo', 'launchpad-profile']) {
    assert.equal((await app.post(action, { sessionToken: 'invalid' }, origin)).status, 401);
    const accepted = await app.post(action, { sessionToken }, origin);
    assert.equal(accepted.status, 400); assert.doesNotMatch(accepted.data.error, /session|signed|proof/);
    assert.equal((await app.post(action, { sessionToken, proof: {} }, origin)).status, 400);
  }
  assert.equal(fs.existsSync(path.join(app.dir, 'request-proof-nonces')), false);
});
