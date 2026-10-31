import { randomUUID } from 'node:crypto';

import type { BulkMailerRepository, BulkMailerStores } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';
import type { DomainEvent, EventBus } from '../../ports/event-bus';
import { raiseAlert } from '../alerts/raise-alert';

/** After this many failed deliveries an event is dead: it leaves the pending window, with its error (D39). */
export const MAX_DELIVERY_ATTEMPTS = 10;

export interface RelayLogger {
  error(message: string): void;
}

export interface OutboxRelayOptions {
  /** Events read per transaction; default 50. */
  readonly batchSize?: number;
  readonly newId?: () => string;
  readonly logger?: RelayLogger;
}

/**
 * Moves committed domain events from the outbox to the event bus, oldest first.
 * At-least-once: an event is marked dispatched only after the bus accepted it.
 *
 * D39: on its last failed delivery an event is marked dead, so it can never block the events behind it, and the
 * OUTBOX_EVENT_DEAD alert is raised in the same transaction. A dead ALERT_RAISED event raises no other alert (that
 * alert's own event could die too, without end): it is only logged; the alert itself is already stored.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly newId: () => string;
  private readonly logger: RelayLogger | undefined;

  constructor(
    private readonly repository: BulkMailerRepository,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    options: OutboxRelayOptions | number = {},
  ) {
    const resolved = typeof options === 'number' ? { batchSize: options } : options;
    this.batchSize = resolved.batchSize ?? 50;
    this.newId = resolved.newId ?? randomUUID;
    this.logger = resolved.logger;
  }

  /** Delivers what is pending; returns how many events were dispatched. */
  async drain(): Promise<number> {
    return this.repository.transaction(async (tx) => {
      let dispatched = 0;
      for (const { event, attempts } of await tx.outbox.lockPending(this.batchSize)) {
        try {
          await this.bus.publish(event);
          await tx.outbox.markDispatched(event.eventId, this.clock.now());
          dispatched += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const dies = attempts + 1 >= MAX_DELIVERY_ATTEMPTS;
          await tx.outbox.markFailed(event.eventId, message, dies ? this.clock.now() : undefined);
          if (dies) await this.died(tx, event, attempts + 1, message);
        }
      }
      return dispatched;
    });
  }

  private async died(tx: BulkMailerStores, event: DomainEvent, attempts: number, error: string): Promise<void> {
    const detail = `${event.type} not delivered after ${attempts} attempts: ${error}`;
    if (event.type === 'ALERT_RAISED') {
      this.logger?.error(`Outbox event ${event.eventId} is dead (${detail}); no alert for a dead alert event`);
      return;
    }
    await raiseAlert(tx, this.newId, { alertId: this.newId(), type: 'OUTBOX_EVENT_DEAD', subject: event.eventId, detail, raisedAt: this.clock.now() });
  }
}
