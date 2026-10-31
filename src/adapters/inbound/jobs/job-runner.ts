import type { Clock } from '../../../ports/clock';
import type { Job, JobQueue, JobType } from '../../../ports/job-queue';

/** `signal` is aborted on shutdown: a long job (a batch execution) stops cooperatively; short ones may ignore it (D33). */
export type JobHandler = (job: Job, signal: AbortSignal) => Promise<void>;

export interface JobRunnerOptions {
  /** Job types of this lane; every handler's type by default. */
  readonly types?: readonly JobType[];
  /** On `stop()`, how long to wait for the job in progress; default 25 s (D33). */
  readonly stopTimeoutMs?: number;
}

const DEFAULT_STOP_TIMEOUT_MS = 25_000;

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
  /** Aborted by `stop()`: the job in progress sees it and no further job is claimed. */
  private controller = new AbortController();
  private readonly types: readonly JobType[];
  private readonly stopTimeoutMs: number;

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: Partial<Record<JobType, JobHandler>>,
    private readonly clock: Clock,
    private readonly pollMs: number,
    private readonly logger: JobRunnerLogger,
    options: JobRunnerOptions = {},
  ) {
    this.types = options.types ?? (Object.keys(handlers) as JobType[]);
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  }

  /** Processes every due job until stopped; returns how many were processed. Tests call it directly. */
  async drain(): Promise<number> {
    let processed = 0;
    while (!this.controller.signal.aborted && (await this.tick())) processed += 1;
    return processed;
  }

  /** Claims and processes one due job; false when there was none. */
  async tick(): Promise<boolean> {
    const job = await this.queue.claimNext(this.clock.now(), this.types);
    if (!job) return false;
    const handler = this.handlers[job.type];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job, this.controller.signal);
      await this.queue.complete(job.jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Job ${job.jobId} (${job.type}) failed: ${message}`);
      await this.queue.fail(job.jobId, message);
    }
    return true;
  }

  start(): void {
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.stopped = false;
    this.schedule();
  }

  /**
   * Asks the job in progress to stop and waits for it, at most `stopTimeoutMs` (D33). Returns false when it did not
   * finish in time: the process goes on shutting down and the recovery at the next start covers what it left.
   */
  async stop(): Promise<boolean> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller.abort();
    if (!this.running) return true;
    let timeout: NodeJS.Timeout | undefined;
    const expired = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), this.stopTimeoutMs);
    });
    const finished = await Promise.race([this.running.then(() => true as const), expired]);
    clearTimeout(timeout);
    if (!finished) this.logger.error(`Job runner: the job in progress did not finish within ${this.stopTimeoutMs} ms of the shutdown; left to the recovery at the next start`);
    return finished;
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

  /** Stops every lane at the same time; false when some job did not finish in time. */
  async stop(): Promise<boolean> {
    return (await Promise.all(this.lanes.map((lane) => lane.stop()))).every(Boolean);
  }
}
