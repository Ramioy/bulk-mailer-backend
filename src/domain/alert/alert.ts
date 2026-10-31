export const AlertType = {
  BATCH_STOPPED: 'BATCH_STOPPED',
  MALICIOUS_FILE: 'MALICIOUS_FILE',
  HARD_BOUNCE: 'HARD_BOUNCE',
  COMPLAINT: 'COMPLAINT',
  WEBHOOKS_NOT_RECEIVED: 'WEBHOOKS_NOT_RECEIVED',
  /** The provider rejected a send with a code we do not know (M1): to be reviewed and added to the classification. */
  PROVIDER_UNKNOWN_ERROR: 'PROVIDER_UNKNOWN_ERROR',
  /** The provider accepted a send and then failed to process it (M2): the receipt can be resent. */
  PROCESS_FAILED: 'PROCESS_FAILED',
  /** D31: content already sent was uploaded again under another name: check it reached the right client. */
  DUPLICATE_CONFLICT: 'DUPLICATE_CONFLICT',
  /** The archive copy mailbox bounced; it does not affect the receipt. */
  COPY_BOUNCED: 'COPY_BOUNCED',
  /** D34: a send failed as not found at the provider did go out after all; the receipt is now SENT. */
  LATE_SEND_EVIDENCE: 'LATE_SEND_EVIDENCE',
  /**
   * D34: an older send believed not sent did go out, and a later attempt was sent too: the client probably received
   * the email twice.
   */
  DUPLICATE_SEND_DETECTED: 'DUPLICATE_SEND_DETECTED',
  /** D39: a domain event could not be delivered after the maximum attempts; its consumers did not run. */
  OUTBOX_EVENT_DEAD: 'OUTBOX_EVENT_DEAD',
  /** D41: receipt files that should have been deleted could not be (Ley 1581: they must not be kept). */
  FILE_PURGE_FAILED: 'FILE_PURGE_FAILED',
  /** D43: an UNCERTAIN send is still unresolved after its last scheduled lookup; the operator can verify or resolve it. */
  UNCERTAIN_UNRESOLVED: 'UNCERTAIN_UNRESOLVED',
  /** D45: an authenticated webhook from which no event of ours could be read: probably the payload format (§12.7). */
  WEBHOOK_UNPARSED: 'WEBHOOK_UNPARSED',
} as const;
export type AlertType = (typeof AlertType)[keyof typeof AlertType];

/** Every alert is persisted, whatever providers deliver it. */
export interface Alert {
  readonly alertId: string;
  readonly type: AlertType;
  /** What it is about: a receipt hash, an execution id, an address… */
  readonly subject: string;
  readonly detail: string;
  readonly raisedAt: Date;
  /** D50: what else identifies it (e.g. the attempt id), so it is deduplicated without reading its text. */
  readonly reference?: string;
  /** D46: the operator saw it and dealt with it; it stays in the history. */
  readonly acknowledgedAt?: Date;
  readonly acknowledgedBy?: string;
}

/** D46: which alerts to list. Without filters, every alert, oldest first. */
export interface AlertFilter {
  /** Only the alerts nobody acknowledged yet. */
  readonly pending?: boolean;
  readonly type?: AlertType;
  readonly subject?: string;
  /** D50 */
  readonly reference?: string;
  /** D50: raised at or after this instant. */
  readonly since?: Date;
  /** Newest first (and `limit` keeps the newest). */
  readonly newestFirst?: boolean;
  readonly limit?: number;
}
