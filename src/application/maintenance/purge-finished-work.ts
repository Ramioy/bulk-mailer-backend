import type { BulkMailerRepository } from '../../ports/bulk-mailer-repository';
import type { Clock } from '../../ports/clock';
import type { JobQueue } from '../../ports/job-queue';

export interface PurgeFinishedWorkDependencies {
  readonly repository: BulkMailerRepository;
  readonly jobQueue: JobQueue;
  readonly clock: Clock;
  /** Finished work older than this many days is deleted (D50). Default 30. */
  readonly retentionDays: number;
}

/**
 * D50: the job table and the outbox are working storage, not business records: finished jobs (DONE, FAILED) and
 * dispatched events older than the retention are deleted daily. Pending and dead events, receipts, attempts, audit,
 * alerts, delivery events and webhooks are permanent and untouched.
 */
export class PurgeFinishedWork {
  constructor(private readonly deps: PurgeFinishedWorkDependencies) {}

  /** Queues it unless one is already waiting or running (as D38). */
  async request(): Promise<boolean> {
    if (await this.deps.jobQueue.hasPending('PURGE_FINISHED_WORK')) return false;
    await this.deps.jobQueue.enqueue({ type: 'PURGE_FINISHED_WORK', payload: {} });
    return true;
  }

  async execute(): Promise<{ jobs: number; events: number }> {
    const before = new Date(this.deps.clock.now().getTime() - this.deps.retentionDays * 86_400_000);
    const jobs = await this.deps.jobQueue.purgeFinished(before);
    const events = await this.deps.repository.outbox.purgeDispatched(before);
    return { jobs, events };
  }
}
