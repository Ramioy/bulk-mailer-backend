import { DomainError } from '../shared/domain-error';
import { SendErrorType, type ReceiptErrorType } from '../shared/error-types';
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
  // SENT: only with late provider evidence of a send failed as not found (D34, `awaitsLateEvidence`)
  FAILED: ['SENDING', 'REMOVED', 'SENT'],
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

/**
 * D34: a receipt FAILED because its uncertain send was not found at the provider (last reconciliation, or the
 * operator's "not sent") may still have gone out: late evidence of its latest attempt (a delivery event, or the logs)
 * turns it SENT. This is the only case where FAILED → SENT is allowed; the state machine alone cannot tell it, so
 * the application checks this before the transition.
 */
export function awaitsLateEvidence(state: ReceiptState, errorType: ReceiptErrorType | undefined): boolean {
  return state === 'FAILED' && errorType === SendErrorType.NOT_FOUND_AT_PROVIDER;
}

/** Resend is only offered for a SENT receipt whose delivery ended in a hard bounce or a complaint. */
export function canResend(state: ReceiptState, delivery: DeliveryState): boolean {
  return state === 'SENT' && (delivery === 'HARD_BOUNCE' || delivery === 'COMPLAINT' || delivery === 'PROCESS_FAILED');
}
