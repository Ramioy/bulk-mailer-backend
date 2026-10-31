import type { BatchState } from '../../domain/batch/batch-state';
import { readyManifestEntries } from '../sending/ready-entries';
import type { Block } from '../../domain/block/block';
import type { Period } from '../../domain/period/period';
import type { DeliveryState } from '../../domain/receipt/delivery-state';
import type { Receipt } from '../../domain/receipt/receipt';
import type { ReceiptState } from '../../domain/receipt/receipt-state';
import type { Sha256 } from '../../domain/receipt/sha256';
import type { BatchStopReason, ReceiptErrorType } from '../../domain/shared/error-types';
import type { ReceiptDependencies } from './receipt-dependencies';

export interface ReceiptView {
  readonly sha256: Sha256;
  readonly fileName: string;
  readonly conceptKey?: string;
  readonly contract?: string;
  /** Per the contract source. */
  readonly complexName?: string;
  readonly email?: string;
  readonly state: ReceiptState;
  /** The receipt's own error, also when its file is missing (D42). */
  readonly errorType?: ReceiptErrorType;
  readonly errorDetail?: string;
  readonly fileAvailable: boolean;
  /**
   * D42: a PENDING or FAILED receipt without its file (purged after being processed): it must be uploaded again before
   * it can be sent, whatever `errorType` says.
   */
  readonly fileError?: 'FILE_NOT_AVAILABLE';
  readonly attempts: number;
  readonly deliveryState?: DeliveryState;
  /** D31: the other names the same content arrived under; the operator must choose one or remove the receipt. */
  readonly conflictingNames?: ReadonlyArray<{ readonly fileName: string; readonly period: string; readonly block: Block; readonly conceptKey: string; readonly contract: string }>;
}

export interface BatchSummary {
  readonly period: string;
  readonly block: Block;
  /** Absent before the first upload. */
  readonly state?: BatchState;
  readonly stopReason?: BatchStopReason;
  /** Version the operator must send with "Send". 0 before the first upload. */
  readonly manifestVersion: number;
  readonly archiveCopyEnabled: boolean;
  /** Exactly the receipts of the manifest. */
  readonly readyToSend: readonly ReceiptView[];
  /** INVALID, and PENDING/FAILED without a resolved recipient or without file. */
  readonly needsCorrection: readonly ReceiptView[];
  readonly sending: readonly ReceiptView[];
  readonly sent: readonly ReceiptView[];
  readonly uncertain: readonly ReceiptView[];
  readonly removed: readonly ReceiptView[];
}

const view = (r: Receipt): ReceiptView => ({
  sha256: r.sha256,
  fileName: r.fileName,
  conceptKey: r.conceptKey,
  contract: r.contract,
  complexName: r.recipient?.complexName,
  email: r.recipient?.email,
  state: r.state,
  errorType: r.errorType,
  errorDetail: r.errorDetail,
  fileAvailable: r.fileAvailable,
  // A PENDING or FAILED receipt whose file was purged needs it uploaded again before it can be sent (D42).
  ...((r.state === 'PENDING' || r.state === 'FAILED') && !r.fileAvailable ? { fileError: 'FILE_NOT_AVAILABLE' as const } : {}),
  attempts: r.attempts,
  deliveryState: r.deliveryState,
  ...(r.conflictingNames?.length
    ? { conflictingNames: r.conflictingNames.map((n) => ({ fileName: n.fileName, period: n.period.toString(), block: n.block, conceptKey: n.conceptKey, contract: n.contract })) }
    : {}),
});

/** What the operator reviews before sending. Fetching it is audited as "reviewed", with its manifest version. */
export class GetBatchSummary {
  constructor(private readonly deps: ReceiptDependencies) {}

  async execute(operator: string, period: Period, block: Block): Promise<BatchSummary> {
    const { repository, clock } = this.deps;
    const batch = await repository.batches.get(period, block);
    const manifest = batch && (await repository.batches.getManifest(period, block, batch.manifestVersion));
    // In the manifest and still ready now: after an execution, SENT receipts are no longer "ready".
    const inManifest = new Set((manifest ? await readyManifestEntries(repository, manifest) : []).map((e) => e.sha256));
    const receipts = await repository.receipts.listByBatch(period, block);
    const of = (...states: ReceiptState[]) => receipts.filter((r) => states.includes(r.state)).map(view);

    if (batch) {
      await repository.audit.append({
        auditId: this.deps.newId(),
        actor: operator,
        action: 'BATCH_REVIEWED',
        at: clock.now(),
        subject: `${period.toString()}/${block}`,
        newValue: `manifest v${batch.manifestVersion}`,
      });
    }

    return {
      period: period.toString(),
      block,
      state: batch?.state,
      stopReason: batch?.stopReason,
      manifestVersion: batch?.manifestVersion ?? 0,
      archiveCopyEnabled: await repository.settings.archiveCopyEnabled(),
      readyToSend: receipts.filter((r) => inManifest.has(r.sha256)).map(view),
      needsCorrection: receipts
        .filter((r) => r.state === 'INVALID' || ((r.state === 'PENDING' || r.state === 'FAILED') && !inManifest.has(r.sha256)))
        .map(view),
      sending: of('SENDING'),
      sent: of('SENT'),
      uncertain: of('UNCERTAIN'),
      removed: of('REMOVED'),
    };
  }
}
