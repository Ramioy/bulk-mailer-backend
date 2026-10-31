import type { ReceiptState } from '../receipt/receipt-state';
import { BatchStopReason, SendErrorType } from '../shared/error-types';

/**
 * Provider-neutral result of one send call. Each EmailProvider adapter maps its own
 * response codes to one of these kinds (for ZeptoMail: docs/context/12-email-provider-zeptomail.md §12.4).
 */
export type SendOutcome =
  /** The provider accepted the email. */
  | { readonly kind: 'ACCEPTED'; readonly providerRequestId: string }
  /** The provider rejected this receipt (invalid address, mime type, size limits…). */
  | { readonly kind: 'RECEIPT_REJECTED'; readonly detail: string }
  /** Credits, API key, IP, domain, account review or block. */
  | { readonly kind: 'ACCOUNT_ERROR'; readonly detail: string }
  /** Our request was malformed. */
  | { readonly kind: 'REQUEST_ERROR'; readonly detail: string }
  /** Failure before the request left (DNS, connection refused, TLS): certainty of no send. */
  | { readonly kind: 'CONNECTION_FAILED'; readonly detail: string }
  /** Timeout, 429, 5xx or undocumented response: it is unknown whether the email went out. */
  | { readonly kind: 'UNCERTAIN'; readonly detail: string; readonly retryAfterSeconds?: number };

export type SendOutcomeKind = SendOutcome['kind'];

export interface SendResolution {
  readonly receiptState: Extract<ReceiptState, 'SENT' | 'FAILED' | 'PENDING' | 'UNCERTAIN'>;
  readonly errorType?: SendErrorType;
  /** Set when this outcome alone stops the batch. Consecutive incidents are handled by ProviderIncidentTracker. */
  readonly stopBatch?: BatchStopReason;
}

/** Classification of the send response (docs/context/09-idempotency-and-uncertain-sends.md §9.2). */
export function resolveSendOutcome(outcome: SendOutcome): SendResolution {
  switch (outcome.kind) {
    case 'ACCEPTED':
      return { receiptState: 'SENT' };
    case 'RECEIPT_REJECTED':
      return { receiptState: 'FAILED', errorType: SendErrorType.PROVIDER_REJECTED };
    case 'ACCOUNT_ERROR':
      return { receiptState: 'PENDING', stopBatch: BatchStopReason.PROVIDER_ACCOUNT };
    case 'REQUEST_ERROR':
      return { receiptState: 'FAILED', errorType: SendErrorType.INTERNAL_ERROR, stopBatch: BatchStopReason.INTERNAL_ERROR };
    case 'CONNECTION_FAILED':
      return { receiptState: 'FAILED', errorType: SendErrorType.PROVIDER_UNAVAILABLE };
    case 'UNCERTAIN':
      return { receiptState: 'UNCERTAIN' };
  }
}
