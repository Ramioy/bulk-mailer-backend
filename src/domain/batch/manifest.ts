import type { Sha256 } from '../receipt/sha256';
import type { ReceiptState } from '../receipt/receipt-state';

/** One receipt ready to send, exactly as the operator reviews it. */
export interface ManifestEntry {
  readonly sha256: Sha256;
  readonly fileName: string;
  readonly conceptKey: string;
  readonly contract: string;
  readonly email: string;
}

export interface Manifest {
  readonly version: number;
  readonly entries: readonly ManifestEntry[];
}

export interface ManifestCandidate {
  readonly sha256: Sha256;
  readonly state: ReceiptState;
  readonly fileName: string;
  readonly conceptKey: string;
  readonly contract: string;
  /** Resolved recipient, or `undefined` when the recipient has an error. */
  readonly email: string | undefined;
  /** False once the file was purged and not uploaded again. */
  readonly fileAvailable: boolean;
  /** D31: same content under other names, waiting for the operator's choice. */
  readonly inConflict?: boolean;
}

export function isReadyToSend(candidate: ManifestCandidate): boolean {
  return (
    (candidate.state === 'PENDING' || candidate.state === 'FAILED') && candidate.email !== undefined && candidate.fileAvailable && candidate.inConflict !== true
  );
}

/** Builds the next manifest version from the batch receipts, ordered by file name for a stable review. */
export function buildManifest(previousVersion: number, candidates: readonly ManifestCandidate[]): Manifest {
  const entries = candidates
    .filter(isReadyToSend)
    .map(({ sha256, fileName, conceptKey, contract, email }) => ({ sha256, fileName, conceptKey, contract, email: email as string }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName, 'es'));
  return { version: previousVersion + 1, entries };
}

export const ManifestDifferenceType = {
  ADDED: 'ADDED',
  REMOVED: 'REMOVED',
  /** Same hash; file name, concept or contract changed. */
  RENAMED: 'RENAMED',
  /** Same hash and contract; the resolved email changed (e.g. after Refresh recipients). */
  RECIPIENT_CHANGED: 'RECIPIENT_CHANGED',
} as const;
export type ManifestDifferenceType = (typeof ManifestDifferenceType)[keyof typeof ManifestDifferenceType];

export interface ManifestDifference {
  readonly type: ManifestDifferenceType;
  readonly sha256: Sha256;
  readonly fileName: string;
  /** Entry as the operator reviewed it (absent for ADDED). */
  readonly previous?: ManifestEntry;
  /** Entry as it would be sent now (absent for REMOVED). */
  readonly current?: ManifestEntry;
}

/**
 * Differences reported with the `409` when the reviewed version is not the current one.
 * Guarantees that the system sends exactly what the operator reviewed.
 */
export function diffManifests(reviewed: Manifest, current: Manifest): ManifestDifference[] {
  const reviewedByHash = new Map(reviewed.entries.map((e) => [e.sha256, e]));
  const currentByHash = new Map(current.entries.map((e) => [e.sha256, e]));
  const differences: ManifestDifference[] = [];

  for (const now of current.entries) {
    const before = reviewedByHash.get(now.sha256);
    if (!before) {
      differences.push({ type: 'ADDED', sha256: now.sha256, fileName: now.fileName, current: now });
    } else if (before.fileName !== now.fileName || before.conceptKey !== now.conceptKey || before.contract !== now.contract) {
      differences.push({ type: 'RENAMED', sha256: now.sha256, fileName: now.fileName, previous: before, current: now });
    } else if (before.email !== now.email) {
      differences.push({ type: 'RECIPIENT_CHANGED', sha256: now.sha256, fileName: now.fileName, previous: before, current: now });
    }
  }
  for (const before of reviewed.entries) {
    if (!currentByHash.has(before.sha256)) {
      differences.push({ type: 'REMOVED', sha256: before.sha256, fileName: before.fileName, previous: before });
    }
  }
  return differences;
}
