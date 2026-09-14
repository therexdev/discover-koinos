'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createChainStartup } = require('../tools/chain-startup');

test('a failed live startup retries once at a time and starts services only after recovery', async t => {
  let attempts = 0, services = 0, errors = 0, active = 0, maxActive = 0;
  const startup = createChainStartup({
    demo: false, retryMs: 10,
    connect: async () => {
      attempts++; maxActive = Math.max(maxActive, ++active);
      await delay(10); active--;
      if (attempts < 2) throw new Error('RPC unavailable');
    },
    onReady: () => { services++; }, onError: () => { errors++; },
  });
  t.after(() => startup.stop());
  await Promise.all([startup.start(), startup.start(), startup.start()]);
  assert.equal(startup.status(), 'reconnecting');
  assert.equal(startup.ready(), false);
  for (let i = 0; i < 100 && !startup.ready(); i++) await delay(5);
  assert.equal(startup.status(), 'ready');
  await startup.start();
  assert.equal(attempts, 2); assert.equal(maxActive, 1);
  assert.equal(services, 1); assert.equal(errors, 1);
});

test('an optional startup service failure cannot disable a healthy connection', async t => {
  let attempts = 0;
  const startup = createChainStartup({ demo: false, retryMs: 5,
    connect: async () => { attempts++; }, onReady: () => { throw new Error('keeper unavailable'); },
  });
  t.after(() => startup.stop());
  await startup.start(); await delay(20);
  assert.equal(startup.ready(), true); assert.equal(attempts, 1);
});

test('intentional demo mode never connects; stopping cancels retries', async () => {
  let attempts = 0;
  const demo = createChainStartup({ demo: true, connect: () => { attempts++; } });
  await demo.start(); assert.equal(demo.status(), 'demo'); assert.equal(attempts, 0);
  const live = createChainStartup({ demo: false, retryMs: 10,
    connect: () => { attempts++; throw new Error('offline'); },
  });
  await live.start(); live.stop(); await delay(25);
  assert.equal(attempts, 1);
});
