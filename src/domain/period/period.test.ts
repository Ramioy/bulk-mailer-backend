import { describe, expect, it } from 'vitest';

import { DomainError } from '../shared/domain-error';
import { Period } from './period';

const BOGOTA = 'America/Bogota';

describe('Period', () => {
  it('parses and prints YYYY-MM', () => {
    expect(Period.parse('2026-10')?.toString()).toBe('2026-10');
    expect(Period.parse('2026-1')).toBeUndefined();
    expect(Period.parse('2026-13')).toBeUndefined();
    expect(Period.parse('OCTUBRE_2026')).toBeUndefined();
  });

  it('rejects impossible values', () => {
    expect(() => Period.of(2026, 0)).toThrow(DomainError);
  });

  it('computes the current period in Bogota, not in UTC', () => {
    // 2026-11-01 03:00 UTC is still 2026-10-31 22:00 in Bogota (UTC-5)
    expect(Period.current(new Date('2026-11-01T03:00:00Z'), BOGOTA).toString()).toBe('2026-10');
    expect(Period.current(new Date('2026-11-01T05:00:00Z'), BOGOTA).toString()).toBe('2026-11');
  });

  it('crosses the year boundary', () => {
    expect(Period.of(2027, 1).previous().toString()).toBe('2026-12');
  });

  it('allows only the current and the previous period', () => {
    const now = new Date('2026-10-15T12:00:00Z');
    expect(Period.isOperable(Period.of(2026, 10), now, BOGOTA)).toBe(true);
    expect(Period.isOperable(Period.of(2026, 9), now, BOGOTA)).toBe(true);
    expect(Period.isOperable(Period.of(2026, 8), now, BOGOTA)).toBe(false);
    expect(Period.isOperable(Period.of(2026, 11), now, BOGOTA)).toBe(false);
  });

  it('labels the period in Spanish for the email subject', () => {
    expect(Period.of(2026, 10).label()).toBe('Octubre 2026');
  });
});
