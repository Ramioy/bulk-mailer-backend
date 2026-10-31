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

  it('re-evaluates a PENDING receipt whose file was released (D51)', () => {
    expect(decideUpload(existing('PENDING', { fileAvailable: false }), OCT, 'CASH')).toBe('RE_EVALUATE');
    expect(decideUpload(existing('PENDING', { fileAvailable: false }), OCT, 'ANGLO')).toBe('DUPLICATE');
  });

  it.each(['PENDING', 'SENDING', 'SENT', 'UNCERTAIN', 'FAILED'] as const)('discards %s with its file in the same batch', (state) => {
    expect(decideUpload(existing(state), OCT, 'CASH')).toBe('DUPLICATE');
  });

  it('moves a receipt removed from another block or period (D8)', () => {
    expect(decideUpload(existing('REMOVED'), OCT, 'ANGLO')).toBe('MOVE');
    expect(decideUpload(existing('REMOVED'), Period.of(2026, 9), 'CASH')).toBe('MOVE');
  });

  it.each(['PENDING', 'INVALID', 'FAILED', 'SENT', 'UNCERTAIN'] as const)('discards %s content of another batch', (state) => {
    expect(decideUpload(existing(state), OCT, 'ANGLO')).toBe('DUPLICATE');
    expect(decideUpload(existing(state, { fileAvailable: false }), Period.of(2026, 9), 'CASH')).toBe('DUPLICATE');
  });

  it.each(['HARD_BOUNCE', 'COMPLAINT'] as const)('gives the file back to a SENT receipt after %s, for Resend (A2)', (delivery) => {
    expect(decideUpload(existing('SENT', { fileAvailable: false, deliveryState: delivery }), OCT, 'CASH')).toBe('RESTORE_FILE');
    expect(decideUpload(existing('SENT', { fileAvailable: true, deliveryState: delivery }), OCT, 'CASH')).toBe('DUPLICATE');
    expect(decideUpload(existing('SENT', { fileAvailable: false, deliveryState: delivery }), OCT, 'ANGLO')).toBe('DUPLICATE');
  });

  it.each(['UNCONFIRMED', 'ACCEPTED', 'SOFT_BOUNCE'] as const)('discards a SENT receipt with delivery %s', (delivery) => {
    expect(decideUpload(existing('SENT', { fileAvailable: false, deliveryState: delivery }), OCT, 'CASH')).toBe('DUPLICATE');
  });
});
