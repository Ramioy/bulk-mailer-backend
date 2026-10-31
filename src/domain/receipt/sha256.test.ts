import { describe, expect, it } from 'vitest';

import { DomainError } from '../shared/domain-error';
import { toSha256 } from './sha256';

describe('toSha256', () => {
  it('accepts and lower-cases a 64-character hex digest', () => {
    expect(toSha256('AB'.repeat(32))).toBe('ab'.repeat(32));
  });

  it('rejects anything else', () => {
    expect(() => toSha256('abc')).toThrow(DomainError);
    expect(() => toSha256('g'.repeat(64))).toThrow(DomainError);
  });
});
