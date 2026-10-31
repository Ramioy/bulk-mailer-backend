import { assertBatchTransition } from '../../domain/batch/batch-state';
import type { Block } from '../../domain/block/block';
import type { Period } from '../../domain/period/period';
import type { Receipt } from '../../domain/receipt/receipt';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import { domainEvent } from '../events/domain-events';
import { retireBatchFiles } from '../files/retire-file';
import { readyManifestEntries } from './ready-entries';

/**
 * D41: the files of a processed batch that nobody needs any more: marked unavailable in this transaction, deleted by
 * a job after the commit. Used when an execution completes and when a stopped batch settles.
 */
export async function retireProcessedFiles(tx: BulkMailerStores, period: Period, block: Block, now: Date): Promise<void> {
  const retired: Receipt['sha256'][] = [];
  for (const receipt of await tx.receipts.listByBatch(period, block)) {
    if (!receipt.fileAvailable) continue;
    await tx.receipts.save({ ...receipt, fileAvailable: false, updatedAt: now });
    retired.push(receipt.sha256);
  }
  await retireBatchFiles(tx, period, block, retired, now);
}

/**
 * D41: a STOPPED batch with nothing left to send (no ready receipt in its manifest) and nothing left to resolve (no
 * SENDING, no UNCERTAIN) becomes COMPLETED, like a batch whose execution processed everything, and its files are
 * retired. Called by whatever resolves a receipt of a stopped batch (an UNCERTAIN, or late evidence). This is the
 * only path STOPPED → COMPLETED. An OPEN batch is never closed: the operator may still upload.
 */
export async function settleBatchIfDone(tx: BulkMailerStores, newId: () => string, now: Date, period: Period, block: Block): Promise<boolean> {
  const batch = await tx.batches.get(period, block);
  if (batch?.state !== 'STOPPED') return false;
  const receipts = await tx.receipts.listByBatch(period, block);
  if (receipts.some((r) => r.state === 'SENDING' || r.state === 'UNCERTAIN')) return false;
  const manifest = await tx.batches.getManifest(period, block, batch.manifestVersion);
  if (manifest && (await readyManifestEntries(tx, manifest)).length > 0) return false;

  assertBatchTransition(batch.state, 'COMPLETED');
  await tx.batches.save({ ...batch, state: 'COMPLETED', stopReason: undefined, updatedAt: now });
  await retireProcessedFiles(tx, period, block, now);
  await tx.outbox.add(domainEvent(newId, 'BATCH_COMPLETED', now, { period: period.toString(), block, by: 'settlement' }));
  return true;
}
