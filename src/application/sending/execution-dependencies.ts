import type { ProviderIncidentPolicy } from '../../domain/sending/incident-policy';
import type { EmailTemplate } from './email-template';
import type { BulkMailerRepository } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';
import type { ContractSources } from '../../ports/contract-source';
import type { EmailProvider } from '../../ports/email-provider';
import type { ProgressNotifier } from '../../ports/progress-notifier';
import type { ReceiptFileStore } from '../../ports/receipt-file-store';
import type { SendLookup } from '../../ports/send-lookup';
import type { SerialExecutor } from '../shared/serial-executor';

export interface ExecutionDependencies {
  readonly repository: BulkMailerRepository;
  readonly fileStore: ReceiptFileStore;
  readonly contractSources: ContractSources;
  readonly emailProvider: EmailProvider;
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
  /** Simulation branch: wait for the delivery result of each accepted send before the next one. Off when absent. */
  readonly deliveryWait?: DeliveryWaitPolicy;
}

export interface DeliveryWaitPolicy {
  /** After this many seconds without a result the send stays UNCONFIRMED and the batch goes on (D21 follows it). */
  readonly maxSeconds: number;
  /** The provider logs are looked up every this many seconds while waiting. */
  readonly lookupEverySeconds: number;
  /** How often the receipt is read while waiting. */
  readonly pollMs: number;
  readonly sendLookup: SendLookup;
}
