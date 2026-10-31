import { describe, expect, it } from 'vitest';

import { applyDeliveryEvent, eventRecipientRole } from './delivery-state';

describe('applyDeliveryEvent', () => {
  it.each([
    ['UNCONFIRMED', 'SOFT_BOUNCE'],
    ['UNCONFIRMED', 'ACCEPTED'],
    ['UNCONFIRMED', 'HARD_BOUNCE'],
    ['SOFT_BOUNCE', 'ACCEPTED'],
    ['SOFT_BOUNCE', 'HARD_BOUNCE'],
    ['ACCEPTED', 'COMPLAINT'],
    ['UNCONFIRMED', 'COMPLAINT'],
    ['UNCONFIRMED', 'PROCESS_FAILED'],
    ['SOFT_BOUNCE', 'PROCESS_FAILED'],
  ] as const)('advances %s → %s', (current, incoming) => {
    expect(applyDeliveryEvent(current, incoming)).toEqual({ kind: 'ADVANCED', state: incoming });
  });

  it('ignores a late soft bounce after accepted', () => {
    expect(applyDeliveryEvent('ACCEPTED', 'SOFT_BOUNCE')).toEqual({ kind: 'IGNORED', state: 'ACCEPTED' });
  });

  it('M2: PROCESS_FAILED is final; a later event is an anomaly', () => {
    expect(applyDeliveryEvent('PROCESS_FAILED', 'ACCEPTED')).toEqual({ kind: 'ANOMALY', state: 'PROCESS_FAILED' });
    expect(applyDeliveryEvent('ACCEPTED', 'PROCESS_FAILED')).toEqual({ kind: 'ANOMALY', state: 'ACCEPTED' });
  });

  it('ignores a repeated event', () => {
    expect(applyDeliveryEvent('HARD_BOUNCE', 'HARD_BOUNCE')).toEqual({ kind: 'IGNORED', state: 'HARD_BOUNCE' });
  });

  it('records a same-level conflict as an anomaly without changing the state', () => {
    expect(applyDeliveryEvent('ACCEPTED', 'HARD_BOUNCE')).toEqual({ kind: 'ANOMALY', state: 'ACCEPTED' });
    expect(applyDeliveryEvent('HARD_BOUNCE', 'ACCEPTED')).toEqual({ kind: 'ANOMALY', state: 'HARD_BOUNCE' });
  });

  it('ignores a late acceptance after a complaint', () => {
    expect(applyDeliveryEvent('COMPLAINT', 'ACCEPTED')).toEqual({ kind: 'IGNORED', state: 'COMPLAINT' });
  });
});

describe('eventRecipientRole', () => {
  it('matches the primary recipient and the archive copy, ignoring case', () => {
    const attempt = { to: 'admin@altos.com', copyAddress: 'archivo@anutibara.com' };
    expect(eventRecipientRole(attempt, 'Admin@Altos.com')).toBe('PRIMARY');
    expect(eventRecipientRole(attempt, 'archivo@anutibara.com')).toBe('COPY');
    expect(eventRecipientRole(attempt, 'otro@altos.com')).toBe('UNKNOWN');
  });

  it('without a recipient in the event, it is the primary one only when there was no copy', () => {
    expect(eventRecipientRole({ to: 'admin@altos.com' }, undefined)).toBe('PRIMARY');
    expect(eventRecipientRole({ to: 'admin@altos.com', copyAddress: 'archivo@anutibara.com' }, undefined)).toBe('UNKNOWN');
  });
});
