import type { Block } from '../../domain/block/block';
import type { Period } from '../../domain/period/period';
import { err, ok, type Result } from '../../domain/shared/result';
import { domainEvent } from '../events/domain-events';
import { publishNextManifest, refuseCorrection, type ReceiptDependencies } from '../receipts/receipt-dependencies';
import { retireFile } from './retire-file';

export type ReleaseBatchFilesError = 'EXECUTION_IN_PROGRESS' | 'BATCH_NOT_FOUND' | 'NOTE_REQUIRED';

export interface ReleasedBatchFiles {
  readonly released: number;
  readonly manifestVersion: number;
}

/**
 * D51: the files of receipts that stay "needed" (a FAILED never resent, a PENDING never corrected, a conflict) are
 * kept indefinitely until the operator releases them, one batch at a time. The records stay: only the file goes, by a
 * job queued in the same transaction (D41). States, errors and conflicts do not change; the summary then shows
 * FILE_NOT_AVAILABLE and the file can be uploaded again (A2). Like the other corrections (D50, B3) it is allowed in
 * any period and refused only while an execution runs. A receipt being sent (SENDING) keeps its file. Inside the serial
 * executor, in one transaction, without external calls (D36).
 */
export class ReleaseBatchFiles {
  constructor(private readonly deps: Pick<ReceiptDependencies, 'repository' | 'clock' | 'newId' | 'serial'>) {}

  async execute(operator: string, period: Period, block: Block, rawNote: string): Promise<Result<ReleasedBatchFiles, ReleaseBatchFilesError>> {
    const note = rawNote.trim();
    if (note === '') return err('NOTE_REQUIRED');
    const { repository, clock, newId } = this.deps;
    return this.deps.serial.run(() =>
      repository.transaction(async (tx): Promise<Result<ReleasedBatchFiles, ReleaseBatchFilesError>> => {
        if (!(await tx.batches.get(period, block))) return err('BATCH_NOT_FOUND');
        const refusal = await refuseCorrection(tx);
        if (refusal) return err(refusal);
        const now = clock.now();
        const releasable = (await tx.receipts.listByBatch(period, block)).filter((r) => r.fileAvailable && r.state !== 'SENDING');
        for (const receipt of releasable) {
          await tx.receipts.save({ ...receipt, fileAvailable: false, updatedAt: now });
          await retireFile(tx, receipt, now);
          await tx.receipts.appendHistory({ sha256: receipt.sha256, at: now, event: 'FILE_RELEASED', detail: `by ${operator}` });
        }
        // Ready entries may have left the batch: the operator reviews a new manifest before the next execution.
        const published = await publishNextManifest(tx, period, block, now);
        await tx.audit.append({
          auditId: newId(),
          actor: operator,
          action: 'BATCH_FILES_RELEASED',
          at: now,
          subject: `${period.toString()}/${block}`,
          newValue: String(releasable.length),
          note,
        });
        await tx.outbox.add(
          domainEvent(newId, 'BATCH_FILES_RELEASED', now, {
            period: period.toString(),
            block,
            released: releasable.length,
            manifestVersion: published.version,
            by: operator,
          }),
        );
        return ok({ released: releasable.length, manifestVersion: published.version });
      }),
    );
  }
}
