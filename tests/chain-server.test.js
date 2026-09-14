'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Exercise the real HTTP routing and boot wiring with controllable read
// failures. No real keys, external services, or broadcasts are involved.
async function gateway(t, mode = 'live', failure = 'probe') {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-startup-'));
  const offline = path.join(data, 'offline'); fs.writeFileSync(offline, '');
  const code = `
    const fs = require('node:fs');
    const http = require('node:http');
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function(...args) {
      this.once('listening', () => console.log('TEST_PORT=' + this.address().port));
      return listen.apply(this, args);
    };
    const rpc = require('./tools/rpc');
    const offline = () => fs.existsSync(process.env.OFFLINE_FILE);
    rpc.pickRpcs = async () => {
      if (offline() && process.env.FAILURE === 'probe') throw new Error('RPC unreachable');
      return ['http://127.0.0.1:1'];
    };
    const startup = require('./tools/chain-startup');
    const create = startup.createChainStartup;
    startup.createChainStartup = opts => create({ ...opts, retryMs: 20 });
    const chain = require('./tools/koinos');
    chain.devAddress = () => '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK';
    chain.mana = async () => {
      if (offline()) throw new Error('sponsor read unavailable');
      return 92;
    };
    chain.koinBalance = async () => 100;
    chain.headInfo = async () => ({ head_topology: { height: '39350000' } });
    chain.supplies = async () => ({ koin: 65000000, vhp: 20000000 });
    require('./server');
  `;
  const child = spawn(process.execPath, ['-e', code], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: '0', DATA_DIR: data, OFFLINE_FILE: offline, FAILURE: failure,
      KOINOS_NETWORK: 'mainnet', GATEWAY_DEV_WIF: mode === 'unconfigured' ? '' : 'test-placeholder',
      GATEWAY_COLLECTION_ADDR: '', GATEWAY_COLLECTION_WIF: '', LAUNCHPAD_ADDRESS: '',
      DEMO_MODE: mode === 'demo' ? '1' : '', GOOGLE_CLIENT_ID: 'test-client',
      LOGIN_SECRET: '', EMAIL_PROVIDER: '', EMAIL_API_KEY: '', EMAIL_WEBHOOK_URL: '',
      SMTP_USER: '', SMTP_PASS: '', AURVANIA_LOGIN_SECRET: '',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '', port;
  child.stdout.on('data', chunk => { logs += chunk; port = /TEST_PORT=(\d+)/.exec(logs)?.[1]; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const done = new Promise(resolve => child.once('exit', resolve)); child.kill(); await done;
    }
    fs.rmSync(data, { recursive: true, force: true });
  });
  for (let i = 0; i < 200 && !port && child.exitCode === null; i++) await delay(10);
  assert.ok(port, logs);
  const get = async route => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`);
    return { res, body: await res.json() };
  };
  return { get, port, recover: () => fs.unlinkSync(offline) };
}

for (const failure of ['probe', 'sponsor']) {
  test(`live server stays out of demo and automatically recovers from ${failure} failure`, async t => {
    const app = await gateway(t, 'live', failure);
    const initial = (await app.get('/api/config')).body;
    assert.equal(initial.demo, false); assert.equal(initial.ready, false);
    assert.ok(['connecting', 'reconnecting'].includes(initial.chainStatus));
    assert.equal((await app.get('/api/gallery')).res.status, 200);
    assert.equal((await app.get('/api/stats')).res.status, 503);
    for (const route of ['/api/mint-nft', '/api/upload-nft', '/api/launch-token', '/api/prepare', '/api/submit', '/api/list-dex']) {
      const res = await fetch(`http://127.0.0.1:${app.port}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(res.status, 503, route);
      assert.equal(res.headers.get('retry-after'), '30');
      const body = await res.json(); assert.match(body.error, /reconnecting/);
      assert.equal(body.txid, undefined); assert.equal(body.demo, undefined);
    }
    app.recover();
    let health;
    for (let i = 0; i < 100; i++) {
      health = (await app.get('/api/health')).body;
      if (health.ready) break;
      await delay(10);
    }
    assert.equal(health.ready, true); assert.equal(health.demo, false);
    assert.equal(health.chainStatus, 'ready'); assert.equal(health.note, undefined);
    const config = await app.get('/api/config');
    assert.equal(config.body.ready, true); assert.ok(config.body.sponsor);
    assert.equal(config.res.headers.get('cache-control'), 'no-store');
    const stats = await app.get('/api/stats');
    assert.equal(stats.res.status, 200); assert.equal(stats.body.head, 39350000);
    assert.equal(stats.body.demo, undefined);
  });
}
for (const mode of ['demo', 'unconfigured']) {
  test(`${mode} development server keeps its intentional demo behavior`, async t => {
    const app = await gateway(t, mode);
    const config = (await app.get('/api/config')).body;
    assert.equal(config.demo, true); assert.equal(config.chainStatus, 'demo');
    const stats = await app.get('/api/stats');
    assert.equal(stats.res.status, 200); assert.equal(stats.body.demo, true);
  });
}
