import type { Block } from '../../domain/block/block';
import type { Period } from '../../domain/period/period';
import type { DeliveryState } from '../../domain/receipt/delivery-state';
import type { Receipt } from '../../domain/receipt/receipt';
import type { Sha256 } from '../../domain/receipt/sha256';
import { err, ok, type Result } from '../../domain/shared/result';
import type { ProviderSendStatus } from '../../ports/send-lookup';
import { latestAttempt } from './apply-delivery-event';
import type { DeliveryDependencies } from './delivery-dependencies';
import { checkAttempt, isCheckable, type CheckOptions, type CheckResult } from './reconciliation';

/** D34: the operator may also verify a send failed as not found, in case it did go out after all. */
const MANUAL: CheckOptions = { lateEvidence: true };

export interface VerifiedReceipt {
  readonly sha256: Sha256;
  readonly fileName: string;
  readonly result: CheckResult;
  /** What the provider logs show, when found. */
  readonly providerStatus?: ProviderSendStatus;
  readonly detail?: string;
  readonly state: Receipt['state'];
  readonly deliveryState?: DeliveryState;
}

export type VerifyError = 'RECEIPT_NOT_FOUND' | 'RECEIPT_NOT_VERIFIABLE' | 'BATCH_NOT_FOUND';

/**
 * Manual verification (D22): the operator asks the provider logs now, for one receipt or for every receipt of a
 * batch whose delivery can still change. What is found is applied like the automatic checks do; an UNCERTAIN
 * receipt not found is never failed here (that is the last scheduled lookup's or the manual resolution's). A receipt
 * FAILED / NOT_FOUND_AT_PROVIDER can be verified too: if the logs show it now, it becomes SENT (D34). Audited.
 */
export class VerifyDelivery {
  constructor(private readonly deps: Pick<DeliveryDependencies, 'repository' | 'sendLookup' | 'clock' | 'newId' | 'serial'>) {}

  async receipt(operator: string, sha256: Sha256): Promise<Result<VerifiedReceipt, VerifyError>> {
    const receipt = await this.deps.repository.receipts.get(sha256);
    if (!receipt) return err('RECEIPT_NOT_FOUND');
    if (!isCheckable(receipt, MANUAL)) return err('RECEIPT_NOT_VERIFIABLE');
    const verified = await this.verify(receipt);
    await this.audit(operator, sha256, `${verified.result}${verified.providerStatus ? ` (${verified.providerStatus})` : ''}: ${verified.state}/${verified.deliveryState ?? '-'}`);
    return ok(verified);
  }

  async batch(operator: string, period: Period, block: Block): Promise<Result<{ readonly receipts: readonly VerifiedReceipt[] }, VerifyError>> {
    const { repository } = this.deps;
    if (!(await repository.batches.get(period, block))) return err('BATCH_NOT_FOUND');
    const verified: VerifiedReceipt[] = [];
    for (const receipt of await repository.receipts.listByBatch(period, block)) {
      if (isCheckable(receipt, MANUAL)) verified.push(await this.verify(receipt));
    }
    const updated = verified.filter((v) => v.result === 'UPDATED').length;
    await this.audit(operator, `${period.toString()}/${block}`, `${verified.length} checked, ${updated} updated`);
    return ok({ receipts: verified });
  }

  private async verify(receipt: Receipt): Promise<VerifiedReceipt> {
    const attempt = await latestAttempt(this.deps.repository, receipt);
    const outcome = attempt ? await checkAttempt(this.deps, attempt.attemptId, false, MANUAL) : { result: 'NOT_APPLICABLE' as const };
    const after = (await this.deps.repository.receipts.get(receipt.sha256)) ?? receipt;
    return {
      sha256: receipt.sha256,
      fileName: receipt.fileName,
      result: outcome.result,
      ...('providerStatus' in outcome && outcome.providerStatus ? { providerStatus: outcome.providerStatus } : {}),
      ...('detail' in outcome && outcome.detail ? { detail: outcome.detail } : {}),
      state: after.state,
      ...(after.deliveryState ? { deliveryState: after.deliveryState } : {}),
    };
  }

  private async audit(operator: string, subject: string, newValue: string): Promise<void> {
    const { repository, clock, newId, serial } = this.deps;
    await serial.run(() =>
      repository.transaction((tx) => tx.audit.append({ auditId: newId(), actor: operator, action: 'DELIVERY_VERIFIED', at: clock.now(), subject, newValue })),
    );
  }
}
