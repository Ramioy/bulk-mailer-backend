import { randomUUID } from 'node:crypto';

import type { Job, JobQueue, JobType, NewJob } from '../../../ports/job-queue';

type Status = 'READY' | 'CLAIMED' | 'DONE' | 'FAILED';

interface Entry {
  job: Job;
  status: Status;
  error?: string;
  seq: number;
}

/**
 * The jobs "table". Shared by the queue and the in-memory repository (D40), like the PostgreSQL table both use, so a
 * job queued inside a repository transaction is claimed by the queue and disappears if that transaction fails.
 */
export class InMemoryJobTable {
  readonly entries = new Map<string, Entry>();
  private seq = 0;

  insert(job: NewJob, now: Date): string {
    const jobId = randomUUID();
    this.entries.set(jobId, { job: { ...job, jobId, runAt: job.runAt ?? now, attempts: 0 }, status: 'READY', seq: this.seq++ });
    return jobId;
  }

  /** A copy, for the repository's transaction snapshot. */
  clone(): InMemoryJobTable {
    const copy = new InMemoryJobTable();
    for (const [id, entry] of this.entries) copy.entries.set(id, { ...entry });
    copy.seq = this.seq;
    return copy;
  }
}

export class InMemoryJobQueue implements JobQueue {
  private readonly own = new InMemoryJobTable();

  constructor(
    private readonly now: () => Date = () => new Date(),
    /** The table to use; by default one of its own. Tests share the repository's (`repository.jobTable()`). */
    private readonly table: () => InMemoryJobTable = () => this.own,
  ) {}

  async enqueue(job: NewJob): Promise<string> {
    return this.table().insert(job, this.now());
  }

  async claimNext(now: Date, types?: readonly JobType[]): Promise<Job | undefined> {
    const next = [...this.table().entries.values()]
      .filter((e) => e.status === 'READY' && e.job.runAt.getTime() <= now.getTime() && (!types || types.includes(e.job.type)))
      .sort((a, b) => a.job.runAt.getTime() - b.job.runAt.getTime() || a.seq - b.seq)[0];
    if (!next) return undefined;
    next.status = 'CLAIMED';
    next.job = { ...next.job, attempts: next.job.attempts + 1 };
    return next.job;
  }

  async complete(jobId: string): Promise<void> {
    this.entry(jobId).status = 'DONE';
  }

  async fail(jobId: string, error: string): Promise<void> {
    const entry = this.entry(jobId);
    entry.status = 'FAILED';
    entry.error = error;
  }

  async hasPending(type: JobType): Promise<boolean> {
    return [...this.table().entries.values()].some((e) => e.job.type === type && (e.status === 'READY' || e.status === 'CLAIMED'));
  }

  async releaseAbandoned(): Promise<number> {
    let released = 0;
    for (const entry of this.table().entries.values()) {
      if (entry.status === 'CLAIMED') {
        entry.status = 'READY';
        released += 1;
      }
    }
    return released;
  }

  private entry(jobId: string) {
    const entry = this.table().entries.get(jobId);
    if (!entry) throw new Error(`Unknown job ${jobId}`);
    return entry;
  }
}
