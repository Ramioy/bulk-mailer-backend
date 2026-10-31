import type { Block } from '../../domain/block/block';
import type { Period } from '../../domain/period/period';
import type { Receipt } from '../../domain/receipt/receipt';
import { err, ok, type Result } from '../../domain/shared/result';
import {
  cachedResolver,
  isRecipientError,
  publishNextManifest,
  refuseBatchCommand,
  type BatchCommandError,
  type ReceiptDependencies,
} from './receipt-dependencies';

/** Queries the source again for every PENDING or FAILED receipt of the batch (assumption A4). */
export class RefreshRecipients {
  constructor(private readonly deps: ReceiptDependencies) {}

  execute(operator: string, period: Period, block: Block): Promise<Result<{ manifestVersion: number; refreshed: number }, BatchCommandError | 'BATCH_NOT_FOUND'>> {
    return this.deps.serial.run(async () => {
      const refusal = await refuseBatchCommand(this.deps, period);
      if (refusal) return err(refusal);
      const { repository, clock } = this.deps;
      if (!(await repository.batches.get(period, block))) return err('BATCH_NOT_FOUND');

      const resolve = cachedResolver(this.deps, block);
      const now = clock.now();
      const updated: Receipt[] = [];
      for (const receipt of await repository.receipts.listByBatch(period, block)) {
        if ((receipt.state !== 'PENDING' && receipt.state !== 'FAILED') || receipt.contract === undefined) continue;
        const resolution = await resolve(receipt.contract);
        // A send error of a FAILED receipt stays visible unless a recipient error replaces it.
        const keptError = isRecipientError(receipt.errorType) ? undefined : receipt.errorType;
        updated.push({ ...receipt, recipient: resolution.recipient, errorType: resolution.errorType ?? keptError, updatedAt: now });
      }

      const manifest = await repository.transaction(async (tx) => {
        for (const receipt of updated) await tx.receipts.save(receipt);
        const published = await publishNextManifest(tx, period, block, now);
        await tx.audit.append({
          auditId: this.deps.newId(),
          actor: operator,
          action: 'RECIPIENTS_REFRESHED',
          at: now,
          subject: `${period.toString()}/${block}`,
          newValue: `manifest v${published.version}`,
        });
        return published;
      });
      return ok({ manifestVersion: manifest.version, refreshed: updated.length });
    });
  }
}
