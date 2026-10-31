import type { BulkMailerRepository } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';
import type { ContractSources } from '../../ports/contract-source';
import type { EmailProvider } from '../../ports/email-provider';
import type { JobQueue } from '../../ports/job-queue';
import type { ReceiptFileStore } from '../../ports/receipt-file-store';
import type { SendLookup } from '../../ports/send-lookup';
import type { SuppressionManager } from '../../ports/suppression-manager';
import type { EmailTemplate } from '../sending/email-template';
import type { SerialExecutor } from '../shared/serial-executor';

/** Reconciliation schedule (§9.4). */
export interface ReconciliationPolicy {
  /** Lookups of an UNCERTAIN send, in minutes after it; NOT_FOUND_AT_PROVIDER only after the last one. Default 5, 15, 60. */
  readonly uncertainDelaysMinutes: readonly number[];
  /** A SENT receipt without delivery events is looked up after this many hours (N)… */
  readonly sweepAfterHours: number;
  /** …and up to this many hours. Default 72. */
  readonly sweepMaxHours: number;
  /** The sends of a running execution are checked every minute while it runs and this many minutes after (D21). */
  readonly recentCheckTailMinutes: number;
  /** At most this many sends are looked up per per-minute check, those checked longest ago first (D38). Default 20. */
  readonly recentCheckBatchSize: number;
  /** A send whose lookup found the logs API unavailable is skipped for this many checks (D38). Default 2. */
  readonly recentCheckBackoffCycles: number;
  /** At most this many lookups per hourly sweep, the oldest sends first (D44). Default 50. */
  readonly sweepBatchSize: number;
}

export const DEFAULT_RECONCILIATION_POLICY: ReconciliationPolicy = {
  uncertainDelaysMinutes: [5, 15, 60],
  sweepAfterHours: 6,
  sweepMaxHours: 72,
  recentCheckTailMinutes: 30,
  recentCheckBatchSize: 20,
  recentCheckBackoffCycles: 2,
  sweepBatchSize: 50,
};

export interface DeliveryDependencies {
  readonly repository: BulkMailerRepository;
  readonly jobQueue: JobQueue;
  readonly sendLookup: SendLookup;
  readonly suppressionManager: SuppressionManager;
  readonly fileStore: ReceiptFileStore;
  readonly contractSources: ContractSources;
  readonly emailProvider: EmailProvider;
  readonly clock: Clock;
  readonly newId: () => string;
  /**
   * The same executor as the batch commands: every change to receipts runs through it in short sections, so the
   * delivery lane, the HTTP commands and the running execution never overwrite each other (D21).
   */
  readonly serial: SerialExecutor;
  readonly reconciliation: ReconciliationPolicy;
  readonly emailTemplate: EmailTemplate;
  /** Archive copy (bcc) address; required only while the archive copy is enabled. */
  readonly archiveCopyAddress?: string;
}
