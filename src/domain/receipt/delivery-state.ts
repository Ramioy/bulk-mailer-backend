export const DeliveryState = {
  UNCONFIRMED: 'UNCONFIRMED',
  SOFT_BOUNCE: 'SOFT_BOUNCE',
  ACCEPTED: 'ACCEPTED',
  HARD_BOUNCE: 'HARD_BOUNCE',
  COMPLAINT: 'COMPLAINT',
} as const;
export type DeliveryState = (typeof DeliveryState)[keyof typeof DeliveryState];

const NEXT: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
  UNCONFIRMED: ['SOFT_BOUNCE', 'ACCEPTED', 'HARD_BOUNCE'],
  SOFT_BOUNCE: ['ACCEPTED', 'HARD_BOUNCE'],
  ACCEPTED: ['COMPLAINT'],
  HARD_BOUNCE: [],
  COMPLAINT: [],
};

const LEVEL: Readonly<Record<DeliveryState, number>> = {
  UNCONFIRMED: 0,
  SOFT_BOUNCE: 1,
  ACCEPTED: 2,
  HARD_BOUNCE: 2,
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
