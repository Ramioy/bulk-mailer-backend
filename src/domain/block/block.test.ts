import { describe, expect, it } from 'vitest';

import { BLOCKS, contractSourceOf, isBlock } from './block';

describe('Block', () => {
  it('has six blocks and only ANGLO resolves against SAP', () => {
    expect(BLOCKS).toHaveLength(6);
    expect(BLOCKS.filter((b) => contractSourceOf(b) === 'SAP')).toEqual(['ANGLO']);
  });

  it('recognises block names', () => {
    expect(isBlock('CASH')).toBe(true);
    expect(isBlock('EFECTIVO')).toBe(false);
  });
});
