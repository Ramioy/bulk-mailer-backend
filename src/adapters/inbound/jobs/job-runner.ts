import type { Clock } from '../../../ports/clock';
import type { Job, JobQueue, JobType } from '../../../ports/job-queue';

export type JobHandler = (job: Job) => Promise<void>;

export interface JobRunnerLogger {
  error(message: string): void;
}

/**
 * Inbound adapter that takes jobs of its lane from the queue and hands them to use cases, one at a time.
 * A job that throws is marked failed and is not retried automatically.
 */
export class JobRunner {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: Partial<Record<JobType, JobHandler>>,
    private readonly clock: Clock,
    private readonly pollMs: number,
    private readonly logger: JobRunnerLogger,
    /** Job types of this lane; every handler's type by default. */
    private readonly types: readonly JobType[] = Object.keys(handlers) as JobType[],
  ) {}

  /** Processes every due job; returns how many were processed. Tests call it directly. */
  async drain(): Promise<number> {
    let processed = 0;
    while (await this.tick()) processed += 1;
    return processed;
  }

  /** Claims and processes one due job; false when there was none. */
  async tick(): Promise<boolean> {
    const job = await this.queue.claimNext(this.clock.now(), this.types);
    if (!job) return false;
    const handler = this.handlers[job.type];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job);
      await this.queue.complete(job.jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Job ${job.jobId} (${job.type}) failed: ${message}`);
      await this.queue.fail(job.jobId, message);
    }
    return true;
  }

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.drain()
        .then(() => undefined)
        .catch((error: unknown) => this.logger.error(`Job runner: ${String(error)}`))
        .finally(() => this.schedule());
    }, this.pollMs);
  }
}

/**
 * The background lanes (D21): `execution` runs one batch at a time in the whole system (C5); `delivery` runs
 * webhooks, reconciliation, sweeps and checks one at a time, in parallel to the batch, so they do not wait for it.
 */
export class JobLanes {
  constructor(readonly lanes: readonly JobRunner[]) {}

  /** Processes every due job of every lane until all are idle; returns how many were processed. Tests call it. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      let round = 0;
      for (const lane of this.lanes) round += await lane.drain();
      total += round;
      if (round === 0) return total;
    }
  }

  start(): void {
    for (const lane of this.lanes) lane.start();
  }

  async stop(): Promise<void> {
    await Promise.all(this.lanes.map((lane) => lane.stop()));
  }
}
