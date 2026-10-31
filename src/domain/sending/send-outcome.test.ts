import { describe, expect, it } from 'vitest';

import { resolveSendOutcome, type SendOutcome } from './send-outcome';

describe('resolveSendOutcome (§9.2)', () => {
  it.each<[SendOutcome, object]>([
    [{ kind: 'ACCEPTED', providerRequestId: 'r1' }, { receiptState: 'SENT' }],
    [{ kind: 'RECEIPT_REJECTED', detail: 'SM_113' }, { receiptState: 'FAILED', errorType: 'PROVIDER_REJECTED' }],
    [{ kind: 'UNKNOWN_REJECTION', detail: 'undocumented HTTP 400: TM_3004' }, { receiptState: 'FAILED', errorType: 'PROVIDER_REJECTED' }],
    [{ kind: 'ACCOUNT_ERROR', detail: 'LE_102' }, { receiptState: 'PENDING', stopBatch: 'PROVIDER_ACCOUNT' }],
    [{ kind: 'REQUEST_ERROR', detail: 'GE_102' }, { receiptState: 'FAILED', errorType: 'INTERNAL_ERROR', stopBatch: 'INTERNAL_ERROR' }],
    [{ kind: 'CONNECTION_FAILED', detail: 'ECONNREFUSED' }, { receiptState: 'FAILED', errorType: 'PROVIDER_UNAVAILABLE' }],
    [{ kind: 'UNCERTAIN', detail: 'timeout' }, { receiptState: 'UNCERTAIN' }],
  ])('%o', (outcome, expected) => {
    expect(resolveSendOutcome(outcome)).toEqual(expected);
  });
});
