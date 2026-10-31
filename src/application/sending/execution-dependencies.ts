import type { ProviderIncidentPolicy } from '../../domain/sending/incident-policy';
import type { EmailTemplate } from './email-template';
import type { BulkMailerRepository } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';
import type { ContractSources } from '../../ports/contract-source';
import type { EmailProvider } from '../../ports/email-provider';
import type { JobQueue } from '../../ports/job-queue';
import type { ProgressNotifier } from '../../ports/progress-notifier';
import type { ReceiptFileStore } from '../../ports/receipt-file-store';
import type { SerialExecutor } from '../shared/serial-executor';

export interface ExecutionDependencies {
  readonly repository: BulkMailerRepository;
  readonly fileStore: ReceiptFileStore;
  readonly contractSources: ContractSources;
  readonly emailProvider: EmailProvider;
  readonly jobQueue: JobQueue;
  readonly progress: ProgressNotifier;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly serial: SerialExecutor;
  readonly timeZone: string;
  /** Pause between two sends. */
  readonly pauseBetweenSendsMs: number;
  readonly incidentPolicy: ProviderIncidentPolicy;
  readonly emailTemplate: EmailTemplate;
  /** The operator may abort a running execution only after this long without progress, unless forced (D32). */
  readonly abortAfterMinutes: number;
  /** Archive copy (bcc) address; required only while the archive copy is enabled. */
  readonly archiveCopyAddress?: string;
}
