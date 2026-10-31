import type { Receipt } from '../../domain/receipt/receipt';
import type { Sha256 } from '../../domain/receipt/sha256';
import { SendErrorType } from '../../domain/shared/error-types';
import { err, ok, type Result } from '../../domain/shared/result';
import { resolveReceiptAlerts } from '../alerts/resolve-alerts';
import { domainEvent } from '../events/domain-events';
import { retireFile } from '../files/retire-file';
import { settleBatchIfDone } from '../sending/batch-settlement';
import { latestAttempt, sentWithoutFile } from './apply-delivery-event';
import type { DeliveryDependencies } from './delivery-dependencies';

export type ResolveUncertainError = 'RECEIPT_NOT_FOUND' | 'RECEIPT_NOT_UNCERTAIN' | 'NOTE_REQUIRED';

/**
 * Manual resolution of an UNCERTAIN receipt (§9.4): the operator searched its client reference in ZeptoMail's
 * Processed Emails and marks it sent or not sent, with an evidence note. Audited.
 */
export class ResolveUncertain {
  constructor(private readonly deps: Pick<DeliveryDependencies, 'repository' | 'clock' | 'newId' | 'serial'>) {}

  execute(operator: string, sha256: Sha256, outcome: 'SENT' | 'NOT_SENT', note: string): Promise<Result<{ state: Receipt['state'] }, ResolveUncertainError>> {
    return this.deps.serial.run(async () => {
      const { repository, clock, newId } = this.deps;
      if (note.trim() === '') return err('NOTE_REQUIRED');
      return repository.transaction(async (tx) => {
        // Read in the transaction it is saved in (D37).
        const receipt = await tx.receipts.get(sha256);
        if (!receipt) return err('RECEIPT_NOT_FOUND');
        if (receipt.state !== 'UNCERTAIN') return err('RECEIPT_NOT_UNCERTAIN');
        const now = clock.now();
        const resolved: Receipt =
          outcome === 'SENT'
            ? sentWithoutFile(receipt, now)
            : { ...receipt, state: 'FAILED', errorType: SendErrorType.NOT_FOUND_AT_PROVIDER, errorDetail: 'resolved by the operator', updatedAt: now };
        await tx.receipts.save(resolved);
        // D41: a SENT receipt no longer needs its file; a FAILED one keeps it for the next execution.
        if (resolved.state === 'SENT') await retireFile(tx, receipt, now);
        await tx.receipts.appendHistory({ sha256, at: now, event: resolved.state, detail: `resolved by ${operator}: ${note.trim()}` });
        // D52: the UNCERTAIN attempt is the latest one.
        await resolveReceiptAlerts(tx, now, { sha256, from: receipt.state, to: resolved.state, attempt: await latestAttempt(tx, receipt) });
        await tx.audit.append({
          auditId: newId(),
          actor: operator,
          action: 'UNCERTAIN_RESOLVED',
          at: now,
          subject: sha256,
          previousValue: 'UNCERTAIN',
          newValue: resolved.state,
          note: note.trim(),
        });
        await tx.outbox.add(domainEvent(newId, 'RECEIPT_RESOLVED', now, { sha256, state: resolved.state, errorType: resolved.errorType, by: 'operator' }));
        await settleBatchIfDone(tx, newId, now, receipt.period, receipt.block);
        return ok({ state: resolved.state });
      });
    });
  }
}
