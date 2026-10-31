import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import type { Job, JobQueue, JobType, NewJob } from '../../../ports/job-queue';
import { autocommit, rows, type Queryable, type Row } from './queryable';

const toJob = (r: Row): Job => ({
  jobId: r.job_id as string,
  type: r.type as JobType,
  payload: r.payload as Job['payload'],
  runAt: r.run_at as Date,
  attempts: r.attempts as number,
});

/** Inserts a READY job with the given connection: autocommit for the queue, a transaction's for `tx.jobs` (D40). */
export async function insertJob(db: Queryable, job: NewJob, now: Date = new Date()): Promise<string> {
  const jobId = randomUUID();
  await db.query(`INSERT INTO jobs (job_id, type, payload, run_at, status, updated_at) VALUES ($1, $2, $3, $4, 'READY', $5)`, [
    jobId,
    job.type,
    JSON.stringify(job.payload),
    job.runAt ?? now,
    now,
  ]);
  return jobId;
}

/** Jobs table claimed with `FOR UPDATE SKIP LOCKED`, so concurrent runners never take the same job. */
export class PostgresJobQueue implements JobQueue {
  private readonly db: Queryable;

  constructor(
    dataSource: DataSource,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = autocommit(dataSource);
  }

  async enqueue(job: NewJob): Promise<string> {
    return insertJob(this.db, job, this.now());
  }

  async claimNext(now: Date, types?: readonly JobType[]): Promise<Job | undefined> {
    const claimed = await rows(
      this.db,
      `UPDATE jobs SET status = 'CLAIMED', attempts = attempts + 1, updated_at = $1
       WHERE job_id = (
         SELECT job_id FROM jobs WHERE status = 'READY' AND run_at <= $1 AND ($2::text[] IS NULL OR type = ANY($2))
         ORDER BY run_at, seq LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [now, types ? [...types] : null],
    );
    return claimed[0] && toJob(claimed[0]);
  }

  async complete(jobId: string): Promise<void> {
    await this.finish(jobId, 'DONE', null);
  }

  async fail(jobId: string, error: string): Promise<void> {
    await this.finish(jobId, 'FAILED', error);
  }

  async hasPending(type: JobType): Promise<boolean> {
    const found = await rows(this.db, `SELECT 1 FROM jobs WHERE type = $1 AND status IN ('READY', 'CLAIMED') LIMIT 1`, [type]);
    return found.length > 0;
  }

  async purgeFinished(before: Date): Promise<number> {
    return (await rows(this.db, `DELETE FROM jobs WHERE status IN ('DONE', 'FAILED') AND updated_at < $1 RETURNING job_id`, [before])).length;
  }

  async releaseAbandoned(): Promise<number> {
    const released = await rows(
      this.db,
      `UPDATE jobs SET status = 'READY', updated_at = $1 WHERE status = 'CLAIMED' RETURNING job_id`,
      [this.now()],
    );
    return released.length;
  }

  private async finish(jobId: string, status: 'DONE' | 'FAILED', error: string | null): Promise<void> {
    const updated = await rows(
      this.db,
      `UPDATE jobs SET status = $2, error = $3, updated_at = $4 WHERE job_id = $1 RETURNING job_id`,
      [jobId, status, error, this.now()],
    );
    if (updated.length === 0) throw new Error(`Unknown job ${jobId}`);
  }
}
