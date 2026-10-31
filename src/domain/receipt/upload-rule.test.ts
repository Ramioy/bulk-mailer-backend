import { describe, expect, it } from 'vitest';

import { Period } from '../period/period';
import type { ReceiptState } from './receipt-state';
import { decideUpload, type ExistingReceipt } from './upload-rule';

const OCT = Period.of(2026, 10);
const existing = (state: ReceiptState, overrides: Partial<ExistingReceipt> = {}): ExistingReceipt => ({
  period: OCT,
  block: 'CASH',
  state,
  fileAvailable: true,
  ...overrides,
});

describe('decideUpload (assumption A1)', () => {
  it('registers an unknown hash', () => {
    expect(decideUpload(undefined, OCT, 'CASH')).toBe('NEW');
  });

  it.each(['INVALID', 'REMOVED'] as const)('re-evaluates %s in the same batch', (state) => {
    expect(decideUpload(existing(state), OCT, 'CASH')).toBe('RE_EVALUATE');
  });

  it('re-evaluates a FAILED receipt whose file was purged', () => {
    expect(decideUpload(existing('FAILED', { fileAvailable: false }), OCT, 'CASH')).toBe('RE_EVALUATE');
  });

  it.each(['PENDING', 'SENDING', 'SENT', 'UNCERTAIN', 'FAILED'] as const)('discards %s with its file in the same batch', (state) => {
    expect(decideUpload(existing(state), OCT, 'CASH')).toBe('DUPLICATE');
  });

  it('discards the same content in another block or period, whatever its state', () => {
    expect(decideUpload(existing('REMOVED'), OCT, 'ANGLO')).toBe('DUPLICATE');
    expect(decideUpload(existing('INVALID'), Period.of(2026, 9), 'CASH')).toBe('DUPLICATE');
  });
});
