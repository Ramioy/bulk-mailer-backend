import type { Alert } from '../domain/alert/alert';
import type { AuditEntry } from '../domain/audit/audit';
import type { Batch, Execution } from '../domain/batch/batch';
import type { Manifest } from '../domain/batch/manifest';
import type { Block } from '../domain/block/block';
import type { Concept } from '../domain/concept/concept';
import type { Period } from '../domain/period/period';
import type { DeliveryEvent } from '../domain/receipt/delivery-state';
import type { Receipt, ReceiptHistoryEntry } from '../domain/receipt/receipt';
import type { ReceiptState } from '../domain/receipt/receipt-state';
import type { Sha256 } from '../domain/receipt/sha256';
import type { Attempt } from '../domain/sending/attempt';
import type { Suppression } from '../domain/suppression/suppression';

export class DuplicateAttemptError extends Error {
  constructor(readonly attemptId: string) {
    super(`Attempt ${attemptId} already exists`);
    this.name = 'DuplicateAttemptError';
  }
}

export interface ReceiptStore {
  get(sha256: Sha256): Promise<Receipt | undefined>;
  /** Insert or replace. */
  save(receipt: Receipt): Promise<void>;
  listByBatch(period: Period, block: Block): Promise<Receipt[]>;
  listByState(state: ReceiptState): Promise<Receipt[]>;
  appendHistory(entry: ReceiptHistoryEntry): Promise<void>;
  history(sha256: Sha256): Promise<ReceiptHistoryEntry[]>;
}

export interface BatchStore {
  get(period: Period, block: Block): Promise<Batch | undefined>;
  save(batch: Batch): Promise<void>;
  saveManifest(period: Period, block: Block, manifest: Manifest): Promise<void>;
  getManifest(period: Period, block: Block, version: number): Promise<Manifest | undefined>;
}

export interface ExecutionStore {
  /** Global lock: false (and nothing stored) when another execution is still running. */
  tryStart(execution: Execution): Promise<boolean>;
  save(execution: Execution): Promise<void>;
  get(executionId: string): Promise<Execution | undefined>;
  running(): Promise<Execution | undefined>;
}

export interface AttemptStore {
  /** Throws DuplicateAttemptError if the attemptId already exists. */
  insert(attempt: Attempt): Promise<void>;
  save(attempt: Attempt): Promise<void>;
  get(attemptId: string): Promise<Attempt | undefined>;
  listByReceipt(sha256: Sha256): Promise<Attempt[]>;
}

export interface SuppressionStore {
  get(email: string): Promise<Suppression | undefined>;
  save(suppression: Suppression): Promise<void>;
  remove(email: string): Promise<void>;
}

export interface DeliveryEventStore {
  /** False when an event with the same id was already recorded (duplicate). */
  record(event: DeliveryEvent): Promise<boolean>;
  listByAttempt(attemptId: string): Promise<DeliveryEvent[]>;
}

export interface AlertStore {
  insert(alert: Alert): Promise<void>;
  list(): Promise<Alert[]>;
}

export interface AuditLog {
  /** Append-only: there is no update or delete. */
  append(entry: AuditEntry): Promise<void>;
  list(): Promise<AuditEntry[]>;
}

export interface ConceptStore {
  list(): Promise<Concept[]>;
  save(concept: Concept): Promise<void>;
}

export interface SettingsStore {
  archiveCopyEnabled(): Promise<boolean>;
  setArchiveCopyEnabled(enabled: boolean): Promise<void>;
}

export interface BulkMailerStores {
  readonly receipts: ReceiptStore;
  readonly batches: BatchStore;
  readonly executions: ExecutionStore;
  readonly attempts: AttemptStore;
  readonly suppressions: SuppressionStore;
  readonly deliveryEvents: DeliveryEventStore;
  readonly alerts: AlertStore;
  readonly audit: AuditLog;
  readonly concepts: ConceptStore;
  readonly settings: SettingsStore;
}

/** Persistence of everything Bulk Mailer records. Records are permanent. */
export interface BulkMailerRepository extends BulkMailerStores {
  /** Runs `work` atomically: either every change is kept or none is. */
  transaction<T>(work: (stores: BulkMailerStores) => Promise<T>): Promise<T>;
}
