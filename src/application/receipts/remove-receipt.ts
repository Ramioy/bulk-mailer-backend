import type { Sha256 } from '../../domain/receipt/sha256';
import { err, ok, type Result } from '../../domain/shared/result';
import { domainEvent } from '../events/domain-events';
import { retireFile } from '../files/retire-file';
import { publishNextManifest, refuseCorrection, type BatchCommandError, type ReceiptDependencies } from './receipt-dependencies';

export type RemoveReceiptError = BatchCommandError | 'RECEIPT_NOT_FOUND' | 'RECEIPT_NOT_REMOVABLE';

/** Only receipts not sent can be removed: PENDING, INVALID or FAILED. */
const REMOVABLE = new Set(['PENDING', 'INVALID', 'FAILED']);

export class RemoveReceipt {
  constructor(private readonly deps: ReceiptDependencies) {}

  execute(operator: string, sha256: Sha256): Promise<Result<{ manifestVersion: number }, RemoveReceiptError>> {
    return this.deps.serial.run(async () => {
      const { repository, clock } = this.deps;
      const receipt = await repository.receipts.get(sha256);
      if (!receipt) return err('RECEIPT_NOT_FOUND');
      const refusal = await refuseCorrection(repository);
      if (refusal) return err(refusal);
      if (!REMOVABLE.has(receipt.state)) return err('RECEIPT_NOT_REMOVABLE');

      const now = clock.now();
      const manifest = await repository.transaction(async (tx) => {
        // Saved from what this transaction reads (D37); inside the executor nothing else changed it since.
        const current = (await tx.receipts.get(sha256)) ?? receipt;
        // Removing also ends a duplicate conflict (D31): the content can be uploaded again under the right name.
        await tx.receipts.save({ ...current, state: 'REMOVED', fileAvailable: false, conflictingNames: undefined, updatedAt: now });
        // D50: deleted by a job queued here (D41), never after the commit where a failure would answer 500.
        await retireFile(tx, { ...current, fileAvailable: true }, now);
        await tx.receipts.appendHistory({ sha256, at: now, event: 'REMOVED', detail: `by ${operator}` });
        const published = await publishNextManifest(tx, receipt.period, receipt.block, now);
        await tx.audit.append({
          auditId: this.deps.newId(),
          actor: operator,
          action: 'RECEIPT_REMOVED',
          at: now,
          subject: sha256,
          previousValue: receipt.state,
          newValue: 'REMOVED',
          note: receipt.fileName,
        });
        await tx.outbox.add(
          domainEvent(this.deps.newId, 'RECEIPT_REMOVED', now, { sha256, period: receipt.period.toString(), block: receipt.block, manifestVersion: published.version }),
        );
        return published;
      });
      return ok({ manifestVersion: manifest.version });
    });
  }
}
