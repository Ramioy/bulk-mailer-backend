import type { Execution } from '../../domain/batch/batch';
import { canTransitionBatch } from '../../domain/batch/batch-state';
import type { Receipt } from '../../domain/receipt/receipt';
import { assertTransition } from '../../domain/receipt/receipt-state';
import type { BatchStopReason } from '../../domain/shared/error-types';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import type { ProgressCounters } from '../../ports/progress-notifier';
import { raiseAlert } from '../alerts/raise-alert';
import { domainEvent } from '../events/domain-events';

/**
 * Shared by the recovery at startup (§9.3) and the operator's abort (D32): what to do with an execution that is no
 * longer making progress, without knowing what its last provider call did.
 */

/**
 * A receipt left SENDING: nobody knows whether the provider received it, so it becomes UNCERTAIN and reconciliation
 * resolves it (never sent again blindly, C2). The event carries the attempt, so reconciliation is scheduled for it.
 */
export async function markSendingUncertain(
  tx: BulkMailerStores,
  newId: () => string,
  now: Date,
  receipt: Receipt,
  reason: string,
  attempt?: { readonly attemptId: string; readonly executionId?: string },
): Promise<void> {
  assertTransition(receipt.state, 'UNCERTAIN');
  await tx.receipts.save({ ...receipt, state: 'UNCERTAIN', updatedAt: now });
  await tx.receipts.appendHistory({ sha256: receipt.sha256, at: now, event: 'UNCERTAIN', detail: reason });
  await tx.outbox.add(
    domainEvent(newId, 'RECEIPT_UNCERTAIN', now, {
      sha256: receipt.sha256,
      reason,
      ...(attempt ? { attemptId: attempt.attemptId, ...(attempt.executionId ? { executionId: attempt.executionId } : {}) } : {}),
    }),
  );
}

/** Ends the execution and its batch STOPPED, with the EXECUTION_FINISHED event and the BATCH_STOPPED alert. */
export async function stopExecution(
  tx: BulkMailerStores,
  newId: () => string,
  now: Date,
  execution: Execution,
  stopReason: BatchStopReason,
  counters?: ProgressCounters,
): Promise<void> {
  await tx.executions.save({ ...execution, finishedAt: now, result: 'STOPPED', stopReason });
  const batch = await tx.batches.get(execution.period, execution.block);
  // Releasing the global lock matters more than a batch in an unexpected state, which is left as it is.
  if (batch && canTransitionBatch(batch.state, 'STOPPED')) await tx.batches.save({ ...batch, state: 'STOPPED', stopReason, updatedAt: now });
  await tx.outbox.add(
    domainEvent(newId, 'EXECUTION_FINISHED', now, { executionId: execution.executionId, result: 'STOPPED', stopReason, ...(counters ? { counters } : {}) }),
  );
  await raiseAlert(tx, newId, {
    alertId: newId(),
    type: 'BATCH_STOPPED',
    subject: execution.executionId,
    detail: `${execution.period.toString()}/${execution.block} stopped: ${stopReason}`,
    raisedAt: now,
  });
}

/** Counters of the last progress event, for the FINISHED event of an execution ended from outside its run. */
export async function lastCounters(stores: Pick<BulkMailerStores, 'executionEvents'>, executionId: string): Promise<ProgressCounters> {
  const last = await stores.executionEvents.last(executionId);
  return last && 'counters' in last.event ? last.event.counters : { total: 0, processed: 0, byState: {}, byErrorType: {} };
}
