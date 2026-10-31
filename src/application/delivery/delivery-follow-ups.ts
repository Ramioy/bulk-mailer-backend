import type { DomainEvent } from '../../ports/event-bus';
import type { DeliveryDependencies } from './delivery-dependencies';

/**
 * Consumers of domain events that schedule background work. Delivery is at-least-once: a job queued twice is
 * harmless because the work it does is idempotent.
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

  async requestSweep(): Promise<void> {
    await this.deps.jobQueue.enqueue({ type: 'SWEEP_UNCONFIRMED', payload: {} });
  }

  private async attemptOf(event: DomainEvent): Promise<string | undefined> {
    if (typeof event.payload.attemptId === 'string') return event.payload.attemptId;
    if (typeof event.payload.sha256 !== 'string') return undefined;
    return (await this.deps.repository.attempts.listByReceipt(event.payload.sha256 as never)).at(-1)?.attemptId;
  }
}
