import type { Alert } from '../domain/alert/alert';
import type { AuditEntry } from '../domain/audit/audit';
import type { Batch, Execution } from '../domain/batch/batch';
import type { Manifest } from '../domain/batch/manifest';
import type { DomainEvent } from './event-bus';
import type { ProgressEvent, StoredProgressEvent } from './progress-notifier';
import type { Block } from '../domain/block/block';
import type { Concept } from '../domain/concept/concept';
import type { Period } from '../domain/period/period';
import type { DeliveryEvent } from '../domain/receipt/delivery-state';
import type { DeliveryWebhook } from '../domain/receipt/delivery-webhook';
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
  /** Most recently started execution, running or not. */
  latest(): Promise<Execution | undefined>;
  /** Executions that finished within `[from, to]`. */
  listFinishedBetween(from: Date, to: Date): Promise<Execution[]>;
}

/** Progress events of each execution, kept so a new session can catch up (D10, D11). */
export interface ExecutionEventStore {
  append(executionId: string, at: Date, event: ProgressEvent): Promise<StoredProgressEvent>;
  /** Events with `seq` greater than `afterSeq`, in order. */
  listAfter(executionId: string, afterSeq: number): Promise<StoredProgressEvent[]>;
  last(executionId: string): Promise<StoredProgressEvent | undefined>;
}

export interface AttemptStore {
  /** Throws DuplicateAttemptError if the attemptId already exists. */
  insert(attempt: Attempt): Promise<void>;
  save(attempt: Attempt): Promise<void>;
  get(attemptId: string): Promise<Attempt | undefined>;
  /** Oldest first. */
  listByReceipt(sha256: Sha256): Promise<Attempt[]>;
  listByExecution(executionId: string): Promise<Attempt[]>;
}

export interface SuppressionStore {
  get(email: string): Promise<Suppression | undefined>;
  save(suppression: Suppression): Promise<void>;
  remove(email: string): Promise<void>;
  list(): Promise<Suppression[]>;
}

export interface DeliveryEventStore {
  /** False when an event with the same id was already recorded (duplicate). */
  record(event: DeliveryEvent): Promise<boolean>;
  listByAttempt(attemptId: string): Promise<DeliveryEvent[]>;
}

/** Raw provider webhooks, kept permanently. */
export interface WebhookInbox {
  /** False when a webhook with the same id was already received (duplicate). */
  record(webhook: DeliveryWebhook): Promise<boolean>;
  get(webhookRequestId: string): Promise<DeliveryWebhook | undefined>;
  markProcessed(webhookRequestId: string, at: Date): Promise<void>;
  /** Most recently received first. */
  listRecent(limit: number): Promise<DeliveryWebhook[]>;
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

export interface PendingEvent {
  readonly event: DomainEvent;
  /** Failed deliveries so far. */
  readonly attempts: number;
}

/** Outbox: domain events written in the same transaction as the changes they describe. */
export interface OutboxStore {
  add(event: DomainEvent): Promise<void>;
  /** Oldest undelivered events, locked for this transaction (other relays skip them). */
  lockPending(limit: number): Promise<PendingEvent[]>;
  markDispatched(eventId: string, at: Date): Promise<void>;
  markFailed(eventId: string, error: string): Promise<void>;
}

export interface SettingsStore {
  archiveCopyEnabled(): Promise<boolean>;
  setArchiveCopyEnabled(enabled: boolean): Promise<void>;
}

export interface BulkMailerStores {
  readonly receipts: ReceiptStore;
  readonly batches: BatchStore;
  readonly executions: ExecutionStore;
  readonly executionEvents: ExecutionEventStore;
  readonly attempts: AttemptStore;
  readonly suppressions: SuppressionStore;
  readonly deliveryEvents: DeliveryEventStore;
  readonly webhooks: WebhookInbox;
  readonly alerts: AlertStore;
  readonly audit: AuditLog;
  readonly concepts: ConceptStore;
  readonly settings: SettingsStore;
  readonly outbox: OutboxStore;
}

/** Persistence of everything Bulk Mailer records. Records are permanent. */
export interface BulkMailerRepository extends BulkMailerStores {
  /** Runs `work` atomically: either every change is kept or none is. */
  transaction<T>(work: (stores: BulkMailerStores) => Promise<T>): Promise<T>;
}
