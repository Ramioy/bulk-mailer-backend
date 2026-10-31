import { DomainError } from '../shared/domain-error';
import type { DeliveryState } from './delivery-state';

export const ReceiptState = {
  PENDING: 'PENDING',
  INVALID: 'INVALID',
  SENDING: 'SENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  UNCERTAIN: 'UNCERTAIN',
  REMOVED: 'REMOVED',
} as const;
export type ReceiptState = (typeof ReceiptState)[keyof typeof ReceiptState];

/** Send state machine (docs/architecture/arquitectura.md §5). */
const TRANSITIONS: Readonly<Record<ReceiptState, readonly ReceiptState[]>> = {
  // re-upload of the same hash re-evaluates INVALID and REMOVED records (assumption A1)
  INVALID: ['PENDING', 'INVALID', 'REMOVED'],
  REMOVED: ['PENDING', 'INVALID'],
  PENDING: ['SENDING', 'REMOVED'],
  FAILED: ['SENDING', 'REMOVED'],
  // PENDING: batch stopped before calling the provider, or provider account rejection
  SENDING: ['SENT', 'FAILED', 'PENDING', 'UNCERTAIN'],
  UNCERTAIN: ['SENT', 'FAILED'],
  // manual Resend only
  SENT: ['SENDING'],
};

export function canTransition(from: ReceiptState, to: ReceiptState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ReceiptState, to: ReceiptState): void {
  if (!canTransition(from, to)) throw new DomainError(`Receipt cannot go from ${from} to ${to}`);
}

/** Resend is only offered for a SENT receipt whose delivery ended in a hard bounce or a complaint. */
export function canResend(state: ReceiptState, delivery: DeliveryState): boolean {
  return state === 'SENT' && (delivery === 'HARD_BOUNCE' || delivery === 'COMPLAINT');
}
