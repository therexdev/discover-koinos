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
  and expected balances/state. The production KoinDX helper still uses its
  existing mainnet router; no testnet routing or deployment is added here.

Run `npm test` for offline regression coverage, including queue ordering,
mana exhaustion, canonical/reverted/orphaned receipt outcomes, lost
responses, pending-state restarts, and progress only after confirmation.
