export interface DomainEvent {
  readonly type: string;
  readonly occurredAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Domain and progress events. Initially an outbox in the database. */
export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
}
