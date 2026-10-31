import type { Block } from '../../domain/block/block';
import type { Period } from '../../domain/period/period';
import { inConflict, type Receipt } from '../../domain/receipt/receipt';
import { err, ok, type Result } from '../../domain/shared/result';
import { domainEvent } from '../events/domain-events';
import {
  isRecipientError,
  lookupRecipient,
  publishNextManifest,
  refuseBatchCommand,
  withSuppression,
  type BatchCommandError,
  type ReceiptDependencies,
  type RecipientResolution,
} from './receipt-dependencies';

export interface RefreshResult {
  readonly manifestVersion: number;
  readonly refreshed: number;
  /** D42: refreshed receipts that now have a recipient but no file: they need the PDF uploaded again. */
  readonly withoutFile: number;
}

const refreshable = (r: Receipt) => (r.state === 'PENDING' || r.state === 'FAILED') && r.contract !== undefined;

/**
 * Queries the source again for every PENDING or FAILED receipt of the batch (assumption A4). In two phases (D36): the
 * lookups outside the serial executor, then the receipts, the suppression list and the manifest inside it, in one
 * transaction, on the current state.
 */
export class RefreshRecipients {
  constructor(private readonly deps: ReceiptDependencies) {}

  async execute(operator: string, period: Period, block: Block): Promise<Result<RefreshResult, BatchCommandError | 'BATCH_NOT_FOUND'>> {
    const { repository, clock } = this.deps;
    // Phase (a): refused at once when it is already clear; one lookup per contract.
    const early = await refuseBatchCommand(this.deps, period);
    if (early) return err(early);
    if (!(await repository.batches.get(period, block))) return err('BATCH_NOT_FOUND');
    const lookups = new Map<string, RecipientResolution>();
    for (const receipt of (await repository.receipts.listByBatch(period, block)).filter(refreshable)) {
      const contract = receipt.contract as string;
      if (!lookups.has(contract)) lookups.set(contract, await lookupRecipient(this.deps, block, contract));
    }

    // Phase (b).
    return this.deps.serial.run(() =>
      repository.transaction(async (tx) => {
        const refusal = await refuseBatchCommand(this.deps, period, tx);
        if (refusal) return err(refusal);
        if (!(await tx.batches.get(period, block))) return err('BATCH_NOT_FOUND');
        const now = clock.now();
        let refreshed = 0;
        let withoutFile = 0;
        for (const receipt of (await tx.receipts.listByBatch(period, block)).filter(refreshable)) {
          const lookup = lookups.get(receipt.contract as string);
          // Uploaded after phase (a): its recipient was just resolved by that upload.
          if (!lookup) continue;
          const resolution = await withSuppression(tx, lookup);
          // A send error of a FAILED receipt stays visible unless a recipient error replaces it.
          const keptError = isRecipientError(receipt.errorType) ? undefined : receipt.errorType;
          // D31: a duplicate conflict stays the visible reason until the operator resolves it.
          const errorType = inConflict(receipt) ? 'DUPLICATE_CONFLICT' : (resolution.errorType ?? keptError);
          await tx.receipts.save({ ...receipt, recipient: resolution.recipient, errorType, updatedAt: now });
          refreshed += 1;
          // D42: resolvable now but its file was purged: it is not ready until the file is uploaded again.
          if (resolution.recipient && !receipt.fileAvailable) withoutFile += 1;
        }
        const published = await publishNextManifest(tx, period, block, now);
        await tx.audit.append({
          auditId: this.deps.newId(),
          actor: operator,
          action: 'RECIPIENTS_REFRESHED',
          at: now,
          subject: `${period.toString()}/${block}`,
          newValue: `manifest v${published.version}`,
        });
        await tx.outbox.add(domainEvent(this.deps.newId, 'RECIPIENTS_REFRESHED', now, { period: period.toString(), block, manifestVersion: published.version }));
        return ok({ manifestVersion: published.version, refreshed, withoutFile });
      }),
    );
  }
}
