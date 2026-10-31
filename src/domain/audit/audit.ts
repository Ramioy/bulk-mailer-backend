export const AuditAction = {
  SIGN_IN: 'SIGN_IN',
  SIGN_IN_FAILED: 'SIGN_IN_FAILED',
  SESSION_RENEWED: 'SESSION_RENEWED',
  SIGN_OUT: 'SIGN_OUT',
  RECEIPTS_UPLOADED: 'RECEIPTS_UPLOADED',
  RECEIPT_REMOVED: 'RECEIPT_REMOVED',
  /** D31: the operator chose the right name for content uploaded under several names. */
  DUPLICATE_CONFLICT_RESOLVED: 'DUPLICATE_CONFLICT_RESOLVED',
  RECIPIENTS_REFRESHED: 'RECIPIENTS_REFRESHED',
  /** The operator fetched the batch summary; recorded with its manifest version. */
  BATCH_REVIEWED: 'BATCH_REVIEWED',
  BATCH_EXECUTED: 'BATCH_EXECUTED',
  /** D32: the operator ended an execution that stopped making progress (emergency exit, without restarting). */
  EXECUTION_ABORTED: 'EXECUTION_ABORTED',
  RECEIPT_RESENT: 'RECEIPT_RESENT',
  UNCERTAIN_RESOLVED: 'UNCERTAIN_RESOLVED',
  /** The operator checked the delivery in the provider logs (D22). */
  DELIVERY_VERIFIED: 'DELIVERY_VERIFIED',
  ADDRESS_RELEASED: 'ADDRESS_RELEASED',
  CONCEPT_CHANGED: 'CONCEPT_CHANGED',
  ARCHIVE_COPY_CHANGED: 'ARCHIVE_COPY_CHANGED',
  /** D39: the operator asked the relay to try a dead outbox event again. */
  OUTBOX_EVENT_RETRIED: 'OUTBOX_EVENT_RETRIED',
  /** D46: the operator acknowledged an alert. */
  ALERT_ACKNOWLEDGED: 'ALERT_ACKNOWLEDGED',
  /** D51: the operator released the files of a batch's receipts; the records stay. */
  BATCH_FILES_RELEASED: 'BATCH_FILES_RELEASED',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** Append-only: never updated or deleted. */
export interface AuditEntry {
  readonly auditId: string;
  readonly actor: string;
  readonly action: AuditAction;
  /** UTC instant with millisecond precision. */
  readonly at: Date;
  readonly subject: string;
  readonly previousValue?: string;
  readonly newValue?: string;
  readonly note?: string;
}
