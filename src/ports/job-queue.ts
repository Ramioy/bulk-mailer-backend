export const JobType = {
  EXECUTE_BATCH: 'EXECUTE_BATCH',
  RECONCILE_ATTEMPT: 'RECONCILE_ATTEMPT',
  SWEEP_UNCONFIRMED: 'SWEEP_UNCONFIRMED',
  PROCESS_DELIVERY_EVENT: 'PROCESS_DELIVERY_EVENT',
  /** Every minute while a batch runs and shortly after (D21). */
  CHECK_RECENT_SENDS: 'CHECK_RECENT_SENDS',
} as const;
export type JobType = (typeof JobType)[keyof typeof JobType];

export interface NewJob {
  readonly type: JobType;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Not claimable before this instant. Default: now. */
  readonly runAt?: Date;
}

export interface Job extends NewJob {
  readonly jobId: string;
  readonly runAt: Date;
  readonly attempts: number;
}

/**
 * Background work with recovery after crashes. A claimed job that is neither completed nor failed
 * becomes claimable again after a restart. Jobs are not retried automatically after `fail`.
 */
export interface JobQueue {
  enqueue(job: NewJob): Promise<string>;
  /** Claims the oldest due job (of these types, when given), or `undefined` when none is due. */
  claimNext(now: Date, types?: readonly JobType[]): Promise<Job | undefined>;
  complete(jobId: string): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  /** A job of this type is waiting or running (READY or CLAIMED): periodic work is not queued twice (D38). */
  hasPending(type: JobType): Promise<boolean>;
  /** Called at startup: releases jobs claimed by a process that died. */
  releaseAbandoned(): Promise<number>;
}
