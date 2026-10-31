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
  /** D45: what the inbound adapter could not use, and why; absent when everything was read. */
  readonly parseNotes?: WebhookParseNotes;
  readonly processedAt?: Date;
}

/** D45: the event names the webhook carried and the messages dropped with their reason. */
export interface WebhookParseNotes {
  readonly eventNames: readonly string[];
  readonly dropped: ReadonlyArray<{ readonly index: string; readonly reason: string }>;
  /** Only events that are deliberately not delivery events (opens, clicks): nothing to alert about. */
  readonly onlyIgnorable: boolean;
}
