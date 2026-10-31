import { describe, expect, it } from 'vitest';

import { DomainError } from '../shared/domain-error';
import { assertTransition, awaitsLateEvidence, canResend, canTransition, ReceiptState, type ReceiptState as State } from './receipt-state';

const ALL = Object.values(ReceiptState);

const ALLOWED: ReadonlyArray<readonly [State, State]> = [
  ['INVALID', 'PENDING'],
  ['INVALID', 'INVALID'],
  ['INVALID', 'REMOVED'],
  ['REMOVED', 'PENDING'],
  ['REMOVED', 'INVALID'],
  ['PENDING', 'SENDING'],
  ['PENDING', 'REMOVED'],
  ['FAILED', 'SENDING'],
  ['FAILED', 'REMOVED'],
  // only with late provider evidence (D34, awaitsLateEvidence)
  ['FAILED', 'SENT'],
  ['SENDING', 'SENT'],
  ['SENDING', 'FAILED'],
  ['SENDING', 'PENDING'],
  ['SENDING', 'UNCERTAIN'],
  ['UNCERTAIN', 'SENT'],
  ['UNCERTAIN', 'FAILED'],
  ['SENT', 'SENDING'],
];

describe('receipt send state', () => {
  it('allows exactly the transitions of the state diagram', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const expected = ALLOWED.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
  });

  it('never removes a SENT or UNCERTAIN receipt', () => {
    expect(() => assertTransition('SENT', 'REMOVED')).toThrow(DomainError);
    expect(() => assertTransition('UNCERTAIN', 'REMOVED')).toThrow(DomainError);
  });

  it('never resends an UNCERTAIN receipt automatically', () => {
    expect(canTransition('UNCERTAIN', 'SENDING')).toBe(false);
  });

  it('offers Resend only after a hard bounce or a complaint', () => {
    expect(canResend('SENT', 'HARD_BOUNCE')).toBe(true);
    expect(canResend('SENT', 'COMPLAINT')).toBe(true);
    expect(canResend('SENT', 'PROCESS_FAILED')).toBe(true);
    expect(canResend('SENT', 'ACCEPTED')).toBe(false);
    expect(canResend('SENT', 'SOFT_BOUNCE')).toBe(false);
    expect(canResend('FAILED', 'HARD_BOUNCE')).toBe(false);
  });
});

describe('late evidence (D34)', () => {
  it('only a send failed as not found at the provider may become SENT', () => {
    expect(awaitsLateEvidence('FAILED', 'NOT_FOUND_AT_PROVIDER')).toBe(true);
    for (const errorType of ['PROVIDER_REJECTED', 'RECIPIENT_CHANGED', 'FILE_MODIFIED', 'SOURCE_UNAVAILABLE', 'INTERNAL_ERROR', undefined] as const) {
      expect(awaitsLateEvidence('FAILED', errorType), `FAILED / ${String(errorType)}`).toBe(false);
    }
    expect(awaitsLateEvidence('UNCERTAIN', 'NOT_FOUND_AT_PROVIDER')).toBe(false);
    expect(awaitsLateEvidence('PENDING', undefined)).toBe(false);
  });
});
