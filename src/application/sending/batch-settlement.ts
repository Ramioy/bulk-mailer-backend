import { assertBatchTransition } from '../../domain/batch/batch-state';
import type { Block } from '../../domain/block/block';
import type { Period } from '../../domain/period/period';
import { inConflict, type Receipt } from '../../domain/receipt/receipt';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import { domainEvent } from '../events/domain-events';
import { retireBatchFiles } from '../files/retire-file';
import { readyManifestEntries } from './ready-entries';

/**
 * D42: a file the processed batch no longer needs: its receipt went through a send (SENT, FAILED, or UNCERTAIN, which
 * may still turn out not sent and then needs the operator to upload it again, as before) and is not held by a
 * duplicate conflict. A PENDING receipt (e.g. with a recipient error, never in the manifest) or one in
 * DUPLICATE_CONFLICT keeps its file. INVALID files are never stored.
 */
export function isProcessedFile(receipt: Receipt): boolean {
  const processed = receipt.state === 'SENT' || receipt.state === 'FAILED' || receipt.state === 'UNCERTAIN';
  return receipt.fileAvailable && processed && !inConflict(receipt);
}

/**
 * D41: the files of a processed batch that nobody needs any more (D42: `isProcessedFile`): marked unavailable in this
 * transaction, deleted by a job after the commit with their explicit list. Used when an execution completes and when
 * a stopped batch settles.
 */
export async function retireProcessedFiles(tx: BulkMailerStores, period: Period, block: Block, now: Date): Promise<void> {
  const retired: Receipt['sha256'][] = [];
  for (const receipt of await tx.receipts.listByBatch(period, block)) {
    if (!isProcessedFile(receipt)) continue;
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
