import type { DomainEvent, DomainEventType } from '../../../ports/event-bus';

export interface OperationLogger {
  log(message: string): void;
}

export interface EventSubscriber {
  subscribe(type: DomainEventType, consumer: (event: DomainEvent) => Promise<void>): void;
}

/** Fields that may be logged: identifiers, states and counts. Never email addresses, file names or bodies (§15). */
const SAFE = ['sha256', 'attemptId', 'executionId', 'webhookRequestId', 'period', 'block', 'manifestVersion', 'state', 'outcome', 'errorType', 'result', 'stopReason', 'deliveryState', 'source', 'reason', 'by', 'late', 'attemptKind', 'providerCalled', 'change', 'enabled', 'released'] as const;

const LOGGED: readonly DomainEventType[] = [
  'RECEIPTS_UPLOADED',
  'RECEIPT_REMOVED',
  'DUPLICATE_CONFLICT_RESOLVED',
  'RECIPIENTS_REFRESHED',
  'EXECUTION_STARTED',
  'EXECUTION_FINISHED',
  'RECEIPT_SENT',
  'RECEIPT_SEND_FAILED',
  'RECEIPT_UNCERTAIN',
  'RECEIPT_RESOLVED',
  'WEBHOOK_RECEIVED',
  'DELIVERY_UPDATED',
  'ADDRESS_SUPPRESSED',
  'ADDRESS_RELEASED',
  'ALERT_RAISED',
  'BATCH_COMPLETED',
  'BATCH_FILES_RELEASED',
  'CONCEPT_CHANGED',
  'ARCHIVE_COPY_CHANGED',
];

/** One structured line (JSON) per operation event, with only the safe fields of its payload. */
export function operationLine(event: DomainEvent): string {
  const fields: Record<string, unknown> = { op: event.type, at: event.occurredAt.toISOString(), eventId: event.eventId };
  for (const key of SAFE) if (event.payload[key] !== undefined) fields[key] = event.payload[key];
  // Lists are counted, not written out.
  if (Array.isArray(event.payload.registered)) fields.registered = event.payload.registered.length;
  const counters = event.payload.counters as { processed?: unknown; total?: unknown } | undefined;
  if (counters) {
    fields.processed = counters.processed;
    fields.total = counters.total;
  }
  const alert = event.payload.alert as { alertId?: unknown; type?: unknown } | undefined;
  if (alert) {
    fields.alertId = alert.alertId;
    fields.alertType = alert.type;
  }
  return JSON.stringify(fields);
}

/**
 * D50 (B7): the operation log, as a consumer of the domain events the use cases already write (no coupling: the core
 * does not know it exists). One line per upload, execution start and end, send outcome, resolution, webhook, delivery
 * change, suppression and alert. It never fails: a logging problem must not make the relay deliver the event again.
 */
export function registerOperationLog(bus: EventSubscriber, logger: OperationLogger): void {
  for (const type of LOGGED) {
    bus.subscribe(type, async (event) => {
      try {
        logger.log(operationLine(event));
      } catch {
        // Logging never blocks an event.
      }
    });
  }
}
