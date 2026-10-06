'use strict';

/* A transaction-store reference alone can point at an orphan. Confirm the
   transaction and its receipt in an ancestor of the current head instead.
   This establishes canonical inclusion when polled, not irreversibility. */
async function transactionOutcome(provider, txId) {
  const pending = reason => ({ status: 'pending', txId, reason });
  const { transactions } = await provider.getTransactionsById([txId]);
  const stored = (transactions || []).find(t => t?.transaction?.id === txId);
  const candidates = [...new Set(stored?.containing_blocks || [])];
  if (!candidates.length) return pending('no containing block');

  const { block_items: items } = await provider.getBlocksById(candidates,
    { returnBlock: false, returnReceipt: false });
  const head = (await provider.getHeadInfo())?.head_topology;
  if (!head?.id) return pending('head unavailable');
  for (const candidate of items || []) {
    const height = Number(candidate.block_height);
    if (!candidates.includes(candidate.block_id) || !Number.isSafeInteger(height) || height < 1) continue;
    const blocks = await provider.getBlocks(height, 1, head.id,
      { returnBlock: true, returnReceipt: true });
    const canonical = (blocks || []).find(b => b.block_id === candidate.block_id);
    if (!canonical || canonical.block?.id !== candidate.block_id ||
        Number(canonical.block_height) !== height || Number(canonical.block?.header?.height) !== height ||
        canonical.receipt?.id !== candidate.block_id) continue;
    if (!canonical.block.transactions?.some(t => t.id === txId)) continue;
    const receipt = canonical.receipt.transaction_receipts?.find(r => r.id === txId);
    // Protobuf JSON omits a false boolean. Any other representation is not
    // enough evidence to report success.
    if (!receipt || (receipt.reverted !== undefined && typeof receipt.reverted !== 'boolean')) continue;
    return {
      status: receipt.reverted ? 'reverted' : 'confirmed',
      txId, blockId: canonical.block_id, blockNumber: height, receipt,
    };
  }
  return pending('no canonical transaction receipt');
}

async function waitForTransaction(provider, txId, {
  timeoutMs = 90000, pollMs = 2500, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + timeoutMs;
  let reason = 'no canonical transaction receipt';
  while (now() < deadline) {
    let outcome;
    try { outcome = await transactionOutcome(provider, txId); }
    catch (error) { reason = `last poll error: ${String(error.message || error).slice(0, 120)}`; }
    if (outcome?.status === 'confirmed') return outcome;
    if (outcome?.status === 'reverted') {
      const details = (outcome.receipt.logs || []).join('; ').slice(0, 300);
      const error = new Error(`transaction ${txId} reverted${details ? `: ${details}` : ''}`);
      Object.assign(error, outcome, { confirmed: true, reverted: true, broadcast: true });
      throw error;
    }
    if (outcome) reason = outcome.reason;
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  const error = new Error(`transaction ${txId} not confirmed within ${Math.round(timeoutMs / 1000)}s (${reason})`);
  Object.assign(error, { txId, pending: true, broadcast: true });
  throw error;
}

module.exports = { transactionOutcome, waitForTransaction };
