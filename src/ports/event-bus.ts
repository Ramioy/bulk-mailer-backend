export const DomainEventType = {
  RECEIPTS_UPLOADED: 'RECEIPTS_UPLOADED',
  RECEIPT_REMOVED: 'RECEIPT_REMOVED',
  DUPLICATE_CONFLICT_RESOLVED: 'DUPLICATE_CONFLICT_RESOLVED',
  RECIPIENTS_REFRESHED: 'RECIPIENTS_REFRESHED',
  EXECUTION_STARTED: 'EXECUTION_STARTED',
  RECEIPT_SENT: 'RECEIPT_SENT',
  RECEIPT_SEND_FAILED: 'RECEIPT_SEND_FAILED',
  RECEIPT_UNCERTAIN: 'RECEIPT_UNCERTAIN',
  EXECUTION_FINISHED: 'EXECUTION_FINISHED',
  ALERT_RAISED: 'ALERT_RAISED',
  /** A provider webhook was stored; its events are processed in the background. */
  WEBHOOK_RECEIVED: 'WEBHOOK_RECEIVED',
  DELIVERY_UPDATED: 'DELIVERY_UPDATED',
  /** An UNCERTAIN receipt was resolved, by reconciliation or by the operator. */
  RECEIPT_RESOLVED: 'RECEIPT_RESOLVED',
  ADDRESS_SUPPRESSED: 'ADDRESS_SUPPRESSED',
  ADDRESS_RELEASED: 'ADDRESS_RELEASED',
  /** A concept was added, retired, reactivated or got a new subject. */
  CONCEPT_CHANGED: 'CONCEPT_CHANGED',
  ARCHIVE_COPY_CHANGED: 'ARCHIVE_COPY_CHANGED',
} as const;
export type DomainEventType = (typeof DomainEventType)[keyof typeof DomainEventType];

export interface DomainEvent {
  readonly eventId: string;
  readonly type: DomainEventType;
  readonly occurredAt: Date;
  /** JSON-serialisable. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Delivers domain events to their consumers. Events reach it only through the outbox relay, after the
 * transaction that produced them committed; delivery is at-least-once, so consumers must be idempotent.
 * In-process for now; Kafka in the future.
 */
export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
}
