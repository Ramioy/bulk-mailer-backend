import type { BulkMailerRepository } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';
import type { SerialExecutor } from '../shared/serial-executor';

export interface AdminDependencies {
  readonly repository: BulkMailerRepository;
  readonly clock: Clock;
  readonly newId: () => string;
  /** The same executor as the batch commands, so a catalog change never interleaves with an upload or a start. */
  readonly serial: SerialExecutor;
  /** Archive copy (bcc) address from the configuration; the copy cannot be enabled without it. */
  readonly archiveCopyAddress?: string;
}
