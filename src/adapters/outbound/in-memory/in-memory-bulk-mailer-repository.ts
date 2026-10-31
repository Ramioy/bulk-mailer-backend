import type { Alert } from '../../../domain/alert/alert';
import type { AuditEntry } from '../../../domain/audit/audit';
import type { Batch, Execution } from '../../../domain/batch/batch';
import type { Manifest } from '../../../domain/batch/manifest';
import type { Block } from '../../../domain/block/block';
import { INITIAL_CONCEPTS, type Concept } from '../../../domain/concept/concept';
import type { Period } from '../../../domain/period/period';
import type { DeliveryEvent } from '../../../domain/receipt/delivery-state';
import type { DeliveryWebhook } from '../../../domain/receipt/delivery-webhook';
import type { Receipt, ReceiptHistoryEntry } from '../../../domain/receipt/receipt';
import type { ReceiptState } from '../../../domain/receipt/receipt-state';
import type { Sha256 } from '../../../domain/receipt/sha256';
import type { Attempt } from '../../../domain/sending/attempt';
import type { Suppression } from '../../../domain/suppression/suppression';
import { DuplicateAttemptError, type BulkMailerRepository, type BulkMailerStores } from '../../../ports/bulk-mailer-repository';
import type { StoredProgressEvent } from '../../../ports/progress-notifier';
import type { DomainEvent } from '../../../ports/event-bus';

const batchKey = (period: Period, block: Block) => `${period.toString()}|${block}`;

interface State {
  receipts: Map<Sha256, Receipt>;
  history: ReceiptHistoryEntry[];
  batches: Map<string, Batch>;
  manifests: Map<string, Manifest>;
  executions: Map<string, Execution>;
  executionEvents: StoredProgressEvent[];
  attempts: Map<string, Attempt>;
  suppressions: Map<string, Suppression>;
  deliveryEvents: Map<string, DeliveryEvent>;
  webhooks: Map<string, DeliveryWebhook>;
  alerts: Alert[];
  audit: AuditEntry[];
  concepts: Map<string, Concept>;
  archiveCopyEnabled: boolean;
  outbox: Array<{ event: DomainEvent; attempts: number; dispatchedAt?: Date; lastError?: string }>;
}

function snapshot(state: State): State {
  return {
    ...state,
    receipts: new Map(state.receipts),
    history: [...state.history],
    batches: new Map(state.batches),
    manifests: new Map(state.manifests),
    executions: new Map(state.executions),
    executionEvents: [...state.executionEvents],
    attempts: new Map(state.attempts),
    suppressions: new Map(state.suppressions),
    deliveryEvents: new Map(state.deliveryEvents),
    webhooks: new Map(state.webhooks),
    alerts: [...state.alerts],
    audit: [...state.audit],
    concepts: new Map(state.concepts),
    outbox: state.outbox.map((e) => ({ ...e })),
  };
}

/** Reference implementation of the repository, for tests and local runs without a database. */
export class InMemoryBulkMailerRepository implements BulkMailerRepository {
  private state: State = {
    receipts: new Map(),
    history: [],
    batches: new Map(),
    manifests: new Map(),
    executions: new Map(),
    executionEvents: [],
    attempts: new Map(),
    suppressions: new Map(),
    deliveryEvents: new Map(),
    webhooks: new Map(),
    alerts: [],
    audit: [],
    concepts: new Map(INITIAL_CONCEPTS.map((c) => [c.key, c])),
    archiveCopyEnabled: false,
    outbox: [],
  };

  readonly receipts: BulkMailerStores['receipts'] = {
    get: async (sha256) => this.state.receipts.get(sha256),
    save: async (receipt) => {
      this.state.receipts.set(receipt.sha256, receipt);
    },
    listByBatch: async (period, block) =>
      [...this.state.receipts.values()]
        .filter((r) => r.period.equals(period) && r.block === block)
        .sort((a, b) => a.fileName.localeCompare(b.fileName, 'es')),
    listByState: async (state: ReceiptState) => [...this.state.receipts.values()].filter((r) => r.state === state),
    appendHistory: async (entry) => {
      this.state.history.push(entry);
    },
    history: async (sha256) => this.state.history.filter((h) => h.sha256 === sha256),
  };

  readonly batches: BulkMailerStores['batches'] = {
    get: async (period, block) => this.state.batches.get(batchKey(period, block)),
    save: async (batch) => {
      this.state.batches.set(batchKey(batch.period, batch.block), batch);
    },
    saveManifest: async (period, block, manifest) => {
      this.state.manifests.set(`${batchKey(period, block)}|${manifest.version}`, manifest);
    },
    getManifest: async (period, block, version) => this.state.manifests.get(`${batchKey(period, block)}|${version}`),
  };

  readonly executions: BulkMailerStores['executions'] = {
    tryStart: async (execution) => {
      if ([...this.state.executions.values()].some((e) => e.finishedAt === undefined)) return false;
      this.state.executions.set(execution.executionId, execution);
      return true;
    },
    save: async (execution) => {
      this.state.executions.set(execution.executionId, execution);
    },
    get: async (executionId) => this.state.executions.get(executionId),
    running: async () => [...this.state.executions.values()].find((e) => e.finishedAt === undefined),
    latest: async () => [...this.state.executions.values()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0],
    listFinishedBetween: async (from, to) =>
      [...this.state.executions.values()]
        .filter((e) => e.finishedAt !== undefined && e.finishedAt >= from && e.finishedAt <= to)
        .sort((a, b) => (a.finishedAt as Date).getTime() - (b.finishedAt as Date).getTime()),
  };

  readonly executionEvents: BulkMailerStores['executionEvents'] = {
    append: async (executionId, at, event) => {
      const stored = { seq: this.state.executionEvents.length + 1, executionId, at, event };
      this.state.executionEvents.push(stored);
      return stored;
    },
    listAfter: async (executionId, afterSeq) => this.state.executionEvents.filter((e) => e.executionId === executionId && e.seq > afterSeq),
    last: async (executionId) => this.state.executionEvents.filter((e) => e.executionId === executionId).at(-1),
  };

  readonly attempts: BulkMailerStores['attempts'] = {
    insert: async (attempt) => {
      if (this.state.attempts.has(attempt.attemptId)) throw new DuplicateAttemptError(attempt.attemptId);
      this.state.attempts.set(attempt.attemptId, attempt);
    },
    save: async (attempt) => {
      this.state.attempts.set(attempt.attemptId, attempt);
    },
    get: async (attemptId) => this.state.attempts.get(attemptId),
    listByReceipt: async (sha256) =>
      [...this.state.attempts.values()].filter((a) => a.sha256 === sha256).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()),
    listByExecution: async (executionId) =>
      [...this.state.attempts.values()].filter((a) => a.executionId === executionId).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()),
  };

  readonly suppressions: BulkMailerStores['suppressions'] = {
    get: async (email) => this.state.suppressions.get(email),
    save: async (suppression) => {
      this.state.suppressions.set(suppression.email, suppression);
    },
    remove: async (email) => {
      this.state.suppressions.delete(email);
    },
    list: async () => [...this.state.suppressions.values()].sort((a, b) => a.email.localeCompare(b.email)),
  };

  readonly webhooks: BulkMailerStores['webhooks'] = {
    record: async (webhook) => {
      if (this.state.webhooks.has(webhook.webhookRequestId)) return false;
      this.state.webhooks.set(webhook.webhookRequestId, webhook);
      return true;
    },
    get: async (webhookRequestId) => this.state.webhooks.get(webhookRequestId),
    markProcessed: async (webhookRequestId, at) => {
      const webhook = this.state.webhooks.get(webhookRequestId);
      if (webhook) this.state.webhooks.set(webhookRequestId, { ...webhook, processedAt: at });
    },
    listRecent: async (limit) =>
      [...this.state.webhooks.values()]
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || b.webhookRequestId.localeCompare(a.webhookRequestId))
        .slice(0, limit),
  };

  readonly deliveryEvents: BulkMailerStores['deliveryEvents'] = {
    record: async (event) => {
      if (this.state.deliveryEvents.has(event.eventId)) return false;
      this.state.deliveryEvents.set(event.eventId, event);
      return true;
    },
    listByAttempt: async (attemptId) => [...this.state.deliveryEvents.values()].filter((e) => e.attemptId === attemptId),
  };

  readonly alerts: BulkMailerStores['alerts'] = {
    insert: async (alert) => {
      this.state.alerts.push(alert);
    },
    list: async () => [...this.state.alerts],
  };

  readonly audit: BulkMailerStores['audit'] = {
    append: async (entry) => {
      this.state.audit.push(entry);
    },
    list: async () => [...this.state.audit],
  };

  readonly concepts: BulkMailerStores['concepts'] = {
    list: async () => [...this.state.concepts.values()],
    save: async (concept) => {
      this.state.concepts.set(concept.key, concept);
    },
  };

  readonly settings: BulkMailerStores['settings'] = {
    archiveCopyEnabled: async () => this.state.archiveCopyEnabled,
    setArchiveCopyEnabled: async (enabled) => {
      this.state.archiveCopyEnabled = enabled;
    },
  };

  readonly outbox: BulkMailerStores['outbox'] = {
    add: async (event) => {
      this.state.outbox.push({ event, attempts: 0 });
    },
    lockPending: async (limit) =>
      this.state.outbox
        .filter((e) => !e.dispatchedAt)
        .slice(0, limit)
        .map((e) => ({ event: e.event, attempts: e.attempts })),
    markDispatched: async (eventId, at) => {
      const entry = this.state.outbox.find((e) => e.event.eventId === eventId);
      if (entry) entry.dispatchedAt = at;
    },
    markFailed: async (eventId, error) => {
      const entry = this.state.outbox.find((e) => e.event.eventId === eventId);
      if (entry) {
        entry.attempts += 1;
        entry.lastError = error;
      }
    },
  };

  /** Not safe for concurrent transactions; enough for a single-process reference implementation. */
  async transaction<T>(work: (stores: BulkMailerStores) => Promise<T>): Promise<T> {
    const before = snapshot(this.state);
    try {
      return await work(this);
    } catch (error) {
      this.state = before;
      throw error;
    }
  }
}
