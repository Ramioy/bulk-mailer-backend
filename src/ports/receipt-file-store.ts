import type { Block } from '../domain/block/block';
import type { Period } from '../domain/period/period';
import type { Sha256 } from '../domain/receipt/sha256';

export interface StoredFileKey {
  readonly period: Period;
  readonly block: Block;
  readonly sha256: Sha256;
}

/** A stored file with its last modification, so a sweep can leave alone what is still being written (D41). */
export interface StoredFile extends StoredFileKey {
  readonly modifiedAt: Date;
}

/**
 * D48: an uploaded file written to the staging area while it was received, hashed on the way. Only its hash and size
 * travel through the upload; its bytes are read once, for the inspector, and the file is then moved into place
 * (committed) or discarded.
 */
export interface StagedFile {
  readonly stagingId: string;
  readonly sha256: Sha256;
  readonly size: number;
}

/** PDFs are kept only until their batch is processed. */
export interface ReceiptFileStore {
  save(key: StoredFileKey, content: Uint8Array): Promise<void>;
  /** `undefined` when the file is not stored (never uploaded, or purged). */
  read(key: StoredFileKey): Promise<Uint8Array | undefined>;
  delete(key: StoredFileKey): Promise<void>;
  /** Deletes every file of the batch; returns how many were deleted. */
  purgeBatch(period: Period, block: Block): Promise<number>;
  /** Every stored receipt file (D41); temporary files of a write in progress are not listed. */
  list(): Promise<StoredFile[]>;
  /** D48: writes the chunks to the staging area, hashing them; if the chunks fail, nothing is left behind. */
  stage(content: AsyncIterable<Uint8Array>): Promise<StagedFile>;
  readStaged(staged: StagedFile): Promise<Uint8Array>;
  /** Moves a staged file into place (an atomic rename on the volume), replacing what was there. */
  commitStaged(key: StoredFileKey, staged: StagedFile): Promise<void>;
  /** Idempotent: a staged file already committed or discarded is fine. */
  discardStaged(staged: Pick<StagedFile, 'stagingId'>): Promise<void>;
  /** Staged files, for the orphan sweep (D41): a crash between staging and commit leaves them behind. */
  listStaged(): Promise<Array<{ readonly stagingId: string; readonly modifiedAt: Date }>>;
}
