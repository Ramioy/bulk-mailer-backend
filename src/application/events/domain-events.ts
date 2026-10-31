import type { DomainEvent, DomainEventType } from '../../ports/event-bus';

export function domainEvent(newId: () => string, type: DomainEventType, occurredAt: Date, payload: Record<string, unknown>): DomainEvent {
  return { eventId: newId(), type, occurredAt, payload };
}
