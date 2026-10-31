export const DomainEventType = {
  RECEIPTS_UPLOADED: 'RECEIPTS_UPLOADED',
  RECEIPT_REMOVED: 'RECEIPT_REMOVED',
  RECIPIENTS_REFRESHED: 'RECIPIENTS_REFRESHED',
  EXECUTION_STARTED: 'EXECUTION_STARTED',
  RECEIPT_SENT: 'RECEIPT_SENT',
  RECEIPT_SEND_FAILED: 'RECEIPT_SEND_FAILED',
  RECEIPT_UNCERTAIN: 'RECEIPT_UNCERTAIN',
  EXECUTION_FINISHED: 'EXECUTION_FINISHED',
  ALERT_RAISED: 'ALERT_RAISED',
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
