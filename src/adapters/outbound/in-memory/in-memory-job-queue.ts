import { randomUUID } from 'node:crypto';

import type { Job, JobQueue, JobType, NewJob } from '../../../ports/job-queue';

type Status = 'READY' | 'CLAIMED' | 'DONE' | 'FAILED';

export class InMemoryJobQueue implements JobQueue {
  private readonly jobs = new Map<string, { job: Job; status: Status; error?: string; seq: number }>();
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async enqueue(job: NewJob): Promise<string> {
    const jobId = randomUUID();
    this.jobs.set(jobId, { job: { ...job, jobId, runAt: job.runAt ?? this.now(), attempts: 0 }, status: 'READY', seq: this.seq++ });
    return jobId;
  }

  async claimNext(now: Date, types?: readonly JobType[]): Promise<Job | undefined> {
    const next = [...this.jobs.values()]
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
    return [...this.jobs.values()].some((e) => e.job.type === type && (e.status === 'READY' || e.status === 'CLAIMED'));
  }

  async releaseAbandoned(): Promise<number> {
    let released = 0;
    for (const entry of this.jobs.values()) {
      if (entry.status === 'CLAIMED') {
        entry.status = 'READY';
        released += 1;
      }
    }
    return released;
  }

  private entry(jobId: string) {
    const entry = this.jobs.get(jobId);
    if (!entry) throw new Error(`Unknown job ${jobId}`);
    return entry;
  }
}
