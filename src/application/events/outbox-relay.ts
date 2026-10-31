import type { BulkMailerRepository } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';
import type { EventBus } from '../../ports/event-bus';

/** After this many failed deliveries an event is skipped by the relay (it stays in the outbox, with its error). */
export const MAX_DELIVERY_ATTEMPTS = 10;

/**
 * Moves committed domain events from the outbox to the event bus, oldest first.
 * At-least-once: an event is marked dispatched only after the bus accepted it.
 */
export class OutboxRelay {
  constructor(
    private readonly repository: BulkMailerRepository,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly batchSize = 50,
  ) {}

  /** Delivers what is pending; returns how many events were dispatched. */
  async drain(): Promise<number> {
    return this.repository.transaction(async (tx) => {
      let dispatched = 0;
      for (const { event, attempts } of await tx.outbox.lockPending(this.batchSize)) {
        if (attempts >= MAX_DELIVERY_ATTEMPTS) continue;
        try {
          await this.bus.publish(event);
          await tx.outbox.markDispatched(event.eventId, this.clock.now());
          dispatched += 1;
        } catch (error) {
          await tx.outbox.markFailed(event.eventId, error instanceof Error ? error.message : String(error));
        }
      }
      return dispatched;
    });
  }
}
