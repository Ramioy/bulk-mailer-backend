import type { IncomingDeliveryEvent } from './delivery-state';

/** A provider webhook as received: kept raw, with the events the inbound adapter read from it. */
export interface DeliveryWebhook {
  /** Provider id of the webhook transaction; a second delivery with the same id is a duplicate. */
  readonly webhookRequestId: string;
  readonly provider: string;
  readonly receivedAt: Date;
  /** Raw event as received (after the signature check). */
  readonly body: string;
  /** Empty when nothing usable could be read: the raw body is kept anyway. */
  readonly events: readonly IncomingDeliveryEvent[];
  readonly processedAt?: Date;
}
