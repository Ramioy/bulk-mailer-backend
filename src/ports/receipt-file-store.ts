import type { Block } from '../domain/block/block';
import type { Period } from '../domain/period/period';
import type { Sha256 } from '../domain/receipt/sha256';

export interface StoredFileKey {
  readonly period: Period;
  readonly block: Block;
  readonly sha256: Sha256;
}

/** PDFs are kept only until their batch is processed. */
export interface ReceiptFileStore {
  save(key: StoredFileKey, content: Uint8Array): Promise<void>;
  /** `undefined` when the file is not stored (never uploaded, or purged). */
  read(key: StoredFileKey): Promise<Uint8Array | undefined>;
  delete(key: StoredFileKey): Promise<void>;
  /** Deletes every file of the batch; returns how many were deleted. */
  purgeBatch(period: Period, block: Block): Promise<number>;
}
