# Keeper submission and confirmation

The keeper checks live sponsor mana inside the shared transaction queue,
after preparation/signing and immediately before every submission. An
unreadable balance pauses work. Ordinary operations require the configured
floor; every pool-upload candidate requires at least 85 KOIN of mana (or
the configured floor if higher).

The chain helper resolves a transaction only after finding its ID in a
block on the sampled current head's chain and a matching, nonreverted
transaction receipt. A canonical revert is failure. Missing receipts,
orphan references, and unreadable outcomes remain pending. This is
canonical confirmation when observed, not irreversible confirmation.

Before broadcasting, the keeper atomically writes the transaction ID,
launch ID, action and timestamp to `DATA_DIR/keeper-pending.json`. The
journal contains no keys, signatures or transaction payloads. It binds to
the chain ID, configured network, launchpad and payer. A malformed or
mismatched journal prevents keeper work. Preserve this file across
restarts and deployments along with the existing runtime data.

Every cycle reconciles outstanding IDs before reading launch states or
starting new work. An ambiguous outcome pauses **all keeper submissions**,
including other launches using the same payer nonce. A confirmed success
clears the record, then fresh on-chain launch state determines subsequent
work. A definitive submission rejection or canonical revert clears the
record and follows the existing failure/backoff policy. The keeper never
automatically rebroadcasts or replaces a pending transaction.

Every queued `devTx`, including interactive orderbook market creation,
reloads this journal before preparing the sponsor nonce. Unresolved or
unreadable keeper IDs prevent submission; only a canonical confirmed or
reverted receipt permits it to continue. This check works before the
keeper loop starts and when that loop is disabled. The keeper remains the
journal's writer, so interactive checks do not clear its records. The
check precedes the keeper's `beforeSend` hook, which prevents a newly
recorded transaction from blocking its own first broadcast. Separate
contract and user payees retain their existing nonce behavior.

Both paths use `DATA_DIR/keeper-pending.json`. A programmatic alternative
must be configured as `chain.configure({ keeperPendingFile: ... })` during
startup, before serving requests. The keeper also shares its `pendingFile`
override with the chain facade when constructed.

## Operational limits

- Protection requires one gateway/keeper process and no external use of
  the sponsor's nonce. There is no cross-process file lock or distributed
  nonce coordinator. Other applications remain outside this guard.
- The journal records keeper submissions only. All gateway `devTx`
  callers respect those reservations, but ambiguous transactions initiated
  by interactive actions do not acquire their own durable reservation.
  This patch does not add a journal for every gateway transaction.
- A crash between journal persistence and broadcast can leave an ID that
  was never sent. The keeper deliberately stays paused. Investigate the
  saved ID, canonical receipts and account nonce before operator recovery;
  elapsed time alone is not proof of rejection. No automated recovery or
  signed-payload resubmitter is provided.
- Reorganizations after the sampled canonical receipt remain possible.
  Release rehearsal evidence must separately establish irreversibility
  and expected balances/state. The production KoinDX helper uses its
  existing mainnet router and refuses to invoke it on another network.

Run `npm test` for offline regression coverage, including queue ordering,
mana exhaustion, canonical/reverted/orphaned receipt outcomes, lost
responses, pending-state restarts, and progress only after confirmation.

## Isolated Harbinger integration

`scripts/rehearse-keeper.js` runs one manual cycle of the real keeper,
chain facade, durable pending store and receipt confirmation helper.
The private absolute JSON configuration supplies test keys by file path,
explicit account addresses, deployed bytecode hashes, fixed launch terms,
and separate output paths. No test configuration is loaded by `server.js`.

```sh
node scripts/rehearse-keeper.js /absolute/private/config.json --check
node scripts/rehearse-keeper.js /absolute/private/config.json
```

The first command performs only reads. The second may submit one or more
keeper actions for the selected launch during a single cycle. It does not
start a background process. Invoke it again only after reviewing that
cycle's report and pending journal. Keep a single writer and coordinate
all other activity using the same sponsor wallet.

The harness requires the pinned Harbinger chain ID and RPC, a new launch
ID of at least 5, a sale capped at 0.1 tKOIN, and exact preservation of
launch 3 for the separate seven-day reclaim. It verifies deployed metadata
and launch terms before each broadcast. Metadata comes from the existing
isolated fixture's `System.getContractMetadata` reader; it is not a
trustless state proof. An existing pinned pool is mandatory. Only
finalize, process, claim_locked, provide_liquidity and claim_liquidity
calls for that one launch are allowed. Uploads, orderbook changes, token
transfers and calls to other launches are rejected by the harness.

`createHarbingerRehearsalDex` reuses the production KoinDX pair lookup with
an explicit test router, verifies its hash and authority metadata and
fresh chain ID, and disables pool creation and mainnet bytecode caches.
Creator-token and LP claims additionally require actual chain time to
reach the on-chain deadlines. The ID-only production pending journal is
preserved across invocations. Reports contain IDs, receipts, launch state
and logs, never private keys or signed transaction payloads.

This exercises production modules in a local process. It does not prove
hosted deployment configuration, browser signing, new pool creation,
mainnet router provenance, or irreversible finality. Those require
separate checks and evidence.
