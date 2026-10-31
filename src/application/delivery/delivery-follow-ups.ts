import type { DomainEvent } from '../../ports/event-bus';
import type { DeliveryDependencies } from './delivery-dependencies';

/**
 * Consumers of domain events that schedule background work. Delivery is at-least-once: a job queued twice is
 * harmless because the work it does is idempotent.
 *
 * D40: they queue through the `JobQueue`, not inside the relay's transaction: the event bus does not carry the
 * transaction (and must not: its consumers may live elsewhere, e.g. Kafka). No job is lost: if queueing fails, the
 * consumer fails, the relay delivers the event again (and, after the maximum attempts, the event is dead and alerted,
 * D39). What can happen is a job queued twice (a failure halfway, or a relay that fails after the consumer ran): a
 * reconciliation of a receipt no longer UNCERTAIN ends at once, one still UNCERTAIN costs one more lookup, and a
 * webhook already processed is skipped.
 */
export class DeliveryFollowUps {
  constructor(private readonly deps: Pick<DeliveryDependencies, 'repository' | 'jobQueue' | 'reconciliation'>) {}

  /** RECEIPT_UNCERTAIN → reconciliation at 5, 15 and 60 minutes; the last one may mark it NOT_FOUND_AT_PROVIDER. */
  async onReceiptUncertain(event: DomainEvent): Promise<void> {
    const attemptId = await this.attemptOf(event);
    if (!attemptId) return;
    const delays = this.deps.reconciliation.uncertainDelaysMinutes;
    for (const [index, minutes] of delays.entries()) {
      await this.deps.jobQueue.enqueue({
        type: 'RECONCILE_ATTEMPT',
        payload: { attemptId, final: index === delays.length - 1 },
        runAt: new Date(event.occurredAt.getTime() + minutes * 60_000),
      });
    }
  }

  /** WEBHOOK_RECEIVED → process its events in the background. */
  async onWebhookReceived(event: DomainEvent): Promise<void> {
    await this.deps.jobQueue.enqueue({ type: 'PROCESS_DELIVERY_EVENT', payload: { webhookRequestId: String(event.payload.webhookRequestId) } });
  }

  /** Hourly; not queued again while one is still waiting or running (D38). Returns whether it was queued. */
  async requestSweep(): Promise<boolean> {
    if (await this.deps.jobQueue.hasPending('SWEEP_UNCONFIRMED')) return false;
    await this.deps.jobQueue.enqueue({ type: 'SWEEP_UNCONFIRMED', payload: {} });
    return true;
  }

  /**
   * Every minute: queues the recent-sends check only while there is something to follow (D21), and only if the
   * previous one is not still waiting or running (D38): a slow logs API must not pile checks up.
   */
  async requestRecentCheck(active: () => Promise<boolean>): Promise<boolean> {
    if (!(await active())) return false;
    if (await this.deps.jobQueue.hasPending('CHECK_RECENT_SENDS')) return false;
    await this.deps.jobQueue.enqueue({ type: 'CHECK_RECENT_SENDS', payload: {} });
    return true;
  }

  private async attemptOf(event: DomainEvent): Promise<string | undefined> {
    if (typeof event.payload.attemptId === 'string') return event.payload.attemptId;
    if (typeof event.payload.sha256 !== 'string') return undefined;
    return (await this.deps.repository.attempts.listByReceipt(event.payload.sha256 as never)).at(-1)?.attemptId;
  }
}
