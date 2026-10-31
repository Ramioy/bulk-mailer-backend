import type { Sha256 } from '../receipt/sha256';
import type { SendOutcomeKind } from './send-outcome';

/** Each send call of a receipt. Recorded before calling the provider; `attemptId` travels as `client_reference`. */
export interface Attempt {
  readonly attemptId: string;
  readonly sha256: Sha256;
  /** Absent for a manual Resend. */
  readonly executionId?: string;
  readonly kind: 'BATCH' | 'RESEND';
  readonly to: string;
  readonly copyAddress?: string;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly outcome?: SendOutcomeKind;
  readonly detail?: string;
  readonly providerRequestId?: string;
  readonly emailReference?: string;
}
