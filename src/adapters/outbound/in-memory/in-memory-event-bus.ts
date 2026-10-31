import type { DomainEvent, EventBus } from '../../../ports/event-bus';

export class InMemoryEventBus implements EventBus {
  readonly published: DomainEvent[] = [];

  async publish(event: DomainEvent): Promise<void> {
    this.published.push(event);
  }
}
