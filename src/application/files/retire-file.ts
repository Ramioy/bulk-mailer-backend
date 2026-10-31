import type { Block } from '../../domain/block/block';
import type { Period } from '../../domain/period/period';
import type { Receipt } from '../../domain/receipt/receipt';
import type { Sha256 } from '../../domain/receipt/sha256';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';

/**
 * D41: the file of a receipt is no longer needed (it reached SENT, or its batch was processed). The caller saves the
 * receipt with `fileAvailable: false` in the same transaction; this queues its deletion in that transaction too, so
 * the file is deleted after the commit and never before (a rollback must not lose a file that is still referenced).
 */
export async function retireFile(
  tx: Pick<BulkMailerStores, 'jobs'>,
  receipt: Pick<Receipt, 'period' | 'block' | 'sha256' | 'fileAvailable'>,
  now: Date,
): Promise<void> {
  if (!receipt.fileAvailable) return;
  await tx.jobs.enqueue({ type: 'DELETE_RECEIPT_FILE', payload: { period: receipt.period.toString(), block: receipt.block, sha256: receipt.sha256 }, runAt: now });
}

/** D41: one job for the files of a batch, with the explicit list of receipts whose file it may delete (D42). */
export async function retireBatchFiles(tx: Pick<BulkMailerStores, 'jobs'>, period: Period, block: Block, sha256s: readonly Sha256[], now: Date): Promise<void> {
  if (sha256s.length === 0) return;
  await tx.jobs.enqueue({ type: 'PURGE_BATCH_FILES', payload: { period: period.toString(), block, sha256s: [...sha256s] }, runAt: now });
}
