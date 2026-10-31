/** Why a file cannot be sent (receipt `INVALID`). */
export const FileErrorType = {
  INVALID_NAME: 'INVALID_NAME',
  UNKNOWN_CONCEPT: 'UNKNOWN_CONCEPT',
  NAME_TOO_LONG: 'NAME_TOO_LONG',
  ATTACHMENT_TOO_LARGE: 'ATTACHMENT_TOO_LARGE',
  NOT_A_PDF: 'NOT_A_PDF',
  PDF_ENCRYPTED: 'PDF_ENCRYPTED',
  PDF_ACTIVE_CONTENT: 'PDF_ACTIVE_CONTENT',
  PDF_INCREMENTAL_UPDATE: 'PDF_INCREMENTAL_UPDATE',
  MALICIOUS_FILE: 'MALICIOUS_FILE',
} as const;
export type FileErrorType = (typeof FileErrorType)[keyof typeof FileErrorType];

/** Why a receipt has no usable recipient. */
export const RecipientErrorType = {
  CONTRACT_NOT_FOUND: 'CONTRACT_NOT_FOUND',
  CONTRACT_INACTIVE: 'CONTRACT_INACTIVE',
  CONTRACT_WITHOUT_EMAIL: 'CONTRACT_WITHOUT_EMAIL',
  EMAIL_SUPPRESSED: 'EMAIL_SUPPRESSED',
  /** The contract source could not be queried. */
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
} as const;
export type RecipientErrorType = (typeof RecipientErrorType)[keyof typeof RecipientErrorType];

/** Why an attempt ended `FAILED` (in addition to the recipient errors). */
export const SendErrorType = {
  RECIPIENT_CHANGED: 'RECIPIENT_CHANGED',
  FILE_MODIFIED: 'FILE_MODIFIED',
  FILE_NOT_AVAILABLE: 'FILE_NOT_AVAILABLE',
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  NOT_FOUND_AT_PROVIDER: 'NOT_FOUND_AT_PROVIDER',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type SendErrorType = (typeof SendErrorType)[keyof typeof SendErrorType];

export type ReceiptErrorType = FileErrorType | RecipientErrorType | SendErrorType;

/** Why a batch execution ended `STOPPED`. */
export const BatchStopReason = {
  PROVIDER_ACCOUNT: 'PROVIDER_ACCOUNT',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INTERRUPTED: 'INTERRUPTED',
} as const;
export type BatchStopReason = (typeof BatchStopReason)[keyof typeof BatchStopReason];
