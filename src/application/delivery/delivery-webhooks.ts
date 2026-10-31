import type { DeliveryWebhook } from '../../domain/receipt/delivery-webhook';
import type { BulkMailerStores } from '../../ports/bulk-mailer-repository';
import { raiseAlert } from '../alerts/raise-alert';
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
  constructor(private readonly deps: Pick<DeliveryDependencies, 'repository' | 'clock' | 'newId' | 'serial'>) {}

  async execute(webhookRequestId: string): Promise<ApplyResult[]> {
    const { repository, clock, newId, serial } = this.deps;
    const webhook = await repository.webhooks.get(webhookRequestId);
    if (!webhook || webhook.processedAt) return [];
    const now = clock.now();
    return serial.run(() => repository.transaction(async (tx) => {
      const results: ApplyResult[] = [];
      for (const event of webhook.events) results.push(await applyIncomingEvent(tx, newId, now, event));
      await tx.webhooks.markProcessed(webhookRequestId, now);
      await unparsedAlert(tx, newId, now, webhook, results);
      return results;
    }));
  }
}

/**
 * D45: a webhook that arrived and was authenticated but tells us nothing we can use (no event could be read, or none
 * belongs to an attempt of ours) is the most likely sign that ZeptoMail's real payload differs from what the parser
 * assumes (§12.7). It must not pass in silence: one alert per webhook. Opens and clicks only are not alerted.
 */
async function unparsedAlert(tx: BulkMailerStores, newId: () => string, now: Date, webhook: DeliveryWebhook, results: readonly ApplyResult[]): Promise<void> {
  const notes = webhook.parseNotes;
  const nothingRead = webhook.events.length === 0 && !notes?.onlyIgnorable;
  const unknown = results.length > 0 && results.every((r) => r === 'UNKNOWN_ATTEMPT');
  if (!nothingRead && !unknown) return;
  if ((await tx.alerts.list({ type: 'WEBHOOK_UNPARSED', subject: webhook.webhookRequestId, limit: 1 })).length > 0) return;
  const why = nothingRead
    ? `no delivery event could be read; dropped: ${(notes?.dropped ?? []).map((d) => `[${d.index}] ${d.reason}`).join('; ') || 'nothing readable'}`
    : `${results.length} event(s), none for an attempt of ours (client_reference unknown: ${[...new Set(webhook.events.map((e) => e.attemptId))].join(', ')})`;
  const names = notes?.eventNames.length ? `; event names seen: ${notes.eventNames.join(', ')}` : '';
  await raiseAlert(tx, newId, {
    alertId: newId(),
    type: 'WEBHOOK_UNPARSED',
    subject: webhook.webhookRequestId,
    detail: `Webhook ${webhook.webhookRequestId}: ${why}${names}. Check the payload at GET /webhooks/zeptomail/events/${webhook.webhookRequestId} and the parser assumptions (§12.7).`,
    raisedAt: now,
  });
}
