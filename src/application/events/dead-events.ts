import { err, ok, type Result } from '../../domain/shared/result';
import type { BulkMailerRepository, DeadEvent } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';

export interface DeadEventsDependencies {
  readonly repository: BulkMailerRepository;
  readonly clock: Clock;
  readonly newId: () => string;
}

/** Most dead events listed at once (D39). */
export const MAX_DEAD_EVENTS = 500;

/** D39: the events the relay gave up on, most recently dead first. */
export class ListDeadEvents {
  constructor(private readonly deps: DeadEventsDependencies) {}

  execute(limit = 50): Promise<DeadEvent[]> {
    return this.deps.repository.outbox.listDead(Math.min(Math.max(1, Math.trunc(limit)), MAX_DEAD_EVENTS));
  }
}

/**
 * D39: the operator asks the relay to try a dead event again, once its cause is fixed. Its attempts start again from
 * zero. Audited. No email is sent by this: consumers only queue internal work.
 */
export class RetryDeadEvent {
  constructor(private readonly deps: DeadEventsDependencies) {}

  execute(operator: string, eventId: string, note?: string): Promise<Result<{ eventId: string }, 'OUTBOX_EVENT_NOT_DEAD'>> {
    const { repository, clock, newId } = this.deps;
    return repository.transaction(async (tx) => {
      if (!(await tx.outbox.revive(eventId))) return err('OUTBOX_EVENT_NOT_DEAD');
      const trimmed = note?.trim();
      await tx.audit.append({
        auditId: newId(),
        actor: operator,
        action: 'OUTBOX_EVENT_RETRIED',
        at: clock.now(),
        subject: eventId,
        newValue: 'pending',
        ...(trimmed ? { note: trimmed } : {}),
      });
      return ok({ eventId });
    });
  }
}
