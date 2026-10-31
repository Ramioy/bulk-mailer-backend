export const DeliveryState = {
  UNCONFIRMED: 'UNCONFIRMED',
  SOFT_BOUNCE: 'SOFT_BOUNCE',
  ACCEPTED: 'ACCEPTED',
  HARD_BOUNCE: 'HARD_BOUNCE',
  COMPLAINT: 'COMPLAINT',
  /** Accepted by the provider and then not processed (only its logs show it, M2): not delivered, can be resent. */
  PROCESS_FAILED: 'PROCESS_FAILED',
} as const;
export type DeliveryState = (typeof DeliveryState)[keyof typeof DeliveryState];

const NEXT: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
  // a complaint implies the message arrived, even if the acceptance event was not received (P5)
  UNCONFIRMED: ['SOFT_BOUNCE', 'ACCEPTED', 'HARD_BOUNCE', 'COMPLAINT', 'PROCESS_FAILED'],
  SOFT_BOUNCE: ['ACCEPTED', 'HARD_BOUNCE', 'PROCESS_FAILED'],
  ACCEPTED: ['COMPLAINT'],
  HARD_BOUNCE: [],
  COMPLAINT: [],
  PROCESS_FAILED: [],
};

const LEVEL: Readonly<Record<DeliveryState, number>> = {
  UNCONFIRMED: 0,
  SOFT_BOUNCE: 1,
  ACCEPTED: 2,
  HARD_BOUNCE: 2,
  PROCESS_FAILED: 2,
  COMPLAINT: 3,
};

export type DeliveryEventOutcome =
  | { readonly kind: 'ADVANCED'; readonly state: DeliveryState }
  /** Same state again, or an event older than the current state: nothing changes. */
  | { readonly kind: 'IGNORED'; readonly state: DeliveryState }
  /** Conflicting event that the state machine does not allow: recorded, state unchanged. */
  | { readonly kind: 'ANOMALY'; readonly state: DeliveryState };

/** The delivery state only advances; a late event never moves it back. */
export function applyDeliveryEvent(current: DeliveryState, incoming: DeliveryState): DeliveryEventOutcome {
  if (NEXT[current].includes(incoming)) return { kind: 'ADVANCED', state: incoming };
  if (incoming === current || LEVEL[incoming] < LEVEL[current]) return { kind: 'IGNORED', state: current };
  return { kind: 'ANOMALY', state: current };
}

/** Where the delivery state was learnt: a provider webhook or a lookup in the provider logs (reconciliation). */
export type DeliveryEventSource = 'WEBHOOK' | 'LOGS';

/** Delivery event as an inbound adapter or the provider logs report it, before it is matched to its attempt. */
export interface IncomingDeliveryEvent {
  /** Provider id of the event, used to discard duplicates. */
  readonly eventId: string;
  /** `client_reference` of the send. */
  readonly attemptId: string;
  /** Recipient the event is about; absent when the provider does not say it. */
  readonly recipient?: string;
  readonly state: Exclude<DeliveryState, 'UNCONFIRMED'>;
  readonly reason?: string;
  readonly occurredAt: Date;
  readonly source: DeliveryEventSource;
  readonly providerRequestId?: string;
  readonly emailReference?: string;
}

/** Delivery event as recorded, matched to its attempt. */
export interface DeliveryEvent extends IncomingDeliveryEvent {
  /** Empty when the provider did not say it. */
  readonly recipient: string;
  /** Only the primary recipient's events change the receipt's delivery state. */
  readonly isPrimaryRecipient: boolean;
}

/**
 * Which recipient of the attempt an event is about. Without a recipient in the event, it can only be the primary
 * one when the email had no copy; otherwise it is unknown and the event does not change the receipt.
 */
export function eventRecipientRole(
  attempt: { readonly to: string; readonly copyAddress?: string },
  recipient: string | undefined,
): 'PRIMARY' | 'COPY' | 'UNKNOWN' {
  const same = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
  if (recipient === undefined || recipient === '') return attempt.copyAddress ? 'UNKNOWN' : 'PRIMARY';
  if (same(recipient, attempt.to)) return 'PRIMARY';
  if (same(recipient, attempt.copyAddress)) return 'COPY';
  return 'UNKNOWN';
}
