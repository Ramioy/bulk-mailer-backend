import type { BulkMailerRepository } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';
import type { JobQueue } from '../../ports/job-queue';
import type { ReceiptFileStore } from '../../ports/receipt-file-store';
import type { SerialExecutor } from '../shared/serial-executor';

export interface FileDependencies {
  readonly repository: BulkMailerRepository;
  readonly fileStore: ReceiptFileStore;
  readonly jobQueue: JobQueue;
  readonly clock: Clock;
  readonly newId: () => string;
  /** The same executor as the batch commands: a deletion re-checks the receipt where an upload decides (D41). */
  readonly serial: SerialExecutor;
  /** The orphan sweep leaves alone files younger than this, so it never races an upload (D41). Default 60. */
  readonly orphanMinAgeMinutes: number;
}
