'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Provider } = require('koilib');
const { configureRpcProvider } = require('../tools/rpc');

async function node(t, reply) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const call = JSON.parse(body); calls.push(call);
    reply(req, res, call);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}
const success = (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result: { rc: '100' } })); };

for (const failure of ['http', 'html', 'timeout', 'rpc']) {
  test(`reads fail over after ${failure} failures using the real koilib Provider`, async t => {
    const bad = await node(t, (req, res) => {
      if (failure === 'timeout') return;
      if (failure === 'http') { res.writeHead(503); res.end('offline'); }
      if (failure === 'html') res.end('<html>proxy error</html>');
      if (failure === 'rpc') res.end(JSON.stringify({ error: { message: 'read service unavailable' } }));
    });
    const good = await node(t, (req, res) => {
      assert.equal(req.headers['content-type'], 'application/json'); success(req, res);
    });
    const provider = configureRpcProvider(new Provider([bad.url, good.url]), { timeoutMs: 100 });
    assert.deepEqual(await provider.call('chain.get_account_rc', { account: 'test' }), { rc: '100' });
    assert.equal(provider.currentNodeId, 1);
    assert.equal(bad.calls.length, 1); assert.equal(good.calls.length, 1);
  });
}

test('lost broadcast responses are never replayed on a second node', async t => {
  const bad = await node(t, (req, res) => res.destroy());
  const good = await node(t, success);
  const provider = configureRpcProvider(new Provider([bad.url, good.url]));
  await assert.rejects(provider.call('chain.submit_transaction', { transaction: { id: 'fixture' } }));
  assert.equal(bad.calls.length, 1); assert.equal(good.calls.length, 0);
});

test('contract rejection details survive unchanged and broadcasts are not retried', async t => {
  const bad = await node(t, (req, res) => res.end(JSON.stringify({ error: {
    message: 'transaction reverted', data: JSON.stringify({ logs: ['insufficient mana'] }),
  } })));
  const good = await node(t, success);
  const provider = configureRpcProvider(new Provider([bad.url, good.url]));
  await assert.rejects(provider.call('chain.submit_transaction', {}), /insufficient mana/);
  assert.equal(good.calls.length, 0);
});
