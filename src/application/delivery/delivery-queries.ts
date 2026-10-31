import type { DeliveryWebhook } from '../../domain/receipt/delivery-webhook';
import type { Suppression } from '../../domain/suppression/suppression';
import type { BulkMailerRepository } from '../../ports/bulk-mailer-repository';
import type { SuppressionManager } from '../../ports/suppression-manager';

/** D50 (B4): the local suppression list, and what the operator must confirm to release an address (D19). */
export class ListSuppressions {
  constructor(private readonly deps: { readonly repository: BulkMailerRepository; readonly suppressionManager: SuppressionManager }) {}

  async execute(): Promise<{ release: SuppressionManager['confirmation']; addresses: Suppression[] }> {
    return { release: this.deps.suppressionManager.confirmation, addresses: await this.deps.repository.suppressions.list() };
  }
}

export const MAX_WEBHOOKS_LISTED = 500;

/** D50 (B4): webhooks received, most recent first, without their raw body (D20: JWT). */
export class ListWebhooks {
  constructor(private readonly deps: { readonly repository: BulkMailerRepository }) {}

  async execute(limit = 50): Promise<Array<Omit<DeliveryWebhook, 'body'>>> {
    const count = Math.min(Math.max(Math.trunc(limit) || 50, 1), MAX_WEBHOOKS_LISTED);
    return (await this.deps.repository.webhooks.listRecent(count)).map(({ body: _body, ...webhook }) => webhook);
  }
}

/** D50 (B4): one received webhook, with its raw body. */
export class GetWebhook {
  constructor(private readonly deps: { readonly repository: BulkMailerRepository }) {}

  execute(webhookRequestId: string): Promise<DeliveryWebhook | undefined> {
    return this.deps.repository.webhooks.get(webhookRequestId);
  }
}
