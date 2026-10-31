import type { DataSource } from 'typeorm';

import type { Alert, AlertType } from '../../../domain/alert/alert';
import type { AuditAction, AuditEntry } from '../../../domain/audit/audit';
import type { Batch, Execution } from '../../../domain/batch/batch';
import type { BatchState } from '../../../domain/batch/batch-state';
import type { Manifest, ManifestEntry } from '../../../domain/batch/manifest';
import type { Block } from '../../../domain/block/block';
import type { Concept } from '../../../domain/concept/concept';
import { Period } from '../../../domain/period/period';
import type { DeliveryEvent, DeliveryState, IncomingDeliveryEvent } from '../../../domain/receipt/delivery-state';
import type { DeliveryWebhook, WebhookParseNotes } from '../../../domain/receipt/delivery-webhook';
import type { ConflictingName, Receipt, ReceiptHistoryEntry } from '../../../domain/receipt/receipt';
import type { ReceiptState } from '../../../domain/receipt/receipt-state';
import type { Sha256 } from '../../../domain/receipt/sha256';
import type { Attempt } from '../../../domain/sending/attempt';
import type { SendOutcomeKind } from '../../../domain/sending/send-outcome';
import type { BatchStopReason, ReceiptErrorType } from '../../../domain/shared/error-types';
import type { Suppression } from '../../../domain/suppression/suppression';
import {
  ConcurrentModificationError,
  DuplicateAttemptError,
  DuplicateManifestVersionError,
  type AlertStore,
  type AttemptStore,
  type AuditLog,
  type BatchStore,
  type BulkMailerRepository,
  type BulkMailerStores,
  type ConceptStore,
  type DeliveryEventStore,
  type ExecutionEventStore,
  type OutboxStore,
  type ExecutionStore,
  type JobStore,
  type ReceiptStore,
  type SettingsStore,
  type SuppressionStore,
  type WebhookInbox,
} from '../../../ports/bulk-mailer-repository';
import type { DomainEvent } from '../../../ports/event-bus';
import type { ProgressEvent, StoredProgressEvent } from '../../../ports/progress-notifier';
import { insertJob } from './postgres-job-queue';
import { autocommit, firstRow, inTransaction, isUniqueViolation, opt, rows, type Queryable, type Row } from './queryable';

const period = (row: Row): Period => {
  const parsed = Period.parse(String(row.period));
  if (!parsed) throw new Error(`Invalid period in database: ${String(row.period)}`);
  return parsed;
};
const byFileName = (a: Receipt, b: Receipt) => a.fileName.localeCompare(b.fileName, 'es');

function toReceipt(r: Row): Receipt {
  const email = opt<string>(r.recipient_email);
  return {
    sha256: r.sha256 as Sha256,
    period: period(r),
    block: r.block as Block,
    state: r.state as ReceiptState,
    fileName: r.file_name as string,
    conceptKey: opt(r.concept_key),
    contract: opt(r.contract),
    sizeBytes: r.size_bytes as number,
    errorType: opt<ReceiptErrorType>(r.error_type),
    errorDetail: opt(r.error_detail),
    recipient: email === undefined ? undefined : { email, complexName: r.recipient_complex_name as string },
    fileAvailable: r.file_available as boolean,
    attempts: r.attempts as number,
    deliveryState: opt<DeliveryState>(r.delivery_state),
    conflictingNames: conflictingNames(r.conflicting_names),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    version: r.version as number,
  };
}

function toAlert(r: Row): Alert {
  return {
    alertId: r.alert_id as string,
    type: r.type as AlertType,
    subject: r.subject as string,
    detail: r.detail as string,
    raisedAt: r.raised_at as Date,
    ...(r.reference ? { reference: r.reference as string } : {}),
    ...(r.acknowledged_at ? { acknowledgedAt: r.acknowledged_at as Date, acknowledgedBy: r.acknowledged_by as string } : {}),
    ...(r.resolved_at ? { resolvedAt: r.resolved_at as Date, resolution: r.resolution as string } : {}),
  };
}

interface StoredConflictingName {
  readonly fileName: string;
  readonly period: string;
  readonly block: Block;
  readonly conceptKey: string;
  readonly contract: string;
  readonly uploadedAt: string;
}

function conflictingNames(value: unknown): ConflictingName[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return (value as StoredConflictingName[]).map((n) => ({ ...n, period: period({ period: n.period }), uploadedAt: new Date(n.uploadedAt) }));
}

const storedConflictingNames = (names: readonly ConflictingName[] | undefined): string | null =>
  names && names.length > 0
    ? JSON.stringify(names.map((n): StoredConflictingName => ({ ...n, period: n.period.toString(), uploadedAt: n.uploadedAt.toISOString() })))
    : null;

function toExecution(r: Row): Execution {
  return {
    executionId: r.execution_id as string,
    period: period(r),
    block: r.block as Block,
    manifestVersion: r.manifest_version as number,
    startedBy: r.started_by as string,
    startedAt: r.started_at as Date,
    copyAddress: opt(r.copy_address),
    finishedAt: opt(r.finished_at),
    result: opt(r.result),
    stopReason: opt<BatchStopReason>(r.stop_reason),
  };
}

function toAttempt(r: Row): Attempt {
  return {
    attemptId: r.attempt_id as string,
    sha256: r.sha256 as Sha256,
    executionId: opt(r.execution_id),
    kind: r.kind as Attempt['kind'],
    to: r.to_address as string,
    copyAddress: opt(r.copy_address),
    startedAt: r.started_at as Date,
    finishedAt: opt(r.finished_at),
    outcome: opt<SendOutcomeKind>(r.outcome),
    detail: opt(r.detail),
    providerRequestId: opt(r.provider_request_id),
    emailReference: opt(r.email_reference),
    redirectedTo: opt(r.redirected_to),
  };
}

function toDeliveryEvent(r: Row): DeliveryEvent {
  return {
    eventId: r.event_id as string,
    attemptId: r.attempt_id as string,
    recipient: r.recipient as string,
    isPrimaryRecipient: r.is_primary as boolean,
    state: r.state as DeliveryEvent['state'],
    reason: opt(r.reason),
    occurredAt: r.occurred_at as Date,
    source: r.source as DeliveryEvent['source'],
    providerRequestId: opt(r.provider_request_id),
    emailReference: opt(r.email_reference),
  };
}

type StoredIncomingEvent = Omit<IncomingDeliveryEvent, 'occurredAt'> & { occurredAt: string };

function toWebhook(r: Row): DeliveryWebhook {
  return {
    webhookRequestId: r.webhook_request_id as string,
    provider: r.provider as string,
    receivedAt: r.received_at as Date,
    body: r.body as string,
    events: (r.events as StoredIncomingEvent[]).map((e) => ({ ...e, occurredAt: new Date(e.occurredAt) })),
    ...(r.parse_notes ? { parseNotes: r.parse_notes as WebhookParseNotes } : {}),
    processedAt: opt(r.processed_at),
  };
}

const toSuppression = (r: Row): Suppression => ({
  email: r.email as string,
  reason: r.reason as Suppression['reason'],
  since: r.since as Date,
  attemptId: opt(r.attempt_id),
});

const attemptParams = (a: Attempt) => [
  a.attemptId, a.sha256, a.executionId ?? null, a.kind, a.to, a.copyAddress ?? null, a.startedAt,
  a.finishedAt ?? null, a.outcome ?? null, a.detail ?? null, a.providerRequestId ?? null, a.emailReference ?? null,
  a.redirectedTo ?? null,
];
const ATTEMPT_COLUMNS = `attempt_id, sha256, execution_id, kind, to_address, copy_address, started_at,
  finished_at, outcome, detail, provider_request_id, email_reference, redirected_to`;

const executionParams = (e: Execution) => [
  e.executionId, e.period.toString(), e.block, e.manifestVersion, e.startedBy, e.startedAt,
  e.copyAddress ?? null, e.finishedAt ?? null, e.result ?? null, e.stopReason ?? null,
];
const EXECUTION_COLUMNS = `execution_id, period, block, manifest_version, started_by, started_at,
  copy_address, finished_at, result, stop_reason`;

function stores(db: Queryable): BulkMailerStores {
  const receipts: ReceiptStore = {
    async get(sha256) {
      const row = await firstRow(db, 'SELECT * FROM receipts WHERE sha256 = $1', [sha256]);
      return row && toReceipt(row);
    },
    async save(r) {
      const params = [
        r.sha256, r.period.toString(), r.block, r.state, r.fileName, r.conceptKey ?? null, r.contract ?? null, r.sizeBytes,
        r.errorType ?? null, r.errorDetail ?? null, r.recipient?.email ?? null, r.recipient?.complexName ?? null,
        r.fileAvailable, r.attempts, r.deliveryState ?? null, r.createdAt, r.updatedAt, storedConflictingNames(r.conflictingNames), r.version,
      ];
      // D37: an update only if nobody saved it since this version was read; a new receipt is inserted as given.
      const updated = await rows(
        db,
        `UPDATE receipts SET period = $2, block = $3, state = $4, file_name = $5, concept_key = $6, contract = $7,
           size_bytes = $8, error_type = $9, error_detail = $10, recipient_email = $11, recipient_complex_name = $12,
           file_available = $13, attempts = $14, delivery_state = $15, created_at = $16, updated_at = $17,
           conflicting_names = $18, version = version + 1
         WHERE sha256 = $1 AND version = $19 RETURNING version`,
        params,
      );
      if (updated[0]) return { ...r, version: updated[0].version as number };
      const inserted = await rows(
        db,
        `INSERT INTO receipts (sha256, period, block, state, file_name, concept_key, contract, size_bytes, error_type,
           error_detail, recipient_email, recipient_complex_name, file_available, attempts, delivery_state, created_at, updated_at,
           conflicting_names, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (sha256) DO NOTHING RETURNING version`,
        params,
      );
      if (inserted[0]) return r;
      throw new ConcurrentModificationError('receipt', r.sha256, r.version);
    },
    async listByBatch(p, block) {
      const found = await rows(db, 'SELECT * FROM receipts WHERE period = $1 AND block = $2', [p.toString(), block]);
      return found.map(toReceipt).sort(byFileName);
    },
    async listByState(state) {
      return (await rows(db, 'SELECT * FROM receipts WHERE state = $1', [state])).map(toReceipt);
    },
    async listPendingDeliveriesSince(since) {
      const found = await rows(
        db,
        `SELECT * FROM receipts WHERE updated_at >= $1
           AND (state = 'UNCERTAIN' OR (state = 'SENT' AND delivery_state IN ('UNCONFIRMED', 'SOFT_BOUNCE')))`,
        [since],
      );
      return found.map(toReceipt);
    },
    async appendHistory(entry) {
      await db.query('INSERT INTO receipt_history (sha256, at, event, detail) VALUES ($1, $2, $3, $4)', [
        entry.sha256, entry.at, entry.event, entry.detail ?? null,
      ]);
    },
    async history(sha256) {
      const found = await rows(db, 'SELECT * FROM receipt_history WHERE sha256 = $1 ORDER BY seq', [sha256]);
      return found.map((r): ReceiptHistoryEntry => ({
        sha256: r.sha256 as Sha256,
        at: r.at as Date,
        event: r.event as string,
        detail: opt(r.detail),
      }));
    },
  };

  const batches: BatchStore = {
    async get(p, block) {
      const r = await firstRow(db, 'SELECT * FROM batches WHERE period = $1 AND block = $2', [p.toString(), block]);
      if (!r) return undefined;
      return {
        period: period(r),
        block: r.block as Block,
        state: r.state as BatchState,
        manifestVersion: r.manifest_version as number,
        stopReason: opt<BatchStopReason>(r.stop_reason),
        updatedAt: r.updated_at as Date,
        version: r.version as number,
      } satisfies Batch;
    },
    async save(b) {
      const params = [b.period.toString(), b.block, b.state, b.manifestVersion, b.stopReason ?? null, b.updatedAt, b.version];
      // D37: same optimistic rule as receipts.
      const updated = await rows(
        db,
        `UPDATE batches SET state = $3, manifest_version = $4, stop_reason = $5, updated_at = $6, version = version + 1
         WHERE period = $1 AND block = $2 AND version = $7 RETURNING version`,
        params,
      );
      if (updated[0]) return { ...b, version: updated[0].version as number };
      const inserted = await rows(
        db,
        `INSERT INTO batches (period, block, state, manifest_version, stop_reason, updated_at, version) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (period, block) DO NOTHING RETURNING version`,
        params,
      );
      if (inserted[0]) return b;
      throw new ConcurrentModificationError('batch', `${b.period.toString()}|${b.block}`, b.version);
    },
    async saveManifest(p, block, manifest) {
      // D37: insert only. "Never two manifests with the same version" is guarded by the database, not only by the
      // serial executor; a repeated version is a bug and surfaces as an error.
      const inserted = await rows(
        db,
        `INSERT INTO manifests (period, block, version, entries) VALUES ($1, $2, $3, $4)
         ON CONFLICT (period, block, version) DO NOTHING RETURNING version`,
        [p.toString(), block, manifest.version, JSON.stringify(manifest.entries)],
      );
      if (!inserted[0]) throw new DuplicateManifestVersionError(`${p.toString()}|${block}`, manifest.version);
    },
    async getManifest(p, block, version) {
      const r = await firstRow(db, 'SELECT * FROM manifests WHERE period = $1 AND block = $2 AND version = $3', [
        p.toString(), block, version,
      ]);
      return r && ({ version: r.version as number, entries: r.entries as ManifestEntry[] } satisfies Manifest);
    },
  };

  const executions: ExecutionStore = {
    async tryStart(e) {
      // The partial unique index allows a single unfinished execution; a conflict means another one runs.
      const inserted = await rows(
        db,
        `INSERT INTO executions (${EXECUTION_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING RETURNING execution_id`,
        executionParams(e),
      );
      return inserted.length === 1;
    },
    async save(e) {
      await db.query(
        `INSERT INTO executions (${EXECUTION_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (execution_id) DO UPDATE SET manifest_version = EXCLUDED.manifest_version, copy_address = EXCLUDED.copy_address,
           finished_at = EXCLUDED.finished_at, result = EXCLUDED.result, stop_reason = EXCLUDED.stop_reason`,
        executionParams(e),
      );
    },
    async get(executionId) {
      const r = await firstRow(db, 'SELECT * FROM executions WHERE execution_id = $1', [executionId]);
      return r && toExecution(r);
    },
    async running() {
      const r = await firstRow(db, 'SELECT * FROM executions WHERE finished_at IS NULL');
      return r && toExecution(r);
    },
    async latest() {
      const r = await firstRow(db, 'SELECT * FROM executions ORDER BY started_at DESC, execution_id DESC LIMIT 1');
      return r && toExecution(r);
    },
    async listFinishedBetween(from, to) {
      const found = await rows(db, 'SELECT * FROM executions WHERE finished_at BETWEEN $1 AND $2 ORDER BY finished_at, execution_id', [from, to]);
      return found.map(toExecution);
    },
  };

  const toStoredEvent = (r: Row): StoredProgressEvent => ({
    seq: Number(r.seq),
    executionId: r.execution_id as string,
    at: r.at as Date,
    event: r.payload as ProgressEvent,
  });

  const executionEvents: ExecutionEventStore = {
    async append(executionId, at, event) {
      const inserted = await rows(
        db,
        'INSERT INTO execution_events (execution_id, at, type, payload) VALUES ($1, $2, $3, $4) RETURNING *',
        [executionId, at, event.type, JSON.stringify(event)],
      );
      return toStoredEvent(inserted[0] as Row);
    },
    async listAfter(executionId, afterSeq) {
      const found = await rows(db, 'SELECT * FROM execution_events WHERE execution_id = $1 AND seq > $2 ORDER BY seq', [executionId, afterSeq]);
      return found.map(toStoredEvent);
    },
    async last(executionId) {
      const r = await firstRow(db, 'SELECT * FROM execution_events WHERE execution_id = $1 ORDER BY seq DESC LIMIT 1', [executionId]);
      return r && toStoredEvent(r);
    },
  };

  const attempts: AttemptStore = {
    async insert(a) {
      try {
        await db.query(`INSERT INTO attempts (${ATTEMPT_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, attemptParams(a));
      } catch (error) {
        if (isUniqueViolation(error)) throw new DuplicateAttemptError(a.attemptId);
        throw error;
      }
    },
    async save(a) {
      await db.query(
        `INSERT INTO attempts (${ATTEMPT_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (attempt_id) DO UPDATE SET finished_at = EXCLUDED.finished_at, outcome = EXCLUDED.outcome,
           detail = EXCLUDED.detail, provider_request_id = EXCLUDED.provider_request_id, email_reference = EXCLUDED.email_reference`,
        attemptParams(a),
      );
    },
    async get(attemptId) {
      const r = await firstRow(db, 'SELECT * FROM attempts WHERE attempt_id = $1', [attemptId]);
      return r && toAttempt(r);
    },
    async listByReceipt(sha256) {
      return (await rows(db, 'SELECT * FROM attempts WHERE sha256 = $1 ORDER BY started_at, seq', [sha256])).map(toAttempt);
    },
    async listByExecution(executionId) {
      return (await rows(db, 'SELECT * FROM attempts WHERE execution_id = $1 ORDER BY started_at, seq', [executionId])).map(toAttempt);
    },
  };

  const suppressions: SuppressionStore = {
    async get(email) {
      const r = await firstRow(db, 'SELECT * FROM suppressions WHERE email = $1', [email]);
      return r && toSuppression(r);
    },
    async list() {
      return (await rows(db, 'SELECT * FROM suppressions ORDER BY email')).map(toSuppression);
    },
    async save(s) {
      await db.query(
        `INSERT INTO suppressions (email, reason, since, attempt_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason, since = EXCLUDED.since, attempt_id = EXCLUDED.attempt_id`,
        [s.email, s.reason, s.since, s.attemptId ?? null],
      );
    },
    async remove(email) {
      await db.query('DELETE FROM suppressions WHERE email = $1', [email]);
    },
  };

  const deliveryEvents: DeliveryEventStore = {
    async record(e) {
      const inserted = await rows(
        db,
        `INSERT INTO delivery_events (event_id, attempt_id, recipient, is_primary, state, reason, occurred_at, source,
           provider_request_id, email_reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [
          e.eventId, e.attemptId, e.recipient, e.isPrimaryRecipient, e.state, e.reason ?? null, e.occurredAt, e.source,
          e.providerRequestId ?? null, e.emailReference ?? null,
        ],
      );
      return inserted.length === 1;
    },
    async listByAttempt(attemptId) {
      return (await rows(db, 'SELECT * FROM delivery_events WHERE attempt_id = $1 ORDER BY seq', [attemptId])).map(toDeliveryEvent);
    },
  };

  const webhooks: WebhookInbox = {
    async record(w) {
      const inserted = await rows(
        db,
        `INSERT INTO webhook_events (webhook_request_id, provider, received_at, body, events, parse_notes) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (webhook_request_id) DO NOTHING RETURNING webhook_request_id`,
        [w.webhookRequestId, w.provider, w.receivedAt, w.body, JSON.stringify(w.events), w.parseNotes ? JSON.stringify(w.parseNotes) : null],
      );
      return inserted.length === 1;
    },
    async get(webhookRequestId) {
      const r = await firstRow(db, 'SELECT * FROM webhook_events WHERE webhook_request_id = $1', [webhookRequestId]);
      return r && toWebhook(r);
    },
    async markProcessed(webhookRequestId, at) {
      await db.query('UPDATE webhook_events SET processed_at = $2 WHERE webhook_request_id = $1', [webhookRequestId, at]);
    },
    async listRecent(limit) {
      return (await rows(db, 'SELECT * FROM webhook_events ORDER BY received_at DESC, webhook_request_id DESC LIMIT $1', [limit])).map(toWebhook);
    },
  };

  const alerts: AlertStore = {
    async insert(a) {
      await db.query('INSERT INTO alerts (alert_id, type, subject, detail, raised_at, reference) VALUES ($1,$2,$3,$4,$5,$6)', [
        a.alertId, a.type, a.subject, a.detail, a.raisedAt, a.reference ?? null,
      ]);
    },
    async get(alertId) {
      const r = await firstRow(db, 'SELECT * FROM alerts WHERE alert_id = $1', [alertId]);
      return r && toAlert(r);
    },
    async list(filter = {}) {
      const found = await rows(
        db,
        `SELECT * FROM alerts
         WHERE ($1::boolean IS NOT TRUE OR acknowledged_at IS NULL) AND ($2::text IS NULL OR type = $2) AND ($3::text IS NULL OR subject = $3)
           AND ($5::text IS NULL OR reference = $5) AND ($6::timestamptz IS NULL OR raised_at >= $6)
           AND ($7::boolean IS NULL OR (resolved_at IS NOT NULL) = $7)
         ORDER BY seq ${filter.newestFirst ? 'DESC' : 'ASC'} LIMIT $4`,
        [filter.pending ?? null, filter.type ?? null, filter.subject ?? null, filter.limit ?? null, filter.reference ?? null, filter.since ?? null, filter.resolved ?? null],
      );
      return found.map(toAlert);
    },
    async acknowledge(alertId, by, at) {
      const updated = await rows(
        db,
        'UPDATE alerts SET acknowledged_at = $3, acknowledged_by = $2 WHERE alert_id = $1 AND acknowledged_at IS NULL RETURNING alert_id',
        [alertId, by, at],
      );
      return updated.length > 0;
    },
    async resolve(match, at, resolution) {
      const updated = await rows(
        db,
        `UPDATE alerts SET resolved_at = $4, resolution = $5
         WHERE type = $1 AND ($2::text IS NULL OR subject = $2) AND ($3::text IS NULL OR reference = $3) AND resolved_at IS NULL
           AND ($6::timestamptz IS NULL OR raised_at <= $6)
         RETURNING alert_id`,
        [match.type, match.subject ?? null, match.reference ?? null, at, resolution, match.raisedNotAfter ?? null],
      );
      return updated.length;
    },
  };

  const audit: AuditLog = {
    async append(a) {
      await db.query(
        `INSERT INTO audit_entries (audit_id, actor, action, at, subject, previous_value, new_value, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [a.auditId, a.actor, a.action, a.at, a.subject, a.previousValue ?? null, a.newValue ?? null, a.note ?? null],
      );
    },
    async list() {
      return (await rows(db, 'SELECT * FROM audit_entries ORDER BY seq')).map((r): AuditEntry => ({
        auditId: r.audit_id as string,
        actor: r.actor as string,
        action: r.action as AuditAction,
        at: r.at as Date,
        subject: r.subject as string,
        previousValue: opt(r.previous_value),
        newValue: opt(r.new_value),
        note: opt(r.note),
      }));
    },
  };

  const concepts: ConceptStore = {
    async list() {
      return (await rows(db, 'SELECT * FROM concepts ORDER BY key')).map((r): Concept => ({
        key: r.key as string,
        subject: r.subject as string,
        active: r.active as boolean,
      }));
    },
    async save(c) {
      await db.query(
        `INSERT INTO concepts (key, subject, active) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET subject = EXCLUDED.subject, active = EXCLUDED.active`,
        [c.key, c.subject, c.active],
      );
    },
  };

  const settings: SettingsStore = {
    async archiveCopyEnabled() {
      const r = await firstRow(db, 'SELECT archive_copy_enabled FROM settings WHERE id = 1');
      return r?.archive_copy_enabled === true;
    },
    async setArchiveCopyEnabled(enabled) {
      await db.query('UPDATE settings SET archive_copy_enabled = $1 WHERE id = 1', [enabled]);
    },
  };

  const outbox: OutboxStore = {
    async add(e) {
      await db.query('INSERT INTO outbox_events (event_id, type, payload, occurred_at) VALUES ($1, $2, $3, $4)', [
        e.eventId, e.type, JSON.stringify(e.payload), e.occurredAt,
      ]);
    },
    async lockPending(limit) {
      const found = await rows(
        db,
        'SELECT * FROM outbox_events WHERE dispatched_at IS NULL AND dead_at IS NULL ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED',
        [limit],
      );
      return found.map((r) => ({
        event: {
          eventId: r.event_id as string,
          type: r.type as DomainEvent['type'],
          occurredAt: r.occurred_at as Date,
          payload: r.payload as DomainEvent['payload'],
        },
        attempts: r.attempts as number,
      }));
    },
    async markDispatched(eventId, at) {
      await db.query('UPDATE outbox_events SET dispatched_at = $2 WHERE event_id = $1', [eventId, at]);
    },
    async markFailed(eventId, error, deadAt) {
      await db.query('UPDATE outbox_events SET attempts = attempts + 1, last_error = $2, dead_at = $3 WHERE event_id = $1', [eventId, error, deadAt ?? null]);
    },
    async listDead(limit) {
      const found = await rows(
        db,
        'SELECT * FROM outbox_events WHERE dead_at IS NOT NULL AND dispatched_at IS NULL ORDER BY dead_at DESC, seq DESC LIMIT $1',
        [limit],
      );
      return found.map((r) => ({
        event: { eventId: r.event_id as string, type: r.type as DomainEvent['type'], occurredAt: r.occurred_at as Date, payload: r.payload as DomainEvent['payload'] },
        attempts: r.attempts as number,
        lastError: opt<string>(r.last_error),
        deadAt: r.dead_at as Date,
      }));
    },
    async purgeDispatched(before) {
      return (await rows(db, 'DELETE FROM outbox_events WHERE dispatched_at IS NOT NULL AND dispatched_at < $1 RETURNING event_id', [before])).length;
    },
    async revive(eventId) {
      const revived = await rows(
        db,
        'UPDATE outbox_events SET dead_at = NULL, attempts = 0 WHERE event_id = $1 AND dead_at IS NOT NULL AND dispatched_at IS NULL RETURNING event_id',
        [eventId],
      );
      return revived.length > 0;
    },
  };

  // D40: the same table the PostgresJobQueue claims from, written with the transaction's connection.
  const jobs: JobStore = {
    enqueue: (job) => insertJob(db, job),
  };

  return { outbox, receipts, batches, executions, executionEvents, attempts, suppressions, deliveryEvents, webhooks, alerts, audit, concepts, settings, jobs };
}

export class PostgresBulkMailerRepository implements BulkMailerRepository {
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
  readonly jobs: JobStore;

  constructor(private readonly dataSource: DataSource) {
    const s = stores(autocommit(dataSource));
    this.receipts = s.receipts;
    this.batches = s.batches;
    this.executions = s.executions;
    this.executionEvents = s.executionEvents;
    this.attempts = s.attempts;
    this.suppressions = s.suppressions;
    this.deliveryEvents = s.deliveryEvents;
    this.webhooks = s.webhooks;
    this.alerts = s.alerts;
    this.audit = s.audit;
    this.concepts = s.concepts;
    this.settings = s.settings;
    this.outbox = s.outbox;
    this.jobs = s.jobs;
  }

  async transaction<T>(work: (stores: BulkMailerStores) => Promise<T>): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const result = await work(stores(inTransaction(runner)));
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}
