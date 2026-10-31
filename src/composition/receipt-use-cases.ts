import { GetBatchSummary } from '../application/receipts/get-batch-summary';
import type { ReceiptDependencies } from '../application/receipts/receipt-dependencies';
import { RefreshRecipients } from '../application/receipts/refresh-recipients';
import { RemoveReceipt } from '../application/receipts/remove-receipt';
import { ResolveDuplicateConflict } from '../application/receipts/resolve-duplicate-conflict';
import { UploadReceipts } from '../application/receipts/upload-receipts';

export interface ReceiptUseCases {
  readonly upload: UploadReceipts;
  readonly remove: RemoveReceipt;
  readonly refresh: RefreshRecipients;
  readonly summary: GetBatchSummary;
  readonly resolveConflict: ResolveDuplicateConflict;
}

export function receiptUseCases(deps: ReceiptDependencies): ReceiptUseCases {
  return {
    upload: new UploadReceipts(deps),
    remove: new RemoveReceipt(deps),
    refresh: new RefreshRecipients(deps),
    summary: new GetBatchSummary(deps),
    resolveConflict: new ResolveDuplicateConflict(deps),
  };
}
