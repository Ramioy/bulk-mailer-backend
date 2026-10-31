import type { DomainEvent, DomainEventType, EventBus } from '../../../ports/event-bus';

export type EventConsumer = (event: DomainEvent) => Promise<void>;

/**
 * Delivers each event to the consumers subscribed to its type, inside this process.
 * If any consumer fails, publish fails and the relay delivers the event again later.
 */
export class InProcessEventBus implements EventBus {
  private readonly consumers = new Map<DomainEventType, EventConsumer[]>();

  subscribe(type: DomainEventType, consumer: EventConsumer): void {
    this.consumers.set(type, [...(this.consumers.get(type) ?? []), consumer]);
  }

  async publish(event: DomainEvent): Promise<void> {
    const results = await Promise.allSettled((this.consumers.get(event.type) ?? []).map((consume) => consume(event)));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) throw new Error(failures.map((f) => String(f.reason)).join('; '));
  }
}
