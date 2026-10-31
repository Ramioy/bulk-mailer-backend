import type { DeliveryEvent } from '../../domain/receipt/delivery-state';
import type { Receipt, ReceiptHistoryEntry } from '../../domain/receipt/receipt';
import type { Sha256 } from '../../domain/receipt/sha256';
import type { Attempt } from '../../domain/sending/attempt';
import { err, ok, type Result } from '../../domain/shared/result';
import type { BulkMailerRepository } from '../../ports/bulk-mailer-repository';

export interface ReceiptHistoryView {
  readonly sha256: Sha256;
  readonly fileName: string;
  readonly period: string;
  readonly block: string;
  readonly state: Receipt['state'];
  readonly errorType?: Receipt['errorType'];
  readonly deliveryState?: Receipt['deliveryState'];
  /** Every send of the receipt, oldest first, each with the delivery events the provider reported for it. */
  readonly attempts: ReadonlyArray<Omit<Attempt, 'sha256'> & { readonly events: readonly DeliveryEvent[] }>;
  /** What happened to the receipt, oldest first (§13: the operator must see the whole story of a file). */
  readonly history: ReadonlyArray<Omit<ReceiptHistoryEntry, 'sha256'>>;
}

export type GetReceiptHistoryError = 'RECEIPT_NOT_FOUND';

/** D59: the story of one receipt for the web client: attempts with provider ids, delivery events and history. Read-only. */
export class GetReceiptHistory {
  constructor(private readonly deps: { readonly repository: BulkMailerRepository }) {}

  async execute(sha256: Sha256): Promise<Result<ReceiptHistoryView, GetReceiptHistoryError>> {
    const { repository } = this.deps;
    const receipt = await repository.receipts.get(sha256);
    if (!receipt) return err('RECEIPT_NOT_FOUND');
    const attempts = await repository.attempts.listByReceipt(sha256);
    const withEvents = [];
    for (const { sha256: _owner, ...attempt } of attempts) {
      withEvents.push({ ...attempt, events: await repository.deliveryEvents.listByAttempt(attempt.attemptId) });
    }
    const history = (await repository.receipts.history(sha256)).map(({ sha256: _owner, ...entry }) => entry);
    return ok({
      sha256: receipt.sha256,
      fileName: receipt.fileName,
      period: receipt.period.toString(),
      block: receipt.block,
      state: receipt.state,
      ...(receipt.errorType ? { errorType: receipt.errorType } : {}),
      ...(receipt.deliveryState ? { deliveryState: receipt.deliveryState } : {}),
      attempts: withEvents,
      history,
    });
  }
}
