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
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Permanent trace of everything that happened to a receipt. */
export interface ReceiptHistoryEntry {
  readonly sha256: Sha256;
  readonly at: Date;
  readonly event: string;
  readonly detail?: string;
}
