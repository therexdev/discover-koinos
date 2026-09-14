'use strict';

/* A live gateway waits for the chain; connection failure never enables
   simulated transactions. Only one attempt may run, including retries. */
function createChainStartup({ demo, connect, onReady = () => {}, onError = () => {}, retryMs = 30000 }) {
  let state = demo ? 'demo' : 'connecting';
  let pending = null;
  let timer = null;
  let stopped = false;
  const report = error => { try { onError(error); } catch (_) {} };

  function start() {
    if (stopped || state === 'demo' || state === 'ready') return Promise.resolve();
    if (pending) return pending;
    clearTimeout(timer);
    timer = null;
    pending = Promise.resolve().then(connect).then(() => {
      if (stopped) return;
      state = 'ready';
      // Optional background work must not change connection readiness.
      Promise.resolve().then(onReady).catch(report);
    }, error => {
      if (stopped) return;
      state = 'reconnecting';
      report(error);
      timer = setTimeout(start, retryMs);
      timer.unref?.();
    }).finally(() => { pending = null; });
    return pending;
  }

  return {
    start,
    status: () => state,
    ready: () => state === 'ready',
    stop() { stopped = true; clearTimeout(timer); },
  };
}

module.exports = { createChainStartup };
