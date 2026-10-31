import type { Block } from '../block/block';
import type { Period } from '../period/period';
import type { ReceiptState } from './receipt-state';

export interface ExistingReceipt {
  readonly period: Period;
  readonly block: Block;
  readonly state: ReceiptState;
  readonly fileAvailable: boolean;
}

export const UploadDecision = {
  /** Unknown hash: a new receipt is registered. */
  NEW: 'NEW',
  /** Same hash in the same batch, INVALID, REMOVED or FAILED without file: that record is re-evaluated. */
  RE_EVALUATE: 'RE_EVALUATE',
  /** Same hash REMOVED from another batch: that record moves to this batch and is re-evaluated (D8). */
  MOVE: 'MOVE',
  /** Same content already registered: discarded, not stored, not counted. */
  DUPLICATE: 'DUPLICATE',
} as const;
export type UploadDecision = (typeof UploadDecision)[keyof typeof UploadDecision];

/** Rule for repeated files (assumption A1, decision D8). A second record for the same hash is never created. */
export function decideUpload(existing: ExistingReceipt | undefined, period: Period, block: Block): UploadDecision {
  if (!existing) return UploadDecision.NEW;
  const sameBatch = existing.period.equals(period) && existing.block === block;
  if (!sameBatch) return existing.state === 'REMOVED' ? UploadDecision.MOVE : UploadDecision.DUPLICATE;
  const reEvaluable =
    existing.state === 'INVALID' || existing.state === 'REMOVED' || (existing.state === 'FAILED' && !existing.fileAvailable);
  return reEvaluable ? UploadDecision.RE_EVALUATE : UploadDecision.DUPLICATE;
}
