import { describe, expect, it } from 'vitest';

import { applyDeliveryEvent } from './delivery-state';

describe('applyDeliveryEvent', () => {
  it.each([
    ['UNCONFIRMED', 'SOFT_BOUNCE'],
    ['UNCONFIRMED', 'ACCEPTED'],
    ['UNCONFIRMED', 'HARD_BOUNCE'],
    ['SOFT_BOUNCE', 'ACCEPTED'],
    ['SOFT_BOUNCE', 'HARD_BOUNCE'],
    ['ACCEPTED', 'COMPLAINT'],
    ['UNCONFIRMED', 'COMPLAINT'],
  ] as const)('advances %s → %s', (current, incoming) => {
    expect(applyDeliveryEvent(current, incoming)).toEqual({ kind: 'ADVANCED', state: incoming });
  });

  it('ignores a late soft bounce after accepted', () => {
    expect(applyDeliveryEvent('ACCEPTED', 'SOFT_BOUNCE')).toEqual({ kind: 'IGNORED', state: 'ACCEPTED' });
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
