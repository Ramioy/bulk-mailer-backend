import type { DeliveryWebhook } from '../../domain/receipt/delivery-webhook';
import { domainEvent } from '../events/domain-events';
import { applyIncomingEvent, type ApplyResult } from './apply-delivery-event';
import type { DeliveryDependencies } from './delivery-dependencies';

/**
 * Reception of a provider webhook, already authenticated by the inbound adapter (§12.5): the raw event is kept and
 * processed in the background. A repeated webhook_request_id is a duplicate and changes nothing.
 */
export class RecordDeliveryWebhook {
  constructor(private readonly deps: Pick<DeliveryDependencies, 'repository' | 'newId'>) {}

  async execute(webhook: DeliveryWebhook): Promise<{ duplicate: boolean }> {
    const { repository, newId } = this.deps;
    const stored = await repository.transaction(async (tx) => {
      if (!(await tx.webhooks.record(webhook))) return false;
      await tx.outbox.add(domainEvent(newId, 'WEBHOOK_RECEIVED', webhook.receivedAt, { webhookRequestId: webhook.webhookRequestId }));
      return true;
    });
    return { duplicate: !stored };
  }
}

/** ProcessDeliveryEvent: applies the events of a stored webhook. Safe to run twice (events are unique by id). */
export class ProcessDeliveryEvent {
  constructor(private readonly deps: Pick<DeliveryDependencies, 'repository' | 'clock' | 'newId'>) {}

  async execute(webhookRequestId: string): Promise<ApplyResult[]> {
    const { repository, clock, newId } = this.deps;
    const webhook = await repository.webhooks.get(webhookRequestId);
    if (!webhook || webhook.processedAt) return [];
    const now = clock.now();
    return repository.transaction(async (tx) => {
      const results: ApplyResult[] = [];
      for (const event of webhook.events) results.push(await applyIncomingEvent(tx, newId, now, event));
      await tx.webhooks.markProcessed(webhookRequestId, now);
      return results;
    });
  }
}
