/* ============================================================
   Launchpad keeper — the off-chain half of auto-settlement.

   Koinos contracts cannot wake themselves up: somebody has to send the
   finalize / payout / unlock transactions once a launch's clock runs out.
   That somebody is this loop, and the mana comes from the gateway's
   sponsor wallet (the same mana sharer that pays for mints and launches),
   so neither creators nor buyers ever pay for settlement.

   Every cycle it reads the launchpad contract and acts on what it sees:

     ACTIVE past its end (or a FIXED sale sold out early)  -> finalize
     DISTRIBUTING / REFUNDING                              -> process batches
     COMPLETED with an expired lock                        -> claim_locked
     liquidity pending (after payouts, isolated)           -> create the
        KoinDX pool if missing (tools/koindx.js), provide_liquidity,
        then claim_liquidity for the creator once the LP lock expires

   Everything it calls is permissionless-by-design on the contract side
   (finalize/process/claim_locked are callable by anyone and always pay
   the rightful recipient), so the keeper holds no special authority —
   losing this loop only ever DELAYS settlement, it can never redirect it.

   Failures back off per launch (2, 4, 8 ... 60 minutes) so one broken
   token contract cannot spin the loop or drain sponsor mana, and a mana
   floor keeps settlement from eating the budget interactive actions need.
   ============================================================ */
'use strict';

const koindx = require('./koindx');
const { createPendingStore, keeperPendingFile } = require('./keeper-pending');

const STATUS_ACTIVE = 0;
const STATUS_DISTRIBUTING = 1;
const STATUS_COMPLETED = 2;
const STATUS_REFUNDING = 3;
const MODE_FIXED = 0;

/* Chain timestamps are ms; act a little late rather than a second early
   (an early finalize just reverts and wastes a transaction). */
const CLOCK_SLACK_MS = 5000;

/* Buyers settled per process() transaction (contract caps at 30) and
   batches per launch per cycle — 5 x 20 = 100 buyers a cycle keeps even a
   big launch settling briskly without monopolizing the sponsor wallet. */
const PROCESS_BATCH = 20;
const MAX_BATCHES_PER_CYCLE = 5;

/* Reads page at the contract's limit. */
const PAGE = 100;

/* Creating a KoinDX pool uploads a ~65KB contract — the priciest thing the
   sponsor ever pays for (rcLimitUpload caps it at 80 KOIN of mana). Only
   attempt it with clear headroom so ordinary settlement never starves. */
const POOL_CREATE_MANA = 85;

function createLaunchpadKeeper(opts) {
  const chain = opts.chain;                 // tools/koinos.js module
  const dex = opts.koindx || koindx;
  const rawLog = opts.log || ((m) => console.log(m));
  /* Every keeper line also lands in a small ring buffer served at
     /api/keeper-log — settlement problems must be diagnosable from a
     browser, without shell access to the host. */
  const recent = [];
  const log = (m) => {
    recent.push(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${m}`);
    if (recent.length > 100) recent.shift();
    rawLog(m);
  };
  const intervalMs = opts.intervalMs || 45000;
  /* Refuse to settle when sponsor mana drops under this (KOIN) — the same
     idea as the server's minManaAction floor. */
  const manaFloor = opts.manaFloor != null ? opts.manaFloor : 6;

  const backoff = new Map(); // launch id -> { fails, until }
  const marketEnsured = new Set(); // launch ids whose orderbook market exists
  let timer = null;
  let cycling = false;
  let pending;
  const pendingFile = opts.pendingFile || keeperPendingFile(chain.K.keeperPendingFile);
  // Keep programmatic path overrides visible to the shared devTx guard.
  // For protection before this loop is constructed, configure the path
  // on chain.K during startup (the default DATA_DIR path needs no setup).
  if (opts.pendingFile) chain.K.keeperPendingFile = pendingFile;

  const skipping = (id) => {
    const entry = backoff.get(id);
    return !!(entry && Date.now() < entry.until);
  };
  const failed = (id, what, error, capMinutes = 60) => {
    const entry = backoff.get(id) || { fails: 0, until: 0 };
    entry.fails += 1;
    const wait = Math.min(capMinutes, 2 ** entry.fails) * 60000;
    entry.until = Date.now() + wait;
    backoff.set(id, entry);
    log(`keeper:   launch #${id} ${what} failed — ${error.message} (next try in ${Math.round(wait / 60000)}m)`);
  };
  const succeeded = (id) => backoff.delete(id);

  async function manaOk() {
    try {
      const live = await chain.mana(chain.devAddress());
      if (live >= manaFloor) return true;
      log(`keeper:   paused — sponsor mana ${Math.floor(live)} under the ${manaFloor} floor`);
      return false;
    } catch (_) {
      return false; // chain unreadable: try again next cycle
    }
  }

  /* The chain helper calls this hook INSIDE its nonce/signing queue,
     immediately before each submission, including nested market/pool
     transactions. A post-action mana check cannot protect the first tx. */
  async function tracked(id, action, submit, floor = manaFloor) {
    let txId;
    const beforeSend = async (prepared) => {
      if (pending.get(id)) throw Object.assign(new Error('previous transaction still pending'), { pending: true });
      let live;
      try { live = await chain.mana(chain.devAddress()); } catch (_) { /* fail closed */ }
      if (!Number.isFinite(live) || live < floor) {
        throw Object.assign(new Error(`sponsor mana ${Number.isFinite(live) ? live : 'unreadable'}; need at least ${floor}`), { paused: true, floor });
      }
      txId = prepared.txId;
      if (!txId) throw new Error('prepared transaction has no ID');
      pending.set(id, { txId, action, createdAt: new Date().toISOString() });
    };
    try {
      const result = await submit({ beforeSend });
      if (txId) pending.clear(id, txId); // helper resolves only on canonical success
      return result;
    } catch (error) {
      if (txId && (error.rejected || (error.confirmed && error.reverted))) pending.clear(id, txId);
      // Unknown outcomes retain their ID across cycles AND process restarts.
      throw error;
    }
  }

  const settleTx = (id, action, operations) => tracked(id, action, options => chain.devTx(operations, options));

  async function reconcile(id) {
    const entry = pending.get(id);
    if (!entry) return true;
    const outcome = await chain.transactionOutcome(entry.txId);
    if (outcome.status !== 'confirmed' && outcome.status !== 'reverted') {
      log(`keeper:   launch #${id} ${entry.action} pending (${entry.txId}); awaiting canonical receipt`);
      return false;
    }
    pending.clear(id, entry.txId);
    if (outcome.status === 'reverted') {
      failed(id, entry.action, new Error(`transaction ${entry.txId} reverted in canonical block ${outcome.blockId}`));
      return false;
    }
    succeeded(id); succeeded(`${id}:liq`);
    log(`keeper:   launch #${id} ${entry.action} confirmed (${entry.txId})`);
    return true;
  }

  async function readLaunches() {
    const all = [];
    let start = 0;
    for (;;) {
      const { result } = await chain
        .launchpadContract()
        .functions.get_launches({ start, limit: PAGE });
      const page = (result && result.launches) || [];
      all.push(...page);
      if (page.length < PAGE) break;
      start = Number(page[page.length - 1].id);
    }
    return all;
  }

  const num = (v) => Number(v || 0);

  /* One step of the KoinDX machine for this launch. Returns true when it
     sent a transaction. Called in isolation: a DEX failure backs off ONLY
     the liquidity step, never payouts or locks. Every chain interaction is
     labeled so a failure line in /api/keeper-log names the exact call —
     debugging this remotely by deduction proved worthless. */
  async function liquidityStep(launch, now) {
    const id = Number(launch.id);
    const liqState = num(launch.liquidityState);
    const at = async (label, fn) => {
      try {
        return await fn();
      } catch (error) {
        error.message = `[${label}] ${error.message}`;
        throw error;
      }
    };

    if (liqState === 1 && BigInt(launch.liquidityKoin || 0) > 0n) {
      // the periphery only adds liquidity to an EXISTING pool, and pools
      // are born from a dedicated 2-op transaction the keeper must send
      // itself (see tools/koindx.js) — the contract cannot
      const token = String(launch.token);
      const pair = await at(`get_pair ${token.slice(0, 8)}…`, () => dex.getPair(chain, token));
      if (!pair) {
        const live = await at('read sponsor mana', () => chain.mana(chain.devAddress()));
        if (live < POOL_CREATE_MANA) {
          log(`keeper:   launch #${id} waiting for sponsor mana ≥${POOL_CREATE_MANA} to create the KoinDX pool (${Math.floor(live)} now)`);
          return false;
        }
        const poolChain = Object.create(chain);
        poolChain.sendAsAccount = (key, operations, options) => tracked(id, 'create_pair',
          hooks => chain.sendAsAccount(key, operations, { ...options, ...hooks }), Math.max(manaFloor, POOL_CREATE_MANA));
        const made = await at('create_pair', () => dex.createPair(poolChain, token, log));
        log(`keeper:   launch #${id} KoinDX pool created at ${made.pair}`);
        return true; // provide_liquidity follows next cycle
      }
      log(`keeper:   launch #${id} pool exists at ${pair} — calling provide_liquidity`);
      const { operation } = await at('build provide_liquidity op', () =>
        chain
          .launchpadContract(chain.devSigner())
          .functions.provide_liquidity({ launchId: id }, { onlyOperation: true })
      );
      await at('provide_liquidity tx', () => settleTx(id, 'provide_liquidity', [operation]));
      log(`keeper:   launch #${id} liquidity added on KoinDX`);
      return true;
    }

    if (
      liqState === 2 &&
      !launch.lpClaimed &&
      BigInt(launch.lpAmount || 0) > 0n &&
      now >= num(launch.lpUnlockTime) + CLOCK_SLACK_MS
    ) {
      const { operation } = await at('build claim_liquidity op', () =>
        chain
          .launchpadContract(chain.devSigner())
          .functions.claim_liquidity({ launchId: id }, { onlyOperation: true })
      );
      await at('claim_liquidity tx', () => settleTx(id, 'claim_liquidity', [operation]));
      log(`keeper:   launch #${id} LP tokens delivered to creator`);
      return true;
    }

    return false;
  }

  async function settleOne(launch) {
    const id = Number(launch.id);
    const now = Date.now();
    let status = num(launch.status);
    let acted = false;

    if (status === STATUS_ACTIVE) {
      const ended = now >= num(launch.endTime) + CLOCK_SLACK_MS;
      const soldOut =
        num(launch.mode) === MODE_FIXED &&
        num(launch.forSaleAmount) > 0 &&
        BigInt(launch.sold || 0) >= BigInt(launch.forSaleAmount || 0);
      if (!ended && !soldOut) return false;
      const { operation } = await chain
        .launchpadContract(chain.devSigner())
        .functions.finalize({ launchId: id }, { onlyOperation: true });
      await settleTx(id, 'finalize', [operation]);
      log(`keeper:   launch #${id} finalized`);
      return true;
    }

    // 1 — buyers FIRST. Payouts (or refunds) are the launchpad's promise;
    // they must never wait on markets or liquidity. A failure here throws
    // to the caller and backs off the whole launch — distributing is the
    // one thing there is no point continuing without.
    if (status === STATUS_DISTRIBUTING || status === STATUS_REFUNDING) {
      const verb = status === STATUS_DISTRIBUTING ? 'paid out' : 'refunded';
      for (let batch = 0; batch < MAX_BATCHES_PER_CYCLE; batch++) {
        const { operation } = await chain
          .launchpadContract(chain.devSigner())
          .functions.process(
            { launchId: id, limit: PROCESS_BATCH },
            { onlyOperation: true }
          );
        await settleTx(id, 'process', [operation]);
        acted = true;
        const { result } = await chain
          .launchpadContract()
          .functions.get_launch({ launchId: id });
        const fresh = result && result.value;
        if (!fresh) break;
        launch = fresh;
        const pending = num(fresh.buyerCount) - num(fresh.cursor);
        if (num(fresh.status) !== status || pending <= 0) {
          log(`keeper:   launch #${id} fully ${verb} (${num(fresh.buyerCount)} buyers)`);
          status = num(fresh.status);
          break;
        }
        log(`keeper:   launch #${id} ${verb} batch done, ${pending} buyer(s) left`);
        if (!(await manaOk())) return true;
      }
      if (status === STATUS_DISTRIBUTING || status === STATUS_REFUNDING) {
        return acted; // not fully settled yet — later steps wait their turn
      }
    }

    // 2 — the creator's own token lock, once everyone else is paid
    if (
      status === STATUS_COMPLETED &&
      BigInt(launch.lockedAmount || 0) > 0n &&
      !launch.lockedClaimed &&
      now >= num(launch.unlockTime) + CLOCK_SLACK_MS
    ) {
      const { operation } = await chain
        .launchpadContract(chain.devSigner())
        .functions.claim_locked({ launchId: id }, { onlyOperation: true });
      await settleTx(id, 'claim_locked', [operation]);
      log(`keeper:   launch #${id} locked tokens delivered to creator`);
      acted = true;
    }

    // 3 — a successful launch gets its TOKEN/KOIN market on the Trade
    // Koinos orderbook (permissionless create; idempotent via lookup) so
    // the launch page can link straight to trading
    if (
      (status === STATUS_DISTRIBUTING || status === STATUS_COMPLETED) &&
      chain.dexEnabled() &&
      !marketEnsured.has(id)
    ) {
      try {
        await tracked(id, 'create_market', options => chain.ensureDexMarket(String(launch.token), options));
        marketEnsured.add(id);
      } catch (error) {
        if (error.paused || pending.get(id)) throw error;
        log(`keeper:   launch #${id} orderbook listing failed — ${error.message} (retrying next cycle)`);
      }
    }

    // 4 — KoinDX liquidity: create the pool when missing, then
    // provide_liquidity, then deliver the LP tokens when the lock expires.
    // Isolated with its own backoff so a DEX hiccup can never starve
    // payouts, locks, or other launches.
    if (status === STATUS_DISTRIBUTING || status === STATUS_COMPLETED) {
      const liqKey = `${id}:liq`;
      if (!skipping(liqKey)) {
        try {
          if (await liquidityStep(launch, now)) {
            succeeded(liqKey);
            acted = true;
          }
        } catch (error) {
          if (error.paused || pending.get(id)) throw error;
          /* the DEX leg retries much sooner than broken-launch backoff:
             10 minutes at worst (2, 4, 8, 10, 10 …) — a reverting attempt
             costs a little mana, but a settled pool shouldn't wait an hour */
          failed(liqKey, 'liquidity', error, 10);
        }
      }
    }

    return acted;
  }

  async function cycle() {
    if (cycling || !chain.launchpadEnabled()) return;
    cycling = true;
    try {
      if (!pending) pending = createPendingStore(pendingFile, {
        network: chain.K.network, chainId: await chain.chainId(),
        launchpad: chain.K.launchpadAddr, payer: chain.devAddress(),
      });
      // Keeper dev transactions share one nonce. Even another launch must
      // wait: preparing its tx now could replace the unresolved attempt.
      let unresolved = false;
      for (const [id] of pending.entries()) {
        if (!(await reconcile(Number(id)))) unresolved = true;
      }
      if (unresolved) return;
      const launches = await readLaunches();
      for (const launch of launches) {
        const id = Number(launch.id);
        let acted = false;
        try {
          if (skipping(id)) continue;
          acted = await settleOne(launch);
          if (acted) succeeded(id);
        } catch (error) {
          if (error.paused) {
            log(`keeper:   launch #${id} paused — ${error.message}`);
            if (error.floor === manaFloor) break;
            continue;
          }
          failed(id, 'settlement', error);
          if (pending.get(id)) break;
        }
        if (acted && !(await manaOk())) break;
      }
    } catch (error) {
      log(`keeper:   cycle skipped — ${error.message}`);
    } finally {
      cycling = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void cycle(), intervalMs);
      if (timer.unref) timer.unref();
      // first look shortly after boot, once the chain config has settled
      setTimeout(() => void cycle(), 5000);
      log(`keeper:   watching launchpad ${chain.K.launchpadAddr} (every ${Math.round(intervalMs / 1000)}s)`);
      /* bumped on every keeper/koindx change: the ONLY reliable way to see
         from /api/keeper-log which build a host is actually running */
      log(`keeper:   code v7, koindx module ${dex.VERSION || 'STALE (pre-v4 — deploy did not replace tools/koindx.js!)'}`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    recentLog: () => recent.slice(),
    cycle, // exposed for tests / manual pokes
  };
}

module.exports = { createLaunchpadKeeper };
