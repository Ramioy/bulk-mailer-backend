import type { Block } from '../block/block';
import type { Period } from '../period/period';
import type { Recipient } from '../recipient/recipient';
import type { ReceiptErrorType } from '../shared/error-types';
import type { DeliveryState } from './delivery-state';
import type { ReceiptState } from './receipt-state';
import type { Sha256 } from './sha256';

/** One receipt. Its identity is the SHA-256 of its content: there is never a second record for the same hash. */
export interface Receipt {
  readonly sha256: Sha256;
  readonly period: Period;
  readonly block: Block;
  readonly state: ReceiptState;
  readonly fileName: string;
  /** Absent when the name could not be parsed. */
  readonly conceptKey?: string;
  readonly contract?: string;
  readonly sizeBytes: number;
  readonly errorType?: ReceiptErrorType;
  readonly errorDetail?: string;
  /** Resolved recipient, absent while it has an error. */
  readonly recipient?: Recipient;
  /** False once the file was purged and not uploaded again. */
  readonly fileAvailable: boolean;
  readonly attempts: number;
  /** Only for receipts that reached SENT. */
  readonly deliveryState?: DeliveryState;
  /**
   * D31: other valid names under which this same content was uploaded. While there is any, the receipt is blocked
   * (`DUPLICATE_CONFLICT`) and is not sent until the operator chooses one name or removes it.
   */
  readonly conflictingNames?: readonly ConflictingName[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /**
   * Row version for optimistic concurrency (D37): 1 when first stored, +1 on every save. A save based on another
   * version than the stored one fails instead of overwriting what someone else wrote.
   */
  readonly version: number;
}

/** A valid name the same content arrived under, with the batch it was uploaded to (D31). */
export interface ConflictingName {
  readonly fileName: string;
  readonly period: Period;
  readonly block: Block;
  readonly conceptKey: string;
  readonly contract: string;
  readonly uploadedAt: Date;
}

export const inConflict = (receipt: Pick<Receipt, 'conflictingNames'>): boolean => (receipt.conflictingNames?.length ?? 0) > 0;

/** Permanent trace of everything that happened to a receipt. */
export interface ReceiptHistoryEntry {
  readonly sha256: Sha256;
  readonly at: Date;
  readonly event: string;
  readonly detail?: string;
}
